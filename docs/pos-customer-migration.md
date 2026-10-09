# POS customer migration readiness

This document maps the read-only POS export `TalkFile_Pets.xlsx.xlsx` to Tail
Tells. The reviewed workbook is the Google Drive file with ID
`1vVQGMOCwq49De-oU5XDnnpL-Rcxa2ss8`, sheet `Sheet` (sheet ID
`1825264714`). The source
file remains read-only. A checksum-verified copy was imported into the local
`Test Pet Hotel` organization on September 25, 2026 and into the staging
`UCBarkley Test Facility` organization on September 27, 2026. Production was
not changed.

## Source profile

The export contains 1,545 pet rows and 1,251 unique customer IDs. Customer data
is repeated on every pet row, but the repeated name, email, mobile, marketing,
status, and address values are internally consistent for each customer ID.
There are 229 customers with multiple pets, with a maximum of seven pets for
one customer.

Important validation findings:

- 1,536 dogs and 9 cats.
- 1,354 active, 168 inactive, 22 deceased, and 1 externally transferred pet.
- 1,098 birth dates; 354 are marked approximate.
- 1,475 mobile numbers normalize to ten digits.
- 1,538 email cells are populated and pass a basic syntax check.
- 132 microchip cells contain 130 distinct values. The two duplicate values
  require human review before any uniqueness rule is enabled.
- Weight is non-zero for only 413 pets; 1,132 rows use zero as a placeholder.
  The export does not declare the unit.
- `Last Board` includes a date later than the workbook review date, so those
  fields may represent a reservation as well as a completed visit.
- `Sheet2` contains four source-user labels. They are useful as provenance but
  must not create UCBarkley staff accounts automatically.

## Destination model

One unique `Customer Id` becomes one household account with one imported owner
contact. All pets sharing that customer ID point to that contact. UCBarkley
UUIDs remain the primary keys; POS IDs are stored in external-ID mapping tables
linked to a normalized `external_sources` record for idempotent re-runs. The
workbook is treated as an import source, not as the shape of the UCBarkley
domain model.

| POS column | UCBarkley destination | Import rule |
| --- | --- | --- |
| `Customer Id` | `household_external_ids.external_id` | Map the POS account to a household; source system plus ID is unique per organization. |
| `Cust First Name`, `Cust Last Name` | `owners.full_name` | Trim and compose the canonical contact display name without duplicating name components. |
| `Email`, `Mobile` | `owners.email`, `phone` | Lowercase email; normalize phone for matching while retaining a display value. |
| `Cust Status` | `households.status`, `household_flags` | Active variants remain active; represent VIP and alert as related classification rows. |
| `Reminders/Marketing` | `owner_communication_preferences` | Record the combined scope exactly; leave the source timestamp null because the export does not contain one. |
| `Address` | `household_addresses` | Import only after verified parsing into structured address components. Keep unparsed text in the validation artifact, not the domain tables. |
| `Customer's Notes` | `pet_notes` (`customer_provided`) | Despite its heading, this value varies by pet within the same customer account. Preserve it as a pet note rather than overwriting the owner. |
| `Id` | `pet_external_ids.external_id` | Source system plus ID is unique per organization. |
| `Name`, `Type`, `Breed` | basic pet fields | Normalize type to `dog`, `cat`, or `other`. |
| `Status` | `pets.status` | Map `Changed Owner - External` to `transferred`. |
| `Mixed Breed`, `Size` | pet profile fields | Normalize size to the supported lowercase enum. |
| `Sex` | `pets.sex`, `reproductive_status` | Split biological sex from spayed/neutered/intact state. |
| `Date of Birth`, `DOB Approx` | birth-date fields | Import valid dates and retain the approximate flag. |
| `Age (y.m)`, `Next Birthday` | not imported | Derived from date of birth when displayed. |
| `Color`, `Temperament` | intrinsic pet profile fields | Trim values; blanks become null. |
| `Vet` | `care_providers`, `pet_care_providers` | Deduplicate normalized provider names and create an explicit pet relationship. |
| `Registration #`, `Microchip #` | `pet_identifiers` | Store typed one-to-many identifiers; keep microchips non-unique until duplicates are resolved. |
| `Attributes` | `pet_flags` | Map reviewed values to stable flags such as bite risk, escape risk, muzzle required, and visual impairment. Unknown values remain import issues. |
| `Notes` | `pet_notes` (`internal`) | Preserve generic operational notes separately; do not classify them as medical notes automatically. |
| `Weight` | `pets.weight_kg` | Zero becomes null; import positive values only after the unit is confirmed and converted. |
| `Last Groom`, `Last Board`, `Last Daycare` | `pet_service_milestones` | Import as source milestones, not reconstructed sessions. Flag future dates. |
| source audit columns | external-ID mapping tables | Preserve source dates, source usernames, row number, and checksum. |
| `Selected` | not imported | Export UI state only. |

## Safe migration sequence

1. Apply migrations `0016_pos_customer_import_readiness.sql`,
   `0017_normalized_import_exceptions.sql`, and `0018_normalized_pet_notes.sql`.
2. Export a fresh workbook and record its Drive file ID, filename, sheet, row
   count, and SHA-256 checksum in a `data_import_batches` row.
3. Run a dry validation without writes: duplicate source IDs, required names,
   enum mappings, email/phone syntax, dates, microchips, and weight unit.
4. Hold duplicate microchips, weights without a confirmed unit, unparsed
   addresses, and future service dates in `data_import_issues`; do not coerce
   them into core columns.
5. Import one customer and all of that customer's pets into a test organization.
6. Verify household grouping, search, profile display, and tenant isolation.
7. Import the full file in one organization-scoped transaction using
   `withOrgScope`. Upsert only through the external-ID mappings; never match
   solely by name.
8. Reconcile counts and totals, then mark the batch `completed`. On failure,
   roll back the transaction and retain only the validation report.

The CLI importer is `apps/api/src/scripts/importPosCustomers.ts`. It defaults to
a dry run and writes only when `--commit` is supplied:

```bash
npm run import:pos --workspace=apps/api -- \
  --file /path/to/TalkFile_Pets.xlsx.xlsx \
  --organization <organization-uuid> \
  --source-file-id 1vVQGMOCwq49De-oU5XDnnpL-Rcxa2ss8 \
  --source-file-name TalkFile_Pets.xlsx.xlsx \
  --sheet Sheet
```

Review the dry-run summary, then repeat the same command with `--commit`. The
write runs through `withOrgScope`, uses external IDs for idempotent upserts, and
commits as one transaction. An Administrator import-resolution screen remains
a future product task; managers can already inspect unresolved issues on each
customer profile in the Customers directory.

## Local import record

The September 25, 2026 local batch has ID
`3f3b6995-805b-4b84-96ee-77fe14e28af3` and source SHA-256
`8954ff5827d8886eb7dee0c201bff114d4ee3dfa1a7029253ab4d7139b04bf00`.
It created 1,251 households, 1,251 owner contacts, and 1,545 pets. Aggregate
verification found no orphaned relationships, cross-organization links, or
duplicate external IDs.

The batch also imported 1,097 parsed addresses, 195 pet identifiers, 1,047 pet
to care-provider relationships, 1,495 historical service milestones, 172 pet
notes, and 35 active pet flags. It retained 476 review issues instead of
guessing: 413 weights without a unit, 53 addresses requiring review, four
duplicate-microchip occurrences, two future service dates, two missing contact
methods, and two non-size values.

## Staging import record

The September 27, 2026 staging batch has ID
`2a2ad46b-9ef2-47fc-be21-5db9ef58ae55` and the same verified source SHA-256 as
the local batch. It created 1,251 households, 1,251 owner contacts, and 1,545
pets in `UCBarkley Test Facility`. It also imported the same normalized
address, identifier, provider-link, milestone, note, flag, and held-issue
counts documented above.

Post-import reconciliation found zero orphaned owner or pet mappings and zero
duplicate external IDs. Including the five pre-existing test customers and six
pre-existing pets, staging now contains 1,256 customer contacts and 1,551 pets
for that organization. A private logical database backup and a VM snapshot were
confirmed before deployment.

## Normalization rules

- The source workbook never determines table shape.
- External systems, import batches, customer accounts, contacts, addresses,
  preferences, pets, identifiers, providers, provider relationships,
  classifications, and service milestones remain separate relations.
- Derived fields such as age and next birthday are calculated, not stored.
- Unknown or ambiguous values stay in the validation report until classified;
  they do not enter a JSON catch-all column.
- Every tenant relationship uses both `organization_id` and the entity UUID in
  its foreign key, preventing cross-organization relationships at the database
  layer.
