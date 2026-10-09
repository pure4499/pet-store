import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { loadPetAvatarUrls, petAvatarKey } from "../lib/petAvatar.js";

export const ownersRouter = Router();
ownersRouter.use(requireAuth);

const customerSearchSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).optional().default(25),
});

ownersRouter.get(
  "/admin/customers",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const { search, page, pageSize } = customerSearchSchema.parse(req.query);
    const pattern = search ? `%${search}%` : null;
    const offset = (page - 1) * pageSize;
    const data = await withOrgScope(req.auth!.organizationId, async (client) => {
      const filters = `o.organization_id = $1 AND (
        $2::text IS NULL
        OR o.full_name ILIKE $2
        OR o.email ILIKE $2
        OR (normalize_phone_digits($2) <> '' AND normalize_phone_digits(o.phone) ILIKE '%' || normalize_phone_digits($2) || '%')
        OR EXISTS (
          SELECT 1 FROM pets search_pet
          WHERE search_pet.owner_id = o.id AND search_pet.organization_id = o.organization_id
            AND (search_pet.name ILIKE $2 OR search_pet.breed ILIKE $2)
        )
      )`;
      const totalResult = await client.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM owners o WHERE ${filters}`,
        [req.auth!.organizationId, pattern]
      );
      const result = await client.query(
        `SELECT o.id, o.household_id, o.full_name, o.phone, o.email, o.notes,
                o.created_at, o.updated_at, h.status AS household_status,
                CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', a.id, 'line1', a.line1, 'line2', a.line2, 'city', a.city,
                  'region', a.region, 'postal_code', a.postal_code,
                  'country_code', a.country_code, 'address_type', a.address_type
                ) END AS primary_address,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'id', p.id, 'name', p.name, 'species', p.species,
                    'breed', p.breed, 'status', p.status
                  ) ORDER BY p.name)
                  FROM pets p
                  WHERE p.owner_id = o.id AND p.organization_id = o.organization_id
                ), '[]'::jsonb) AS pets,
                (
                  SELECT count(*)::int FROM data_import_issues di
                  WHERE di.organization_id = o.organization_id
                    AND di.resolution_status = 'open'
                    AND (
                      (di.entity_type IN ('owner', 'household') AND di.external_id IN (
                        SELECT oe.external_id FROM owner_external_ids oe
                        WHERE oe.owner_id = o.id AND oe.organization_id = o.organization_id
                      ))
                      OR (di.entity_type IN ('pet', 'service') AND di.external_id IN (
                        SELECT pe.external_id FROM pet_external_ids pe
                        JOIN pets issue_pet ON issue_pet.id = pe.pet_id
                          AND issue_pet.organization_id = pe.organization_id
                        WHERE issue_pet.owner_id = o.id AND pe.organization_id = o.organization_id
                      ))
                    )
                ) AS open_issue_count
         FROM owners o
         LEFT JOIN households h ON h.id = o.household_id AND h.organization_id = o.organization_id
         LEFT JOIN household_addresses a ON a.household_id = o.household_id
           AND a.organization_id = o.organization_id AND a.is_primary
         WHERE ${filters}
         ORDER BY o.full_name, o.id
         LIMIT $3 OFFSET $4`,
        [req.auth!.organizationId, pattern, pageSize, offset]
      );
      const pets = result.rows.flatMap((customer) => customer.pets as Array<{ id: string }>);
      const avatarUrls = await loadPetAvatarUrls(client, req.auth!.organizationId, pets.map((pet) => ({ petId: pet.id })));
      return {
        customers: result.rows.map((customer) => ({
          ...customer,
          pets: (customer.pets as Array<Record<string, unknown> & { id: string }>).map((pet) => ({
            ...pet,
            photo_thumbnail_url: avatarUrls.get(petAvatarKey(pet.id)) ?? null,
          })),
        })),
        total: totalResult.rows[0].total,
        page,
        pageSize,
      };
    });
    res.json(data);
  })
);

async function getCustomerDetail(client: import("pg").PoolClient, organizationId: string, ownerId: string) {
  const ownerResult = await client.query(
    `SELECT o.id, o.household_id, o.full_name, o.phone, o.email, o.notes,
            o.created_at, o.updated_at, h.status AS household_status,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', a.id, 'address_type', a.address_type, 'line1', a.line1,
                'line2', a.line2, 'city', a.city, 'region', a.region,
                'postal_code', a.postal_code, 'country_code', a.country_code,
                'is_primary', a.is_primary
              ) ORDER BY a.is_primary DESC, a.created_at)
              FROM household_addresses a
              WHERE a.household_id = o.household_id AND a.organization_id = o.organization_id
            ), '[]'::jsonb) AS addresses,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('flag_type', f.flag_type, 'note', f.note))
              FROM household_flags f
              WHERE f.household_id = o.household_id AND f.organization_id = o.organization_id AND f.active
            ), '[]'::jsonb) AS household_flags,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'purpose', cp.purpose, 'channel', cp.channel,
                'preference_status', cp.preference_status
              ) ORDER BY cp.purpose, cp.channel)
              FROM owner_communication_preferences cp
              WHERE cp.owner_id = o.id AND cp.organization_id = o.organization_id
            ), '[]'::jsonb) AS communication_preferences
     FROM owners o
     LEFT JOIN households h ON h.id = o.household_id AND h.organization_id = o.organization_id
     WHERE o.id = $1 AND o.organization_id = $2`,
    [ownerId, organizationId]
  );
  if (!ownerResult.rows[0]) return null;

  const petsResult = await client.query(
    `SELECT p.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('flag_type', f.flag_type, 'note', f.note) ORDER BY f.flag_type)
              FROM pet_flags f WHERE f.pet_id = p.id AND f.organization_id = p.organization_id AND f.active
            ), '[]'::jsonb) AS flags,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('note_type', n.note_type, 'body', n.body) ORDER BY n.note_type)
              FROM pet_notes n WHERE n.pet_id = p.id AND n.organization_id = p.organization_id
            ), '[]'::jsonb) AS notes,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'identifier_type', i.identifier_type, 'identifier_value', i.identifier_value, 'issuer', i.issuer
              ) ORDER BY i.identifier_type, i.identifier_value)
              FROM pet_identifiers i WHERE i.pet_id = p.id AND i.organization_id = p.organization_id
            ), '[]'::jsonb) AS identifiers,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', provider.id, 'provider_type', provider.provider_type,
                'name', provider.name, 'phone', provider.phone, 'email', provider.email,
                'relationship', link.relationship
              ) ORDER BY provider.name)
              FROM pet_care_providers link
              JOIN care_providers provider ON provider.id = link.care_provider_id
                AND provider.organization_id = link.organization_id
              WHERE link.pet_id = p.id AND link.organization_id = p.organization_id
            ), '[]'::jsonb) AS care_providers,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('service_type', m.service_type, 'occurred_on', m.occurred_on) ORDER BY m.occurred_on DESC)
              FROM pet_service_milestones m WHERE m.pet_id = p.id AND m.organization_id = p.organization_id
            ), '[]'::jsonb) AS service_milestones,
            (SELECT count(*)::int FROM sessions s WHERE s.pet_id = p.id AND s.organization_id = p.organization_id) AS stay_count,
            (SELECT max(s.check_in_at) FROM sessions s WHERE s.pet_id = p.id AND s.organization_id = p.organization_id) AS last_stay_at
     FROM pets p
     WHERE p.owner_id = $1 AND p.organization_id = $2
     ORDER BY p.name, p.id`,
    [ownerId, organizationId]
  );

  const issuesResult = await client.query(
    `SELECT di.id, di.entity_type, di.external_id, di.field_name, di.issue_code,
            di.raw_value, di.resolution_status, di.resolution_note, di.source_row_number,
            di.created_at
     FROM data_import_issues di
     WHERE di.organization_id = $2 AND di.resolution_status = 'open' AND (
       (di.entity_type IN ('owner', 'household') AND di.external_id IN (
         SELECT oe.external_id FROM owner_external_ids oe
         WHERE oe.owner_id = $1 AND oe.organization_id = $2
       ))
       OR (di.entity_type IN ('pet', 'service') AND di.external_id IN (
         SELECT pe.external_id FROM pet_external_ids pe
         JOIN pets p ON p.id = pe.pet_id AND p.organization_id = pe.organization_id
         WHERE p.owner_id = $1 AND pe.organization_id = $2
       ))
     )
     ORDER BY di.source_row_number, di.issue_code`,
    [ownerId, organizationId]
  );
  const avatarUrls = await loadPetAvatarUrls(client, organizationId, petsResult.rows.map((pet) => ({ petId: pet.id })));
  return {
    ...ownerResult.rows[0],
    pets: petsResult.rows.map((pet) => ({ ...pet, photo_thumbnail_url: avatarUrls.get(petAvatarKey(pet.id)) ?? null })),
    import_issues: issuesResult.rows,
  };
}

ownersRouter.get(
  "/admin/customers/:id",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const ownerId = z.string().uuid().parse(req.params.id);
    const customer = await withOrgScope(req.auth!.organizationId, (client) =>
      getCustomerDetail(client, req.auth!.organizationId, ownerId)
    );
    if (!customer) throw new HttpError(404, "Customer not found");
    res.json(customer);
  })
);

const updateCustomerSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).nullable(),
  email: z.string().trim().email().max(320).nullable(),
  notes: z.string().trim().max(5000).nullable(),
  householdStatus: z.enum(["active", "inactive"]),
  address: z.object({
    line1: z.string().trim().min(1).max(300),
    line2: z.string().trim().max(300).nullable(),
    city: z.string().trim().max(120).nullable(),
    region: z.string().trim().max(120).nullable(),
    postalCode: z.string().trim().max(30).nullable(),
    countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).nullable(),
  }).nullable(),
});

ownersRouter.patch(
  "/admin/customers/:id",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const ownerId = z.string().uuid().parse(req.params.id);
    const body = updateCustomerSchema.parse(req.body);
    const customer = await withOrgScope(req.auth!.organizationId, async (client) => {
      const owner = await client.query<{ household_id: string | null }>(
        `UPDATE owners SET full_name = $1, phone = $2, email = $3, notes = $4, updated_at = now()
         WHERE id = $5 AND organization_id = $6 RETURNING household_id`,
        [body.fullName, body.phone, body.email?.toLowerCase() ?? null, body.notes, ownerId, req.auth!.organizationId]
      );
      if (!owner.rows[0]) return null;
      const householdId = owner.rows[0].household_id;
      if (householdId) {
        await client.query(
          `UPDATE households SET status = $1, updated_at = now() WHERE id = $2 AND organization_id = $3`,
          [body.householdStatus, householdId, req.auth!.organizationId]
        );
        if (body.address) {
          await client.query(
            `INSERT INTO household_addresses (
               organization_id, household_id, address_type, line1, line2, city,
               region, postal_code, country_code, is_primary
             ) VALUES ($1, $2, 'home', $3, $4, $5, $6, $7, $8, true)
             ON CONFLICT (organization_id, household_id) WHERE is_primary
             DO UPDATE SET line1 = EXCLUDED.line1, line2 = EXCLUDED.line2,
               city = EXCLUDED.city, region = EXCLUDED.region,
               postal_code = EXCLUDED.postal_code, country_code = EXCLUDED.country_code,
               updated_at = now()`,
            [req.auth!.organizationId, householdId, body.address.line1, body.address.line2,
              body.address.city, body.address.region, body.address.postalCode, body.address.countryCode]
          );
        } else {
          await client.query(
            `DELETE FROM household_addresses WHERE organization_id = $1 AND household_id = $2 AND is_primary`,
            [req.auth!.organizationId, householdId]
          );
        }
      }
      return getCustomerDetail(client, req.auth!.organizationId, ownerId);
    });
    if (!customer) throw new HttpError(404, "Customer not found");
    res.json(customer);
  })
);

const updateCustomerPetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  species: z.enum(["dog", "cat", "other"]),
  breed: z.string().trim().max(200).nullable(),
  status: z.enum(["active", "inactive", "deceased", "transferred"]),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sex: z.enum(["male", "female", "unknown"]).nullable(),
  reproductiveStatus: z.enum(["intact", "spayed", "neutered", "unknown"]).nullable(),
  isMixedBreed: z.boolean().nullable(),
  sizeClass: z.enum(["toy", "small", "medium", "large", "giant", "unknown"]).nullable(),
  weightKg: z.number().positive().nullable(),
  colorMarkings: z.string().trim().max(500).nullable(),
  temperament: z.string().trim().max(2000).nullable(),
});

ownersRouter.patch(
  "/admin/customers/:ownerId/pets/:petId",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const ownerId = z.string().uuid().parse(req.params.ownerId);
    const petId = z.string().uuid().parse(req.params.petId);
    const body = updateCustomerPetSchema.parse(req.body);
    const customer = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE pets SET name = $1, species = $2, breed = $3, status = $4,
           date_of_birth = $5, sex = $6, reproductive_status = $7,
           is_mixed_breed = $8, size_class = $9, weight_kg = $10,
           color_markings = $11, temperament = $12, updated_at = now()
         WHERE id = $13 AND owner_id = $14 AND organization_id = $15 RETURNING id`,
        [body.name, body.species, body.breed, body.status, body.dateOfBirth, body.sex,
          body.reproductiveStatus, body.isMixedBreed, body.sizeClass, body.weightKg,
          body.colorMarkings, body.temperament, petId, ownerId, req.auth!.organizationId]
      );
      if (!result.rows[0]) return null;
      return getCustomerDetail(client, req.auth!.organizationId, ownerId);
    });
    if (!customer) throw new HttpError(404, "Customer or pet not found");
    res.json(customer);
  })
);

ownersRouter.get(
  "/owners",
  asyncRoute(async (req, res) => {
    const search = z.string().optional().parse(req.query.search);
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      if (search) {
        // The digit-normalized phone match only kicks in when the search term
        // itself has digits in it — otherwise normalize_phone_digits('') is an
        // empty string, which is a substring of every phone number and would
        // make a pure-name search like "John" match every row.
        const result = await client.query(
          `SELECT * FROM owners
           WHERE organization_id = $1
             AND (
               full_name ILIKE $2
               OR email ILIKE $2
               OR (normalize_phone_digits($3) <> '' AND normalize_phone_digits(phone) ILIKE '%' || normalize_phone_digits($3) || '%')
             )
           ORDER BY full_name LIMIT 25`,
          [req.auth!.organizationId, `%${search}%`, search]
        );
        return result.rows;
      }
      const result = await client.query(
        "SELECT * FROM owners WHERE organization_id = $1 ORDER BY full_name LIMIT 25",
        [req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(rows);
  })
);

const createOwnerSchema = z.object({
  fullName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
});

ownersRouter.post(
  "/owners",
  asyncRoute(async (req, res) => {
    const body = createOwnerSchema.parse(req.body);
    const owner = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO owners (organization_id, full_name, phone, email, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.auth!.organizationId, body.fullName, body.phone, body.email, body.notes]
      );
      return result.rows[0];
    });
    res.status(201).json(owner);
  })
);
