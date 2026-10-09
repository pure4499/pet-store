import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { withOrgScope, pool } from "../db/pool.js";

const SOURCE_KEY = "talkfile-pos";
const SOURCE_NAME = "TalkFile POS";
const DEFAULT_SHEET = "Sheet";

const REQUIRED_HEADERS = [
  "Id", "Name", "Type", "Status", "Breed", "Mixed Breed",
  "Cust First Name", "Cust Last Name", "Size", "Sex", "Color", "Weight",
  "Date of Birth", "DOB Approx", "Temperament", "Vet", "Registration #",
  "Microchip #", "Attributes", "Notes", "Customer's Notes", "Customer Id",
  "Email", "Mobile", "Reminders/Marketing", "Cust Status", "Address",
  "Last Groom", "Last Board", "Last Daycare", "Date Added", "User Added",
  "Date Last Edited", "User Last Edited",
] as const;

type SourceRow = {
  rowNumber: number;
  petExternalId: string;
  customerExternalId: string;
  petName: string;
  species: "dog" | "cat" | "other";
  petStatus: "active" | "inactive" | "deceased" | "transferred";
  breed: string | null;
  isMixedBreed: boolean;
  sizeClass: "toy" | "small" | "medium" | "large" | "giant" | null;
  sex: "male" | "female" | null;
  reproductiveStatus: "intact" | "spayed" | "neutered" | null;
  color: string | null;
  weight: number | null;
  dateOfBirth: string | null;
  dateOfBirthIsApproximate: boolean;
  temperament: string | null;
  veterinarian: string | null;
  registrationNumber: string | null;
  microchipNumber: string | null;
  attributeFlags: PetFlag[];
  internalNotes: string | null;
  customerProvidedNotes: string | null;
  ownerName: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  marketingPreference: boolean;
  householdStatus: "active" | "inactive";
  householdFlags: HouseholdFlag[];
  addressRaw: string | null;
  lastGroom: string | null;
  lastBoard: string | null;
  lastDaycare: string | null;
  sourceCreatedAt: string;
  sourceCreatedBy: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedBy: string | null;
  checksum: string;
};

type PetFlag =
  | "bite_risk"
  | "dog_reactivity"
  | "escape_risk"
  | "muzzle_required"
  | "leash_required_in_kennel"
  | "visual_impairment"
  | "vocal";
type HouseholdFlag = "vip" | "alert";
type IssueEntity = "household" | "owner" | "pet" | "service";
type ImportIssue = {
  rowNumber: number | null;
  entityType: IssueEntity;
  externalId: string | null;
  fieldName: string;
  issueCode: string;
  rawValue: string | null;
};

type ImportPlan = {
  filePath: string;
  fileChecksum: string;
  sheetName: string;
  rows: SourceRow[];
  householdCount: number;
  issues: ImportIssue[];
  fatalIssueCounts: Map<string, number>;
};

type ParsedArgs = {
  filePath: string;
  organizationId: string;
  sourceFileId: string | null;
  sourceFileName: string;
  sheetName: string;
  commit: boolean;
};

type Address = {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: "US";
};

const ATTRIBUTE_MAP: Record<string, PetFlag> = {
  "bites": "bite_risk",
  "barks": "vocal",
  "agreesive to other dog": "dog_reactivity",
  "aggressive to other dog": "dog_reactivity",
  "escaper": "escape_risk",
  "muzzle": "muzzle_required",
  "lead on in cage": "leash_required_in_kennel",
  "blind": "visual_impairment",
};

const US_STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  let commit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--commit") {
      commit = true;
      continue;
    }
    if (!value.startsWith("--") || !argv[index + 1]) {
      throw new Error(`Invalid argument: ${value}`);
    }
    values.set(value.slice(2), argv[index + 1]);
    index += 1;
  }

  const fileValue = values.get("file");
  const organizationId = values.get("organization");
  if (!fileValue || !organizationId) {
    throw new Error(
      "Usage: npm run import:pos -- --file <xlsx> --organization <uuid> " +
      "[--source-file-id <drive-id>] [--source-file-name <name>] [--sheet <name>] [--commit]"
    );
  }
  const filePath = resolve(fileValue);
  return {
    filePath,
    organizationId,
    sourceFileId: values.get("source-file-id") ?? null,
    sourceFileName: values.get("source-file-name") ?? basename(filePath),
    sheetName: values.get("sheet") ?? DEFAULT_SHEET,
    commit,
  };
}

function text(cell: ExcelJS.Cell): string {
  return cell.text.trim();
}

function nullableText(cell: ExcelJS.Cell): string | null {
  const value = text(cell);
  return value || null;
}

function bool(cell: ExcelJS.Cell): boolean {
  if (typeof cell.value === "boolean") return cell.value;
  const value = text(cell).toLowerCase();
  if (value === "true" || value === "yes" || value === "1") return true;
  if (value === "false" || value === "no" || value === "0" || value === "") return false;
  throw new Error(`Unrecognized boolean value: ${value}`);
}

function dateOnly(cell: ExcelJS.Cell): string | null {
  if (!cell.value) return null;
  if (!(cell.value instanceof Date) || Number.isNaN(cell.value.getTime())) {
    throw new Error(`Expected Excel date, received: ${text(cell)}`);
  }
  return cell.value.toISOString().slice(0, 10);
}

function dateTime(cell: ExcelJS.Cell): string | null {
  if (!cell.value) return null;
  if (!(cell.value instanceof Date) || Number.isNaN(cell.value.getTime())) {
    throw new Error(`Expected Excel date/time, received: ${text(cell)}`);
  }
  return cell.value.toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function parseAddress(raw: string): Address | null {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const zipMatch = cleaned.match(/^(.*?)[,\s]+(\d{5}(?:-\d{4})?)$/);
  const postalCode = zipMatch?.[2] ?? null;
  const beforeZip = (zipMatch?.[1] ?? cleaned).replace(/,\s*$/, "").trim();
  let region: string | null = null;
  let beforeRegion = beforeZip;
  const abbreviation = beforeZip.match(/^(.*?)[,\s]+([A-Z]{2})$/i);
  if (abbreviation) {
    region = abbreviation[2].toUpperCase();
    beforeRegion = abbreviation[1].replace(/,\s*$/, "").trim();
  } else {
    const lower = beforeZip.toLowerCase();
    const stateName = Object.keys(US_STATE_CODES)
      .sort((a, b) => b.length - a.length)
      .find((name) => lower.endsWith(` ${name}`) || lower.endsWith(`, ${name}`));
    if (stateName) {
      region = US_STATE_CODES[stateName];
      beforeRegion = beforeZip.slice(0, beforeZip.length - stateName.length).replace(/,\s*$/, "").trim();
    }
  }
  const lastComma = beforeRegion.lastIndexOf(",");
  if (lastComma < 0) return null;
  const prefix = beforeRegion.slice(0, lastComma).trim();
  const city = beforeRegion.slice(lastComma + 1).trim();
  const prefixParts = prefix.split(",").map((part) => part.trim()).filter(Boolean);
  if (!city) return null;
  if (prefixParts.length === 0) return null;
  return {
    line1: prefixParts[0],
    line2: prefixParts.length > 1 ? prefixParts.slice(1).join(", ") : null,
    city,
    region,
    postalCode,
    countryCode: "US",
  };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addFatal(plan: Pick<ImportPlan, "fatalIssueCounts">, code: string): void {
  increment(plan.fatalIssueCounts, code);
}

async function buildPlan(args: ParsedArgs): Promise<ImportPlan> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.filePath);
  const sheet = workbook.getWorksheet(args.sheetName);
  if (!sheet) throw new Error(`Worksheet not found: ${args.sheetName}`);

  const headerIndexes = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => headerIndexes.set(text(cell), columnNumber));
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headerIndexes.has(header));
  if (missingHeaders.length > 0) throw new Error(`Missing required headers: ${missingHeaders.join(", ")}`);

  const column = (row: ExcelJS.Row, header: string): ExcelJS.Cell => row.getCell(headerIndexes.get(header)!);
  const rows: SourceRow[] = [];
  const issues: ImportIssue[] = [];
  const fatalIssueCounts = new Map<string, number>();
  const petIds = new Set<string>();
  const customers = new Map<string, Record<string, string>>();
  const microchips = new Map<string, SourceRow[]>();
  const today = new Date().toISOString().slice(0, 10);

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const petExternalId = text(column(row, "Id"));
    const customerExternalId = text(column(row, "Customer Id"));
    const petName = text(column(row, "Name"));
    if (!petExternalId && !customerExternalId && !petName) continue;
    if (!petExternalId || !customerExternalId || !petName) {
      addFatal({ fatalIssueCounts }, "missing_required_identity");
      continue;
    }
    if (petIds.has(petExternalId)) addFatal({ fatalIssueCounts }, "duplicate_pet_external_id");
    petIds.add(petExternalId);

    const typeValue = text(column(row, "Type")).toLowerCase();
    const species: SourceRow["species"] = typeValue === "dog" || typeValue === "cat" ? typeValue : "other";
    if (species === "other") addFatal({ fatalIssueCounts }, "unknown_species");

    const petStatusValue = text(column(row, "Status")).toLowerCase();
    const petStatusMap: Record<string, SourceRow["petStatus"]> = {
      active: "active",
      inactive: "inactive",
      deceased: "deceased",
      "changed owner - external": "transferred",
    };
    const petStatus = petStatusMap[petStatusValue];
    if (!petStatus) addFatal({ fatalIssueCounts }, "unknown_pet_status");

    const sizeValue = text(column(row, "Size")).toLowerCase();
    const knownSizes = new Set(["toy", "small", "medium", "large", "giant"]);
    const sizeClass = knownSizes.has(sizeValue) ? sizeValue as SourceRow["sizeClass"] : null;
    if (sizeValue && sizeValue !== "cat" && !sizeClass) addFatal({ fatalIssueCounts }, "unknown_size_class");
    if (sizeValue === "cat") {
      issues.push({ rowNumber, entityType: "pet", externalId: petExternalId, fieldName: "Size", issueCode: "non_size_value_ignored", rawValue: text(column(row, "Size")) });
    }

    const sexValue = text(column(row, "Sex")).toLowerCase();
    const sex: SourceRow["sex"] = sexValue.startsWith("male") ? "male" : sexValue.startsWith("female") ? "female" : null;
    const reproductiveStatus: SourceRow["reproductiveStatus"] = sexValue.includes("neutered") ? "neutered"
      : sexValue.includes("spayed") ? "spayed"
      : sexValue.includes("entire") ? "intact"
      : null;
    if (sexValue && !sex) addFatal({ fatalIssueCounts }, "unknown_sex");

    const attributes = nullableText(column(row, "Attributes"));
    const attributeFlags: PetFlag[] = [];
    if (attributes) {
      for (const rawAttribute of attributes.split(",")) {
        const normalized = rawAttribute.trim().toLowerCase();
        const flag = ATTRIBUTE_MAP[normalized];
        if (!flag) {
          addFatal({ fatalIssueCounts }, "unknown_pet_attribute");
        } else if (!attributeFlags.includes(flag)) {
          attributeFlags.push(flag);
        }
      }
    }

    const customerStatus = text(column(row, "Cust Status")).toLowerCase();
    const householdStatus: SourceRow["householdStatus"] = customerStatus === "inactive" ? "inactive" : "active";
    const householdFlags: HouseholdFlag[] = [];
    if (customerStatus === "active - alert") householdFlags.push("alert");
    else if (customerStatus === "active - vip") householdFlags.push("vip");
    else if (customerStatus !== "active" && customerStatus !== "inactive") addFatal({ fatalIssueCounts }, "unknown_customer_status");

    const ownerName = [text(column(row, "Cust First Name")), text(column(row, "Cust Last Name"))]
      .filter(Boolean).join(" ").trim();
    if (!ownerName) addFatal({ fatalIssueCounts }, "missing_owner_name");
    const ownerEmail = nullableText(column(row, "Email"))?.toLowerCase() ?? null;
    const ownerPhone = normalizedPhone(nullableText(column(row, "Mobile")));
    if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) addFatal({ fatalIssueCounts }, "invalid_email");
    if (!ownerEmail && !ownerPhone) {
      issues.push({ rowNumber, entityType: "owner", externalId: customerExternalId, fieldName: "Email/Mobile", issueCode: "missing_contact_method", rawValue: null });
    }

    const customerSignature = {
      ownerName,
      ownerEmail: ownerEmail ?? "",
      ownerPhone: ownerPhone ?? "",
      marketing: String(bool(column(row, "Reminders/Marketing"))),
      status: customerStatus,
      address: text(column(row, "Address")),
    };
    const existingCustomer = customers.get(customerExternalId);
    if (existingCustomer && JSON.stringify(existingCustomer) !== JSON.stringify(customerSignature)) {
      addFatal({ fatalIssueCounts }, "conflicting_customer_rows");
    } else {
      customers.set(customerExternalId, customerSignature);
    }

    const weightText = text(column(row, "Weight"));
    const weight = weightText ? Number(weightText) : null;
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) addFatal({ fatalIssueCounts }, "invalid_weight");
    if (weight && weight > 0) {
      issues.push({ rowNumber, entityType: "pet", externalId: petExternalId, fieldName: "Weight", issueCode: "weight_unit_required", rawValue: String(weight) });
    }

    const addressRaw = nullableText(column(row, "Address"));
    if (addressRaw && !parseAddress(addressRaw)) {
      issues.push({ rowNumber, entityType: "household", externalId: customerExternalId, fieldName: "Address", issueCode: "address_parse_required", rawValue: addressRaw });
    }

    const lastGroom = dateOnly(column(row, "Last Groom"));
    const lastBoard = dateOnly(column(row, "Last Board"));
    const lastDaycare = dateOnly(column(row, "Last Daycare"));
    for (const [fieldName, value] of [["Last Groom", lastGroom], ["Last Board", lastBoard], ["Last Daycare", lastDaycare]] as const) {
      if (value && value > today) {
        issues.push({ rowNumber, entityType: "service", externalId: petExternalId, fieldName, issueCode: "future_service_date", rawValue: value });
      }
    }

    const sourceCreatedAt = dateTime(column(row, "Date Added"));
    if (!sourceCreatedAt) addFatal({ fatalIssueCounts }, "missing_source_created_at");

    const rowData = {
      rowNumber,
      petExternalId,
      customerExternalId,
      petName,
      species,
      petStatus: petStatus ?? "inactive",
      breed: nullableText(column(row, "Breed")),
      isMixedBreed: bool(column(row, "Mixed Breed")),
      sizeClass,
      sex,
      reproductiveStatus,
      color: nullableText(column(row, "Color")),
      weight,
      dateOfBirth: dateOnly(column(row, "Date of Birth")),
      dateOfBirthIsApproximate: bool(column(row, "DOB Approx")),
      temperament: nullableText(column(row, "Temperament")),
      veterinarian: nullableText(column(row, "Vet")),
      registrationNumber: nullableText(column(row, "Registration #")),
      microchipNumber: nullableText(column(row, "Microchip #")),
      attributeFlags,
      internalNotes: nullableText(column(row, "Notes")),
      customerProvidedNotes: nullableText(column(row, "Customer's Notes")),
      ownerName,
      ownerEmail,
      ownerPhone,
      marketingPreference: bool(column(row, "Reminders/Marketing")),
      householdStatus,
      householdFlags,
      addressRaw,
      lastGroom,
      lastBoard,
      lastDaycare,
      sourceCreatedAt: sourceCreatedAt ?? new Date(0).toISOString(),
      sourceCreatedBy: nullableText(column(row, "User Added")),
      sourceUpdatedAt: dateTime(column(row, "Date Last Edited")),
      sourceUpdatedBy: nullableText(column(row, "User Last Edited")),
    };
    const sourceRow: SourceRow = { ...rowData, checksum: hash(rowData) };
    rows.push(sourceRow);
    if (sourceRow.microchipNumber) {
      const normalized = sourceRow.microchipNumber.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const matches = microchips.get(normalized) ?? [];
      matches.push(sourceRow);
      microchips.set(normalized, matches);
    }
  }

  for (const duplicateRows of microchips.values()) {
    if (duplicateRows.length < 2) continue;
    for (const row of duplicateRows) {
      issues.push({ rowNumber: row.rowNumber, entityType: "pet", externalId: row.petExternalId, fieldName: "Microchip #", issueCode: "duplicate_microchip_review", rawValue: row.microchipNumber });
    }
  }

  const fileChecksum = createHash("sha256").update(await readFile(args.filePath)).digest("hex");
  return {
    filePath: args.filePath,
    fileChecksum,
    sheetName: args.sheetName,
    rows,
    householdCount: customers.size,
    issues: deduplicateIssues(issues),
    fatalIssueCounts,
  };
}

function deduplicateIssues(issues: ImportIssue[]): ImportIssue[] {
  const result = new Map<string, ImportIssue>();
  for (const issue of issues) {
    const key = [issue.entityType, issue.externalId, issue.fieldName, issue.issueCode, issue.rawValue].join("|");
    if (!result.has(key)) result.set(key, issue);
  }
  return [...result.values()];
}

function issueCounts(issues: ImportIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.issueCode] = (counts[issue.issueCode] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function confirmOrganization(organizationId: string): Promise<string> {
  return withOrgScope(organizationId, async (client) => {
    const result = await client.query<{ name: string }>(
      "SELECT name FROM organizations WHERE id = $1",
      [organizationId]
    );
    if (!result.rows[0]) throw new Error("Target organization does not exist");
    return result.rows[0].name;
  });
}

async function lookupMapping(
  client: PoolClient,
  table: "household_external_ids" | "owner_external_ids" | "pet_external_ids",
  idColumn: "household_id" | "owner_id" | "pet_id",
  organizationId: string,
  externalSourceId: string,
  externalId: string
): Promise<string | null> {
  const result = await client.query(
    `SELECT ${idColumn} AS id FROM ${table}
     WHERE organization_id = $1 AND external_source_id = $2 AND external_id = $3`,
    [organizationId, externalSourceId, externalId]
  );
  return result.rows[0]?.id ?? null;
}

async function importPlan(args: ParsedArgs, plan: ImportPlan): Promise<{ batchId: string; counts: Record<string, number> }> {
  const today = new Date().toISOString().slice(0, 10);
  return withOrgScope(args.organizationId, async (client) => {
    const source = await client.query<{ id: string }>(
      `INSERT INTO external_sources (organization_id, source_key, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, source_key)
       DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING id`,
      [args.organizationId, SOURCE_KEY, SOURCE_NAME]
    );
    const externalSourceId = source.rows[0].id;
    const validationSummary = {
      fileChecksum: plan.fileChecksum,
      rows: plan.rows.length,
      households: plan.householdCount,
      heldIssues: issueCounts(plan.issues),
      fatalIssues: Object.fromEntries(plan.fatalIssueCounts),
    };
    const batch = await client.query<{ id: string }>(
      `INSERT INTO data_import_batches (
         organization_id, external_source_id, source_file_id, source_file_name,
         source_sheet_name, source_row_count, status, validation_summary, started_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'importing', $7, now())
       RETURNING id`,
      [args.organizationId, externalSourceId, args.sourceFileId, args.sourceFileName, plan.sheetName, plan.rows.length, validationSummary]
    );
    const batchId = batch.rows[0].id;
    const counts: Record<string, number> = {
      householdsCreated: 0,
      householdsUpdated: 0,
      ownersCreated: 0,
      ownersUpdated: 0,
      petsCreated: 0,
      petsUpdated: 0,
      addressesImported: 0,
      identifiersImported: 0,
      providerLinksImported: 0,
      serviceMilestonesImported: 0,
      petNotesImported: 0,
      issuesHeld: plan.issues.length,
    };
    const processedCustomers = new Set<string>();

    for (const row of plan.rows) {
      let householdId = await lookupMapping(client, "household_external_ids", "household_id", args.organizationId, externalSourceId, row.customerExternalId);
      let ownerId = await lookupMapping(client, "owner_external_ids", "owner_id", args.organizationId, externalSourceId, row.customerExternalId);

      if (!processedCustomers.has(row.customerExternalId)) {
        if (!householdId) {
          const created = await client.query<{ id: string }>(
            "INSERT INTO households (organization_id, status) VALUES ($1, $2) RETURNING id",
            [args.organizationId, row.householdStatus]
          );
          householdId = created.rows[0].id;
          counts.householdsCreated += 1;
          await client.query(
            `INSERT INTO household_external_ids (
               organization_id, household_id, import_batch_id, external_source_id,
               external_id, source_row_number, source_checksum
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [args.organizationId, householdId, batchId, externalSourceId, row.customerExternalId, row.rowNumber, hash({ customer: row.customerExternalId, owner: row.ownerName })]
          );
        } else {
          await client.query("UPDATE households SET status = $1, updated_at = now() WHERE organization_id = $2 AND id = $3", [row.householdStatus, args.organizationId, householdId]);
          await client.query(
            `UPDATE household_external_ids SET import_batch_id = $1, source_row_number = $2, source_checksum = $3
             WHERE organization_id = $4 AND external_source_id = $5 AND external_id = $6`,
            [batchId, row.rowNumber, hash({ customer: row.customerExternalId, owner: row.ownerName }), args.organizationId, externalSourceId, row.customerExternalId]
          );
          counts.householdsUpdated += 1;
        }

        if (!ownerId) {
          const created = await client.query<{ id: string }>(
            `INSERT INTO owners (organization_id, household_id, full_name, phone, email, notes)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [args.organizationId, householdId, row.ownerName, row.ownerPhone, row.ownerEmail, null]
          );
          ownerId = created.rows[0].id;
          counts.ownersCreated += 1;
          await client.query(
            `INSERT INTO owner_external_ids (
               organization_id, owner_id, import_batch_id, external_source_id,
               external_id, source_row_number, source_checksum
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [args.organizationId, ownerId, batchId, externalSourceId, row.customerExternalId, row.rowNumber, hash({ name: row.ownerName, email: row.ownerEmail, phone: row.ownerPhone })]
          );
        } else {
          await client.query(
            `UPDATE owners SET household_id = $1, full_name = $2, phone = $3, email = $4,
               updated_at = now()
             WHERE organization_id = $5 AND id = $6`,
            [householdId, row.ownerName, row.ownerPhone, row.ownerEmail, args.organizationId, ownerId]
          );
          await client.query(
            `UPDATE owner_external_ids SET import_batch_id = $1, source_row_number = $2, source_checksum = $3
             WHERE organization_id = $4 AND external_source_id = $5 AND external_id = $6`,
            [batchId, row.rowNumber, hash({ name: row.ownerName, email: row.ownerEmail, phone: row.ownerPhone }), args.organizationId, externalSourceId, row.customerExternalId]
          );
          counts.ownersUpdated += 1;
        }

        await syncHouseholdFlags(client, args.organizationId, householdId, externalSourceId, batchId, row.householdFlags);
        await client.query(
          `INSERT INTO owner_communication_preferences (
             organization_id, owner_id, purpose, channel, preference_status,
             external_source_id, import_batch_id
           ) VALUES ($1, $2, 'service_reminders_and_marketing', 'all', $3, $4, $5)
           ON CONFLICT (organization_id, owner_id, purpose, channel)
           DO UPDATE SET preference_status = EXCLUDED.preference_status,
             external_source_id = EXCLUDED.external_source_id,
             import_batch_id = EXCLUDED.import_batch_id,
             updated_at = now()`,
          [args.organizationId, ownerId, row.marketingPreference ? "opted_in" : "opted_out", externalSourceId, batchId]
        );

        if (row.addressRaw) {
          const address = parseAddress(row.addressRaw);
          if (address) {
            await client.query(
              `INSERT INTO household_addresses (
                 organization_id, household_id, address_type, line1, line2, city,
                 region, postal_code, country_code, is_primary,
                 external_source_id, import_batch_id
               ) VALUES ($1, $2, 'home', $3, $4, $5, $6, $7, $8, true, $9, $10)
               ON CONFLICT (organization_id, household_id, external_source_id)
                 WHERE external_source_id IS NOT NULL
               DO UPDATE SET line1 = EXCLUDED.line1, line2 = EXCLUDED.line2,
                 city = EXCLUDED.city, region = EXCLUDED.region,
                 postal_code = EXCLUDED.postal_code, country_code = EXCLUDED.country_code,
                 import_batch_id = EXCLUDED.import_batch_id, updated_at = now()`,
              [args.organizationId, householdId, address.line1, address.line2, address.city, address.region, address.postalCode, address.countryCode, externalSourceId, batchId]
            );
            counts.addressesImported += 1;
          }
        }
        processedCustomers.add(row.customerExternalId);
      }

      if (!householdId || !ownerId) throw new Error("Customer mapping was not established");
      let petId = await lookupMapping(client, "pet_external_ids", "pet_id", args.organizationId, externalSourceId, row.petExternalId);
      const petValues = [
        ownerId, row.petName, row.species, row.breed, row.dateOfBirth, row.sex,
        row.color, row.petStatus, row.isMixedBreed, row.sizeClass,
        row.reproductiveStatus, row.dateOfBirthIsApproximate, row.temperament,
      ];
      if (!petId) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO pets (
             organization_id, owner_id, name, species, breed, date_of_birth, sex,
             color_markings, status, is_mixed_breed, size_class,
             reproductive_status, date_of_birth_is_approximate, temperament
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [args.organizationId, ...petValues]
        );
        petId = created.rows[0].id;
        counts.petsCreated += 1;
        await client.query(
          `INSERT INTO pet_external_ids (
             organization_id, pet_id, import_batch_id, external_source_id, external_id,
             source_row_number, source_created_at, source_updated_at,
             source_created_by, source_updated_by, source_checksum
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [args.organizationId, petId, batchId, externalSourceId, row.petExternalId,
            row.rowNumber, row.sourceCreatedAt, row.sourceUpdatedAt,
            row.sourceCreatedBy, row.sourceUpdatedBy, row.checksum]
        );
      } else {
        await client.query(
          `UPDATE pets SET owner_id = $1, name = $2, species = $3, breed = $4,
             date_of_birth = $5, sex = $6, color_markings = $7, status = $8,
             is_mixed_breed = $9, size_class = $10, reproductive_status = $11,
             date_of_birth_is_approximate = $12, temperament = $13,
             updated_at = now()
           WHERE organization_id = $14 AND id = $15`,
          [...petValues, args.organizationId, petId]
        );
        await client.query(
          `UPDATE pet_external_ids SET import_batch_id = $1, source_row_number = $2,
             source_created_at = $3, source_updated_at = $4, source_created_by = $5,
             source_updated_by = $6, source_checksum = $7
           WHERE organization_id = $8 AND external_source_id = $9 AND external_id = $10`,
          [batchId, row.rowNumber, row.sourceCreatedAt, row.sourceUpdatedAt,
            row.sourceCreatedBy, row.sourceUpdatedBy, row.checksum,
            args.organizationId, externalSourceId, row.petExternalId]
        );
        counts.petsUpdated += 1;
      }

      await syncPetFlags(client, args.organizationId, petId, externalSourceId, batchId, row.attributeFlags);
      counts.petNotesImported += await syncPetNotes(client, args.organizationId, petId, externalSourceId, batchId, row);
      counts.identifiersImported += await syncIdentifiers(client, args.organizationId, petId, externalSourceId, batchId, row);
      await syncVeterinarian(client, args.organizationId, petId, externalSourceId, batchId, row.veterinarian);
      if (row.veterinarian) counts.providerLinksImported += 1;
      counts.serviceMilestonesImported += await syncMilestones(client, args.organizationId, petId, externalSourceId, batchId, row, today);
    }

    for (const issue of plan.issues) {
      await client.query(
        `INSERT INTO data_import_issues (
           organization_id, import_batch_id, source_row_number, entity_type,
           external_id, field_name, issue_code, raw_value
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [args.organizationId, batchId, issue.rowNumber, issue.entityType,
          issue.externalId, issue.fieldName, issue.issueCode, issue.rawValue]
      );
    }

    await client.query(
      `UPDATE data_import_batches
       SET status = 'completed', validation_summary = $1, completed_at = now(), updated_at = now()
       WHERE organization_id = $2 AND id = $3`,
      [{ ...validationSummary, imported: counts }, args.organizationId, batchId]
    );
    return { batchId, counts };
  });
}

async function syncHouseholdFlags(client: PoolClient, organizationId: string, householdId: string, sourceId: string, batchId: string, flags: HouseholdFlag[]): Promise<void> {
  await client.query(
    `UPDATE household_flags SET active = false, ended_at = now()
     WHERE organization_id = $1 AND household_id = $2 AND external_source_id = $3
       AND active AND NOT (flag_type = ANY($4::text[]))`,
    [organizationId, householdId, sourceId, flags]
  );
  for (const flag of flags) {
    await client.query(
      `INSERT INTO household_flags (
         organization_id, household_id, flag_type, external_source_id, import_batch_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, household_id, flag_type) WHERE active
       DO UPDATE SET external_source_id = EXCLUDED.external_source_id,
         import_batch_id = EXCLUDED.import_batch_id`,
      [organizationId, householdId, flag, sourceId, batchId]
    );
  }
}

async function syncPetFlags(client: PoolClient, organizationId: string, petId: string, sourceId: string, batchId: string, flags: PetFlag[]): Promise<void> {
  await client.query(
    `UPDATE pet_flags SET active = false, ended_at = now()
     WHERE organization_id = $1 AND pet_id = $2 AND external_source_id = $3
       AND active AND NOT (flag_type = ANY($4::text[]))`,
    [organizationId, petId, sourceId, flags]
  );
  for (const flag of flags) {
    await client.query(
      `INSERT INTO pet_flags (
         organization_id, pet_id, flag_type, external_source_id, import_batch_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, pet_id, flag_type) WHERE active
       DO UPDATE SET external_source_id = EXCLUDED.external_source_id,
         import_batch_id = EXCLUDED.import_batch_id`,
      [organizationId, petId, flag, sourceId, batchId]
    );
  }
}

async function syncIdentifiers(client: PoolClient, organizationId: string, petId: string, sourceId: string, batchId: string, row: SourceRow): Promise<number> {
  let count = 0;
  for (const [type, value] of [["microchip", row.microchipNumber], ["registration", row.registrationNumber]] as const) {
    await client.query(
      `DELETE FROM pet_identifiers
       WHERE organization_id = $1 AND pet_id = $2 AND external_source_id = $3 AND identifier_type = $4`,
      [organizationId, petId, sourceId, type]
    );
    if (value) {
      await client.query(
        `INSERT INTO pet_identifiers (
           organization_id, pet_id, identifier_type, identifier_value,
           external_source_id, import_batch_id
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [organizationId, petId, type, value, sourceId, batchId]
      );
      count += 1;
    }
  }
  return count;
}

async function syncPetNotes(client: PoolClient, organizationId: string, petId: string, sourceId: string, batchId: string, row: SourceRow): Promise<number> {
  let count = 0;
  for (const [noteType, body] of [["internal", row.internalNotes], ["customer_provided", row.customerProvidedNotes]] as const) {
    if (!body) {
      await client.query(
        `DELETE FROM pet_notes
         WHERE organization_id = $1 AND pet_id = $2 AND external_source_id = $3 AND note_type = $4`,
        [organizationId, petId, sourceId, noteType]
      );
      continue;
    }
    await client.query(
      `INSERT INTO pet_notes (
         organization_id, pet_id, note_type, body, external_source_id, import_batch_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, pet_id, external_source_id, note_type)
         WHERE external_source_id IS NOT NULL
       DO UPDATE SET body = EXCLUDED.body, import_batch_id = EXCLUDED.import_batch_id,
         updated_at = now()`,
      [organizationId, petId, noteType, body, sourceId, batchId]
    );
    count += 1;
  }
  return count;
}

async function syncVeterinarian(client: PoolClient, organizationId: string, petId: string, sourceId: string, batchId: string, veterinarian: string | null): Promise<void> {
  await client.query(
    `DELETE FROM pet_care_providers
     WHERE organization_id = $1 AND pet_id = $2 AND external_source_id = $3`,
    [organizationId, petId, sourceId]
  );
  if (!veterinarian) return;
  let provider = await client.query<{ id: string }>(
    `SELECT id FROM care_providers
     WHERE organization_id = $1 AND provider_type = 'veterinarian' AND lower(name) = lower($2)
     ORDER BY created_at LIMIT 1`,
    [organizationId, veterinarian]
  );
  if (!provider.rows[0]) {
    provider = await client.query<{ id: string }>(
      `INSERT INTO care_providers (organization_id, provider_type, name)
       VALUES ($1, 'veterinarian', $2) RETURNING id`,
      [organizationId, veterinarian]
    );
  }
  await client.query(
    `INSERT INTO pet_care_providers (
       organization_id, pet_id, care_provider_id, relationship,
       external_source_id, import_batch_id
     ) VALUES ($1, $2, $3, 'primary', $4, $5)
     ON CONFLICT (organization_id, pet_id, care_provider_id)
     DO UPDATE SET relationship = EXCLUDED.relationship,
       external_source_id = EXCLUDED.external_source_id,
       import_batch_id = EXCLUDED.import_batch_id`,
    [organizationId, petId, provider.rows[0].id, sourceId, batchId]
  );
}

async function syncMilestones(client: PoolClient, organizationId: string, petId: string, sourceId: string, batchId: string, row: SourceRow, today: string): Promise<number> {
  let count = 0;
  for (const [serviceType, occurredOn] of [["grooming", row.lastGroom], ["boarding", row.lastBoard], ["daycare", row.lastDaycare]] as const) {
    await client.query(
      `DELETE FROM pet_service_milestones
       WHERE organization_id = $1 AND pet_id = $2 AND external_source_id = $3 AND service_type = $4`,
      [organizationId, petId, sourceId, serviceType]
    );
    if (!occurredOn || occurredOn > today) continue;
    await client.query(
      `INSERT INTO pet_service_milestones (
         organization_id, pet_id, import_batch_id, external_source_id,
         service_type, occurred_on
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, pet_id, service_type, occurred_on, external_source_id)
       DO UPDATE SET import_batch_id = EXCLUDED.import_batch_id`,
      [organizationId, petId, batchId, sourceId, serviceType, occurredOn]
    );
    count += 1;
  }
  return count;
}

function printPlan(organizationName: string, plan: ImportPlan, commit: boolean): void {
  console.log(JSON.stringify({
    mode: commit ? "commit" : "dry-run",
    targetOrganization: organizationName,
    sourceFile: basename(plan.filePath),
    sourceSha256: plan.fileChecksum,
    sheet: plan.sheetName,
    sourceRows: plan.rows.length,
    uniqueHouseholds: plan.householdCount,
    heldIssueCounts: issueCounts(plan.issues),
    fatalIssueCounts: Object.fromEntries(plan.fatalIssueCounts),
  }, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const organizationName = await confirmOrganization(args.organizationId);
  const plan = await buildPlan(args);
  printPlan(organizationName, plan, args.commit);
  if (plan.fatalIssueCounts.size > 0) {
    throw new Error("Import blocked by fatal validation issues; no data was written");
  }
  if (!args.commit) {
    console.log("Dry run complete. Re-run with --commit to import in one transaction.");
    return;
  }
  const result = await importPlan(args, plan);
  console.log(JSON.stringify({ status: "completed", batchId: result.batchId, imported: result.counts }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
