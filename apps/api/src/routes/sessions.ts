import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { presignGetUrl } from "../lib/s3.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);

async function resolveFacilityId(client: PoolClient, req: Request, defaultWhenMissing: boolean) {
  const requested = req.header("x-facility-id");
  if (requested && !z.string().uuid().safeParse(requested).success) {
    throw new HttpError(400, "Choose a valid facility");
  }

  if (requested) {
    const result = await client.query(
      `SELECT facilities.id
       FROM facilities
       WHERE facilities.id = $1
         AND facilities.organization_id = $2
         AND facilities.is_active = true
         AND (
           $3::text <> 'staff'
           OR EXISTS (
             SELECT 1 FROM user_facility_assignments assignment
             WHERE assignment.organization_id = facilities.organization_id
               AND assignment.facility_id = facilities.id
               AND assignment.user_id = $4
           )
         )`,
      [requested, req.auth!.organizationId, req.auth!.role, req.auth!.sub]
    );
    if (!result.rows[0]) throw new HttpError(403, "You are not assigned to that facility");
    return result.rows[0].id as string;
  }

  if (req.auth!.role !== "staff" && !defaultWhenMissing) return null;
  const result = await client.query(
    `SELECT facilities.id
     FROM facilities
     LEFT JOIN user_facility_assignments assignment
       ON assignment.organization_id = facilities.organization_id
      AND assignment.facility_id = facilities.id
      AND assignment.user_id = $2
     WHERE facilities.organization_id = $1
       AND facilities.is_active = true
       AND ($3::text <> 'staff' OR assignment.user_id IS NOT NULL)
     ORDER BY facilities.is_default DESC, facilities.name
     LIMIT 1`,
    [req.auth!.organizationId, req.auth!.sub, req.auth!.role]
  );
  if (!result.rows[0]) throw new HttpError(403, "No facility is assigned to this account");
  return result.rows[0].id as string;
}

sessionsRouter.get(
  "/sessions",
  asyncRoute(async (req, res) => {
    const status = z.enum(["reserved", "active", "checked_out", "cancelled"]).optional().parse(req.query.status);
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const facilityId = await resolveFacilityId(client, req, false);
      const result = await client.query(
        `SELECT s.*, p.name AS pet_name, p.species, p.breed,
                o.full_name AS owner_name,
                collar.color_name AS collar_color_name,
                collar.color_hex AS collar_color_hex,
                COALESCE(session_media.photo_count, 0)::int AS photo_count,
                session_media.thumbnail_key AS photo_thumbnail_key
         FROM sessions s
         JOIN pets p ON p.id = s.pet_id AND p.organization_id = s.organization_id
         LEFT JOIN owners o
           ON o.id = p.owner_id
          AND o.organization_id = s.organization_id
         LEFT JOIN organization_collar_palette collar
           ON collar.id = s.collar_palette_id
          AND collar.organization_id = s.organization_id
         LEFT JOIN LATERAL (
           SELECT
             (
               SELECT count(*)::int
               FROM photo_pet_links count_link
               JOIN photos count_photo
                 ON count_photo.id = count_link.photo_id
                AND count_photo.organization_id = count_link.organization_id
                AND count_photo.deleted_at IS NULL
               WHERE count_link.organization_id = s.organization_id
                 AND count_link.session_id = s.id
                 AND count_link.review_state IN ('pending', 'candidate', 'published')
             ) AS photo_count,
             COALESCE(
               (
                 SELECT identity_detection.crop_storage_key
                 FROM photos identity_photo
                 JOIN photo_detections identity_detection
                   ON identity_detection.photo_id = identity_photo.id
                  AND identity_detection.organization_id = identity_photo.organization_id
                 WHERE identity_photo.organization_id = s.organization_id
                   AND identity_photo.reference_session_id = s.id
                   AND identity_photo.reference_pet_id = s.pet_id
                   AND identity_photo.media_purpose = 'identity_reference'
                   AND identity_photo.identity_reference_removed_at IS NULL
                   AND identity_photo.deleted_at IS NULL
                   AND identity_detection.matched_session_id = s.id
                   AND identity_detection.matched_pet_id = s.pet_id
                   AND identity_detection.crop_storage_key IS NOT NULL
                   AND identity_detection.match_status = 'manually_assigned'
                 ORDER BY identity_detection.quality_score DESC NULLS LAST,
                          identity_detection.detector_confidence DESC NULLS LAST,
                          COALESCE(identity_photo.capture_at, identity_photo.uploaded_at) DESC
                 LIMIT 1
               ),
               (
                 SELECT COALESCE(report_detection.crop_storage_key, report_photo.thumbnail_key, report_photo.storage_key)
                 FROM photo_pet_links report_link
                 JOIN photos report_photo
                   ON report_photo.id = report_link.photo_id
                  AND report_photo.organization_id = report_link.organization_id
                  AND report_photo.deleted_at IS NULL
                 LEFT JOIN photo_detections report_detection
                   ON report_detection.id = report_link.source_detection_id
                  AND report_detection.photo_id = report_link.photo_id
                  AND report_detection.organization_id = report_link.organization_id
                  AND report_detection.matched_pet_id = report_link.pet_id
                 WHERE report_link.organization_id = s.organization_id
                   AND report_link.session_id = s.id
                   AND report_link.pet_id = s.pet_id
                   AND report_link.review_state IN ('pending', 'candidate', 'published')
                 ORDER BY report_link.quality_score DESC NULLS LAST,
                          COALESCE(report_photo.capture_at, report_photo.uploaded_at) DESC
                 LIMIT 1
               )
             ) AS thumbnail_key
         ) session_media ON true
         WHERE s.organization_id = $1
           AND ($2::text IS NULL OR s.status = $2)
           AND ($3::uuid IS NULL OR s.facility_id = $3)
         ORDER BY
           CASE WHEN $2 = 'reserved' THEN s.scheduled_check_in_at END ASC NULLS LAST,
           CASE WHEN $2 IS DISTINCT FROM 'reserved' THEN COALESCE(s.check_in_at, s.scheduled_check_in_at) END DESC NULLS LAST,
           s.id ASC
         LIMIT 100`,
        [req.auth!.organizationId, status ?? null, facilityId]
      );
      return Promise.all(
        result.rows.map(async (row) => {
          const { photo_thumbnail_key: thumbnailKey, ...session } = row;
          return {
            ...session,
            photo_thumbnail_url: thumbnailKey ? await presignGetUrl(thumbnailKey) : null,
          };
        })
      );
    });
    res.json(rows);
  })
);

const checkInSchema = z.object({
  clientCheckInId: z.string().uuid().optional(),
  petId: z.string().uuid(),
  sessionType: z.enum(["boarding", "daycare"]),
  checkInAt: z.string().datetime().optional(),
  expectedCheckOutAt: z.string().datetime().optional(),
  notes: z.string().optional(),
  collarEnabled: z.boolean().default(false),
  collarPaletteId: z.string().uuid().optional(),
  collarLabel: z.string().optional(),
}).superRefine((body, context) => {
  if (body.collarEnabled && !body.collarPaletteId) {
    context.addIssue({
      code: "custom",
      path: ["collarPaletteId"],
      message: "Choose or scan a facility collar",
    });
  }
  if (body.expectedCheckOutAt && new Date(body.expectedCheckOutAt) <= new Date(body.checkInAt ?? Date.now())) {
    context.addIssue({
      code: "custom",
      path: ["expectedCheckOutAt"],
      message: "Expected check-out must be after check-in",
    });
  }
});

const batchCheckInSchema = z.object({
  clientCheckInIds: z.array(z.string().uuid()).min(2).max(20).refine((ids) => new Set(ids).size === ids.length, {
    message: "Each pet must have a different check-in request ID",
  }).optional(),
  petIds: z.array(z.string().uuid()).min(2).max(20).refine((ids) => new Set(ids).size === ids.length, {
    message: "Each pet can only be selected once",
  }),
  sessionType: z.enum(["boarding", "daycare"]),
  checkInAt: z.string().datetime().optional(),
  expectedCheckOutAt: z.string().datetime().optional(),
  notes: z.string().optional(),
}).superRefine((body, context) => {
  if (body.clientCheckInIds && body.clientCheckInIds.length !== body.petIds.length) {
    context.addIssue({
      code: "custom",
      path: ["clientCheckInIds"],
      message: "Provide one check-in request ID for each pet",
    });
  }
  if (body.expectedCheckOutAt && new Date(body.expectedCheckOutAt) <= new Date(body.checkInAt ?? Date.now())) {
    context.addIssue({
      code: "custom",
      path: ["expectedCheckOutAt"],
      message: "Expected check-out must be after check-in",
    });
  }
});

sessionsRouter.post(
  "/sessions",
  asyncRoute(async (req, res) => {
    const body = checkInSchema.parse(req.body);
    // Computed here rather than reused inside a SQL CASE expression — Postgres's
    // parameter type inference can't always resolve a parameter reused across
    // both a plain value position and a CASE branch in the same statement
    // (raises a 42P08 ambiguous_parameter error), so it's simplest to just
    // compute the two collar-assignment columns in JS instead.
    const collarAssignedAt = body.collarEnabled ? new Date() : null;
    const collarAssignedBy = body.collarEnabled ? req.auth!.sub : null;
    try {
      const session = await withOrgScope(req.auth!.organizationId, async (client) => {
        const facilityId = await resolveFacilityId(client, req, true);
        if (body.clientCheckInId) {
          const existing = await client.query(
            `SELECT * FROM sessions
             WHERE organization_id = $1 AND client_check_in_id = $2`,
            [req.auth!.organizationId, body.clientCheckInId]
          );
          if (existing.rows[0]) {
            if (existing.rows[0].pet_id !== body.petId || existing.rows[0].facility_id !== facilityId) {
              throw new HttpError(409, "This saved check-in request does not match the original pet or facility");
            }
            return existing.rows[0];
          }
        }
        if (body.collarEnabled) {
          const collar = await client.query(
            `SELECT id FROM organization_collar_palette
             WHERE id = $1 AND organization_id = $2 AND is_active = true`,
            [body.collarPaletteId, req.auth!.organizationId]
          );
          if (!collar.rows[0]) throw new HttpError(400, "That collar is not active for this facility");
        }
        const reservation = await client.query(
          `SELECT id FROM sessions
           WHERE organization_id = $1 AND pet_id = $2 AND status = 'reserved'
           ORDER BY scheduled_check_in_at LIMIT 1`,
          [req.auth!.organizationId, body.petId]
        );
        if (reservation.rows.length > 0) {
          throw new HttpError(409, "This pet has a reservation. Start it from Expected arrivals instead");
        }
        const result = await client.query(
          `INSERT INTO sessions
             (organization_id, facility_id, pet_id, session_type, scheduled_check_in_at, check_in_at, expected_check_out_at, notes,
              checked_in_by, collar_enabled, collar_palette_id, collar_label, collar_assigned_at, collar_assigned_by,
              client_check_in_id)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [
            req.auth!.organizationId,
            facilityId,
            body.petId,
            body.sessionType,
            body.checkInAt ?? new Date(),
            body.expectedCheckOutAt,
            body.notes,
            req.auth!.sub,
            body.collarEnabled,
            body.collarPaletteId,
            body.collarLabel,
            collarAssignedAt,
            collarAssignedBy,
            body.clientCheckInId,
          ]
        );
        return result.rows[0];
      });
      res.status(201).json(session);
    } catch (err) {
      const databaseError = err as { code?: string; constraint?: string };
      if (databaseError.code === "23505" && databaseError.constraint === "uq_active_session_per_pet") {
        throw new HttpError(409, "This pet is already checked in");
      }
      if (databaseError.code === "23505" && databaseError.constraint === "uq_active_collar_per_org") {
        throw new HttpError(409, "That collar color is already in use by another active session");
      }
      throw err;
    }
  })
);

sessionsRouter.post(
  "/sessions/batch",
  asyncRoute(async (req, res) => {
    const body = batchCheckInSchema.parse(req.body);
    try {
      const sessions = await withOrgScope(req.auth!.organizationId, async (client) => {
        const facilityId = await resolveFacilityId(client, req, true);
        if (body.clientCheckInIds) {
          const existing = await client.query(
            `SELECT * FROM sessions
             WHERE organization_id = $1 AND client_check_in_id = ANY($2::uuid[])
             ORDER BY array_position($2::uuid[], client_check_in_id)`,
            [req.auth!.organizationId, body.clientCheckInIds]
          );
          if (existing.rows.length > 0) {
            const completeRetry = existing.rows.length === body.petIds.length
              && existing.rows.every((row, index) => row.pet_id === body.petIds[index] && row.facility_id === facilityId);
            if (!completeRetry) {
              throw new HttpError(409, "This saved group check-in does not match the original pets or facility");
            }
            return existing.rows;
          }
        }
        const pets = await client.query(
          `SELECT id, owner_id FROM pets WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
          [req.auth!.organizationId, body.petIds]
        );
        if (pets.rows.length !== body.petIds.length) throw new HttpError(400, "One or more pets were not found");
        const ownerIds = new Set(pets.rows.map((pet) => pet.owner_id).filter(Boolean));
        if (ownerIds.size !== 1 || pets.rows.some((pet) => !pet.owner_id)) {
          throw new HttpError(400, "Batch check-in is only available for pets belonging to the same owner");
        }
        const reservations = await client.query(
          `SELECT pet_id FROM sessions
           WHERE organization_id = $1 AND pet_id = ANY($2::uuid[]) AND status = 'reserved'`,
          [req.auth!.organizationId, body.petIds]
        );
        if (reservations.rows.length > 0) {
          throw new HttpError(409, "One or more selected pets have a reservation. Start them from Expected arrivals instead");
        }

        const created = [];
        for (const [index, petId] of body.petIds.entries()) {
          const result = await client.query(
            `INSERT INTO sessions
               (organization_id, facility_id, pet_id, session_type, scheduled_check_in_at, check_in_at, expected_check_out_at, notes,
                checked_in_by, client_check_in_id)
             VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
              req.auth!.organizationId,
              facilityId,
              petId,
              body.sessionType,
              body.checkInAt ?? new Date(),
              body.expectedCheckOutAt,
              body.notes,
              req.auth!.sub,
              body.clientCheckInIds?.[index],
            ]
          );
          created.push(result.rows[0]);
        }
        return created;
      });
      res.status(201).json(sessions);
    } catch (err) {
      const databaseError = err as { code?: string; constraint?: string };
      if (databaseError.code === "23505" && databaseError.constraint === "uq_active_session_per_pet") {
        throw new HttpError(409, "One or more selected pets are already checked in");
      }
      throw err;
    }
  })
);

const reservationSchema = z.object({
  petIds: z.array(z.string().uuid()).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, {
    message: "Each pet can only be selected once",
  }),
  sessionType: z.enum(["boarding", "daycare"]),
  scheduledCheckInAt: z.string().datetime(),
  expectedCheckOutAt: z.string().datetime(),
  notes: z.string().max(2000).optional(),
}).superRefine((body, context) => {
  if (new Date(body.expectedCheckOutAt) <= new Date(body.scheduledCheckInAt)) {
    context.addIssue({
      code: "custom",
      path: ["expectedCheckOutAt"],
      message: "Expected check-out must be after the scheduled arrival",
    });
  }
});

sessionsRouter.post(
  "/sessions/reservations",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = reservationSchema.parse(req.body);
    const reservationGroupId = randomUUID();
    const reservations = await withOrgScope(req.auth!.organizationId, async (client) => {
      const facilityId = await resolveFacilityId(client, req, true);
      const pets = await client.query(
        `SELECT id, owner_id FROM pets
         WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
        [req.auth!.organizationId, body.petIds]
      );
      if (pets.rows.length !== body.petIds.length) throw new HttpError(400, "One or more pets were not found");
      if (body.petIds.length > 1) {
        const ownerIds = new Set(pets.rows.map((pet) => pet.owner_id).filter(Boolean));
        if (ownerIds.size !== 1 || pets.rows.some((pet) => !pet.owner_id)) {
          throw new HttpError(400, "A group reservation is only available for pets belonging to the same owner");
        }
      }

      const conflicts = await client.query(
        `SELECT pet_id, status FROM sessions
         WHERE organization_id = $1 AND pet_id = ANY($2::uuid[])
           AND (status = 'active' OR (status = 'reserved' AND scheduled_check_in_at::date = $3::timestamptz::date))`,
        [req.auth!.organizationId, body.petIds, body.scheduledCheckInAt]
      );
      if (conflicts.rows.some((row) => row.status === "active")) {
        throw new HttpError(409, "One or more selected pets are already checked in");
      }
      if (conflicts.rows.length > 0) {
        throw new HttpError(409, "One or more selected pets already have a reservation for that date");
      }

      const created = [];
      for (const petId of body.petIds) {
        const result = await client.query(
          `INSERT INTO sessions
             (organization_id, facility_id, pet_id, session_type, scheduled_check_in_at, check_in_at,
              expected_check_out_at, status, notes, reserved_at, reserved_by, reservation_group_id)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, 'reserved', $7, now(), $8, $9)
           RETURNING *`,
          [
            req.auth!.organizationId,
            facilityId,
            petId,
            body.sessionType,
            body.scheduledCheckInAt,
            body.expectedCheckOutAt,
            body.notes,
            req.auth!.sub,
            reservationGroupId,
          ]
        );
        created.push(result.rows[0]);
      }
      return created;
    });
    res.status(201).json(reservations);
  })
);

const startReservationSchema = z.object({
  clientCheckInId: z.string().uuid().optional(),
  checkInAt: z.string().datetime().optional(),
  expectedCheckOutAt: z.string().datetime().optional(),
  collarEnabled: z.boolean().default(false),
  collarPaletteId: z.string().uuid().optional(),
  collarLabel: z.string().optional(),
}).superRefine((body, context) => {
  if (body.collarEnabled && !body.collarPaletteId) {
    context.addIssue({
      code: "custom",
      path: ["collarPaletteId"],
      message: "Choose or scan a facility collar",
    });
  }
});

sessionsRouter.post(
  "/sessions/:id/check-in",
  asyncRoute(async (req, res) => {
    const body = startReservationSchema.parse(req.body);
    const actualCheckIn = body.checkInAt ? new Date(body.checkInAt) : new Date();
    try {
      const session = await withOrgScope(req.auth!.organizationId, async (client) => {
        const facilityId = await resolveFacilityId(client, req, false);
        if (body.collarEnabled) {
          const collar = await client.query(
            `SELECT id FROM organization_collar_palette
             WHERE id = $1 AND organization_id = $2 AND is_active = true`,
            [body.collarPaletteId, req.auth!.organizationId]
          );
          if (!collar.rows[0]) throw new HttpError(400, "That collar is not active for this facility");
        }
        const currentResult = await client.query(
          `SELECT * FROM sessions
           WHERE id = $1 AND organization_id = $2
             AND ($3::uuid IS NULL OR facility_id = $3)
           FOR UPDATE`,
          [req.params.id, req.auth!.organizationId, facilityId]
        );
        const current = currentResult.rows[0];
        if (!current) throw new HttpError(404, "Reservation not found");
        if (current.status === "active" && body.clientCheckInId && current.client_check_in_id === body.clientCheckInId) {
          return current;
        }
        if (current.status !== "reserved") throw new HttpError(404, "Reservation not found");
        const expectedCheckOut = body.expectedCheckOutAt ? new Date(body.expectedCheckOutAt) : new Date(current.expected_check_out_at);
        if (!Number.isFinite(expectedCheckOut.getTime()) || expectedCheckOut <= actualCheckIn) {
          throw new HttpError(400, "Update the expected check-out to a time after check-in");
        }
        const result = await client.query(
          `UPDATE sessions
           SET status = 'active', check_in_at = $1, expected_check_out_at = $2,
               checked_in_by = $3, collar_enabled = $4, collar_palette_id = $5,
               collar_label = $6, collar_assigned_at = $7, collar_assigned_by = $8,
               client_check_in_id = $9,
               updated_at = now()
           WHERE id = $10 AND organization_id = $11 AND status = 'reserved'
           RETURNING *`,
          [
            actualCheckIn,
            expectedCheckOut,
            req.auth!.sub,
            body.collarEnabled,
            body.collarPaletteId,
            body.collarLabel,
            body.collarEnabled ? actualCheckIn : null,
            body.collarEnabled ? req.auth!.sub : null,
            body.clientCheckInId,
            current.id,
            req.auth!.organizationId,
          ]
        );
        return result.rows[0];
      });
      res.json(session);
    } catch (err) {
      const databaseError = err as { code?: string; constraint?: string };
      if (databaseError.code === "23505" && databaseError.constraint === "uq_active_session_per_pet") {
        throw new HttpError(409, "This pet is already checked in");
      }
      if (databaseError.code === "23505" && databaseError.constraint === "uq_active_collar_per_org") {
        throw new HttpError(409, "That collar color is already in use by another active session");
      }
      throw err;
    }
  })
);

sessionsRouter.post(
  "/sessions/:id/cancel",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const session = await withOrgScope(req.auth!.organizationId, async (client) => {
      const facilityId = await resolveFacilityId(client, req, false);
      const result = await client.query(
        `UPDATE sessions
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND status = 'reserved'
         RETURNING *`,
        [req.auth!.sub, req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!session) throw new HttpError(404, "Reservation not found");
    res.json(session);
  })
);

sessionsRouter.get(
  "/sessions/:id",
  asyncRoute(async (req, res) => {
    const session = await withOrgScope(req.auth!.organizationId, async (client) => {
      const facilityId = await resolveFacilityId(client, req, false);
      const result = await client.query(
        `SELECT s.*, p.name AS pet_name, p.species,
                collar.color_name AS collar_color_name,
                collar.color_hex AS collar_color_hex
         FROM sessions s
         JOIN pets p ON p.id = s.pet_id AND p.organization_id = s.organization_id
         LEFT JOIN organization_collar_palette collar
           ON collar.id = s.collar_palette_id
          AND collar.organization_id = s.organization_id
         WHERE s.id = $1 AND s.organization_id = $2
           AND ($3::uuid IS NULL OR s.facility_id = $3)`,
        [req.params.id, req.auth!.organizationId, facilityId]
      );
      return result.rows[0];
    });
    if (!session) throw new HttpError(404, "Session not found");
    res.json(session);
  })
);

sessionsRouter.post(
  "/sessions/:id/check-out",
  asyncRoute(async (req, res) => {
    const session = await withOrgScope(req.auth!.organizationId, async (client) => {
      const facilityId = await resolveFacilityId(client, req, false);
      const result = await client.query(
        `UPDATE sessions SET status = 'checked_out', check_out_at = now(), checked_out_by = $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3 AND status = 'active'
           AND ($4::uuid IS NULL OR facility_id = $4)
         RETURNING *`,
        [req.auth!.sub, req.params.id, req.auth!.organizationId, facilityId]
      );
      return result.rows[0];
    });
    if (!session) throw new HttpError(404, "Active session not found");
    res.json(session);
  })
);
