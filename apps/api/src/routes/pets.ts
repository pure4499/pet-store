import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { presignGetUrl } from "../lib/s3.js";
import { loadPetAvatarUrls, petAvatarKey } from "../lib/petAvatar.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getHouseholdDetail } from "./households.js";

export const petsRouter = Router();
petsRouter.use(requireAuth);

// Feature 1: "if the pet already registered before, find out the information" —
// this is the lookup staff use at check-in before deciding to register a new pet.
petsRouter.get(
  "/pets",
  asyncRoute(async (req, res) => {
    const search = z.string().optional().parse(req.query.search);
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT p.*, o.full_name AS owner_name, o.phone AS owner_phone, o.email AS owner_email
         FROM pets p
         LEFT JOIN owners o ON o.id = p.owner_id
         WHERE p.organization_id = $1
           AND (
             $2::text IS NULL
             OR p.name ILIKE $2
             OR o.full_name ILIKE $2
             OR o.email ILIKE $2
             OR (normalize_phone_digits($3) <> '' AND normalize_phone_digits(o.phone) ILIKE '%' || normalize_phone_digits($3) || '%')
             OR EXISTS (
               SELECT 1 FROM pets sibling
               WHERE sibling.organization_id = p.organization_id
                 AND sibling.owner_id = p.owner_id
                 AND sibling.name ILIKE $2
             )
           )
         ORDER BY p.name LIMIT 25`,
        [req.auth!.organizationId, search ? `%${search}%` : null, search ?? ""]
      );
      const avatarUrls = await loadPetAvatarUrls(client, req.auth!.organizationId, result.rows.map((row) => ({ petId: row.id })));
      return result.rows.map((row) => ({ ...row, photo_thumbnail_url: avatarUrls.get(petAvatarKey(row.id)) ?? null }));
    });
    res.json(rows);
  })
);

const createPetSchema = z.object({
  name: z.string().min(1),
  species: z.enum(["dog", "cat", "other"]),
  ownerId: z.string().uuid().optional(),
  breed: z.string().optional(),
  dateOfBirth: z.string().optional(),
  sex: z.enum(["male", "female", "unknown"]).optional(),
  weightKg: z.number().positive().optional(),
  colorMarkings: z.string().optional(),
  medicalNotes: z.string().optional(),
  owner: z.object({
    fullName: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }).refine((owner) => Boolean(owner.phone?.trim() || owner.email), {
    message: "Owner phone or email is required",
  }).optional(),
}).refine((body) => !(body.ownerId && body.owner), {
  message: "Choose an existing owner or create a new owner, not both",
});

petsRouter.post(
  "/pets",
  asyncRoute(async (req, res) => {
    const body = createPetSchema.parse(req.body);
    const pet = await withOrgScope(req.auth!.organizationId, async (client) => {
      let ownerId = body.ownerId ?? null;
      if (ownerId) {
        const owner = await client.query(
          `SELECT id FROM owners WHERE id = $1 AND organization_id = $2`,
          [ownerId, req.auth!.organizationId]
        );
        if (!owner.rows[0]) throw new HttpError(400, "Owner not found");
      }
      if (body.owner) {
        const owner = await client.query(
          `INSERT INTO owners (organization_id, full_name, phone, email)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [req.auth!.organizationId, body.owner.fullName, body.owner.phone || null, body.owner.email || null]
        );
        ownerId = owner.rows[0].id;
      }
      const result = await client.query(
        `INSERT INTO pets
           (organization_id, owner_id, name, species, breed, date_of_birth, sex, weight_kg, color_markings, medical_notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          req.auth!.organizationId,
          ownerId,
          body.name,
          body.species,
          body.breed,
          body.dateOfBirth,
          body.sex,
          body.weightKg,
          body.colorMarkings,
          body.medicalNotes,
        ]
      );
      return result.rows[0];
    });
    res.status(201).json(pet);
  })
);

const assignOwnerSchema = z.object({
  ownerId: z.string().uuid().optional(),
  owner: z.object({
    fullName: z.string().trim().min(1),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional(),
  }).refine((owner) => Boolean(owner.phone || owner.email), {
    message: "Owner phone or email is required",
  }).optional(),
}).refine((body) => Boolean(body.ownerId) !== Boolean(body.owner), {
  message: "Choose an existing owner or provide new owner details",
});

petsRouter.patch(
  "/pets/:id/owner",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = assignOwnerSchema.parse(req.body);
    const orgId = req.auth!.organizationId;
    const pet = await withOrgScope(orgId, async (client) => {
      const existingPet = await client.query(
        `SELECT id FROM pets WHERE id = $1 AND organization_id = $2`,
        [req.params.id, orgId]
      );
      if (!existingPet.rows[0]) return null;

      let ownerId = body.ownerId;
      if (ownerId) {
        const existingOwner = await client.query(
          `SELECT id FROM owners WHERE id = $1 AND organization_id = $2`,
          [ownerId, orgId]
        );
        if (!existingOwner.rows[0]) throw new HttpError(404, "Owner not found");
      } else if (body.owner) {
        const email = body.owner.email?.toLowerCase() || null;
        const phone = body.owner.phone || null;
        const matches = await client.query(
          `SELECT id FROM owners
           WHERE organization_id = $1
             AND (($2::text IS NOT NULL AND lower(email) = $2)
               OR ($3::text IS NOT NULL AND normalize_phone_digits($3) <> ''
                 AND normalize_phone_digits(phone) = normalize_phone_digits($3)))
           ORDER BY created_at
           LIMIT 2`,
          [orgId, email, phone]
        );
        if (matches.rowCount && matches.rowCount > 1) {
          throw new HttpError(409, "Email and phone match different customers. Choose the existing customer instead.");
        }
        ownerId = matches.rows[0]?.id;
        if (!ownerId) {
          const inserted = await client.query(
            `INSERT INTO owners (organization_id, full_name, phone, email)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [orgId, body.owner.fullName, phone, email]
          );
          ownerId = inserted.rows[0].id;
        }
      }

      const updated = await client.query(
        `UPDATE pets SET owner_id = $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3
         RETURNING *`,
        [ownerId, req.params.id, orgId]
      );
      return updated.rows[0];
    });
    if (!pet) throw new HttpError(404, "Pet not found");
    res.json(pet);
  })
);

petsRouter.get(
  "/pets/:id",
  asyncRoute(async (req, res) => {
    const pet = await withOrgScope(req.auth!.organizationId, async (client) => {
      const petResult = await client.query(
        `SELECT p.*, o.id AS owner_id, o.full_name AS owner_name, o.phone AS owner_phone,
                o.email AS owner_email, o.household_id
         FROM pets p LEFT JOIN owners o ON o.id = p.owner_id
         WHERE p.id = $1 AND p.organization_id = $2`,
        [req.params.id, req.auth!.organizationId]
      );
      if (petResult.rows.length === 0) return null;

      const sessionsResult = await client.query(
        `SELECT * FROM sessions WHERE pet_id = $1 ORDER BY COALESCE(check_in_at, scheduled_check_in_at) DESC LIMIT 50`,
        [req.params.id]
      );
      const petRow = petResult.rows[0];
      const household = petRow.household_id ? await getHouseholdDetail(client, petRow.household_id) : null;
      return { ...petRow, sessions: sessionsResult.rows, household };
    });
    if (!pet) throw new HttpError(404, "Pet not found");
    res.json(pet);
  })
);

// The pet's permanent portfolio: published photos across every past stay, not
// just the current one (plan §6, Pet Profile screen).
petsRouter.get(
  "/pets/:id/photos",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT l.*, p.storage_key, p.thumbnail_key
         FROM photo_pet_links l JOIN photos p
           ON p.id = l.photo_id AND p.organization_id = l.organization_id AND p.deleted_at IS NULL
         WHERE l.pet_id = $1 AND l.organization_id = $2 AND l.review_state = 'published'
         ORDER BY l.published_at DESC`,
        [req.params.id, req.auth!.organizationId]
      );
      return Promise.all(
        result.rows.map(async (row) => ({
          ...row,
          viewUrl: await presignGetUrl(row.thumbnail_key ?? row.storage_key),
        }))
      );
    });
    res.json(rows);
  })
);
