import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { presignGetUrl, presignPutUrl } from "../lib/s3.js";
import { currentSourceMediaBytes, MAX_PHOTOS_PER_BATCH, MAX_PHOTO_UPLOAD_BYTES } from "../lib/mediaLimits.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const photosRouter = Router();
photosRouter.use(requireAuth);

photosRouter.post(
  "/photo-batches",
  asyncRoute(async (req, res) => {
    const batch = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO photo_batches (organization_id, uploaded_by) VALUES ($1, $2) RETURNING *`,
        [req.auth!.organizationId, req.auth!.sub]
      );
      return result.rows[0];
    });
    res.status(201).json(batch);
  })
);

const uploadUrlsSchema = z.object({
  batchId: z.string().uuid(),
  files: z.array(z.object({
    fileName: z.string().min(1),
    contentType: z.string().min(1),
    fileSizeBytes: z.number().int().positive().max(MAX_PHOTO_UPLOAD_BYTES),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })).min(1).max(MAX_PHOTOS_PER_BATCH),
  deferProcessing: z.boolean().default(false),
  identityReference: z.object({
    petId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }).optional(),
  reportAssignment: z.object({
    petId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }).optional(),
}).refine((body) => !(body.identityReference && body.reportAssignment), {
  message: "An upload cannot be both identity reference and report media",
});

// Client requests presigned PUT URLs, uploads bytes to S3 directly (never
// proxied through this API), then PUTs straight to S3. In production the
// pipeline is triggered by S3's own ObjectCreated event, not by the client
// telling us it's done — see /photos/:id/confirm-upload below.
photosRouter.post(
  "/photos/upload-urls",
  asyncRoute(async (req, res) => {
    const body = uploadUrlsSchema.parse(req.body);
    const orgId = req.auth!.organizationId;

    const uploads = await withOrgScope(orgId, async (client) => {
      const batch = await client.query(
        `SELECT 1 FROM photo_batches WHERE id = $1 AND organization_id = $2`,
        [body.batchId, orgId]
      );
      if (batch.rows.length === 0) throw new HttpError(404, "Photo batch not found");
      const settings = await client.query(
        `SELECT media_storage_limit_bytes::text AS bytes
         FROM organization_settings WHERE organization_id = $1`,
        [orgId]
      );
      const usedBytes = await currentSourceMediaBytes(client, orgId);
      const requestedBytes = body.files.reduce((total, file) => total + file.fileSizeBytes, 0);
      if (usedBytes + requestedBytes > Number(settings.rows[0]?.bytes ?? 0)) {
        throw new HttpError(413, "This upload would exceed the facility media-storage allowance");
      }
      if (body.identityReference) {
        const target = await client.query(
          `SELECT 1 FROM sessions
           WHERE id = $1 AND pet_id = $2 AND organization_id = $3 AND status = 'active'`,
          [body.identityReference.sessionId, body.identityReference.petId, orgId]
        );
        if (target.rows.length === 0) {
          throw new HttpError(400, "Identity reference must belong to the pet's active stay");
        }
      }
      if (body.reportAssignment) {
        const target = await client.query(
          `SELECT 1 FROM sessions
           WHERE id = $1 AND pet_id = $2 AND organization_id = $3 AND status = 'active'`,
          [body.reportAssignment.sessionId, body.reportAssignment.petId, orgId]
        );
        if (target.rows.length === 0) {
          throw new HttpError(400, "Report media must belong to the pet's active stay");
        }
      }
      const results = [];
      for (const file of body.files) {
        const storageKey = `raw/${orgId}/${body.batchId}/${randomUUID()}-${file.fileName}`;
        const photoResult = await client.query(
          `INSERT INTO photos
             (organization_id, batch_id, uploaded_by, storage_key, processing_status,
              media_purpose, reference_pet_id, reference_session_id, file_size_bytes, width, height)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            orgId,
            body.batchId,
            req.auth!.sub,
            storageKey,
            body.deferProcessing ? "queued" : "uploaded",
            body.identityReference ? "identity_reference" : "report_media",
            body.identityReference?.petId ?? null,
            body.identityReference?.sessionId ?? null,
            file.fileSizeBytes,
            file.width ?? null,
            file.height ?? null,
          ]
        );
        if (body.reportAssignment) {
          await client.query(
            `INSERT INTO photo_pet_links
               (organization_id, photo_id, pet_id, session_id, association_type, review_state, is_manually_adjusted)
             VALUES ($1, $2, $3, $4, 'manual', 'candidate', true)
             ON CONFLICT (photo_id, pet_id) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               review_state = CASE WHEN photo_pet_links.review_state = 'published' THEN 'published' ELSE 'candidate' END,
               is_manually_adjusted = true`,
            [orgId, photoResult.rows[0].id, body.reportAssignment.petId, body.reportAssignment.sessionId]
          );
        }
        const uploadUrl = await presignPutUrl(storageKey, file.contentType);
        results.push({ photoId: photoResult.rows[0].id, storageKey, uploadUrl });
      }
      await client.query(
        `UPDATE photo_batches SET photo_count = photo_count + $1 WHERE id = $2`,
        [body.files.length, body.batchId]
      );
      return results;
    });

    res.status(201).json(uploads);
  })
);

const confirmUploadSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fileSizeBytes: z.number().int().positive().max(MAX_PHOTO_UPLOAD_BYTES).optional(),
});

photosRouter.post(
  "/photos/:id/confirm-upload",
  asyncRoute(async (req, res) => {
    const body = confirmUploadSchema.parse(req.body);
    // Optimistic client signal only, purely for fast UI feedback — the real
    // pipeline trigger is the S3 event -> SQS path (see apps/worker), which
    // doesn't depend on this call ever arriving.
    const photo = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE photos SET width = COALESCE($1, width), height = COALESCE($2, height),
                file_size_bytes = COALESCE($3, file_size_bytes),
                processing_status = CASE WHEN processing_status = 'queued' THEN 'uploaded' ELSE processing_status END
         WHERE id = $4 AND organization_id = $5 AND deleted_at IS NULL RETURNING *`,
        [body.width, body.height, body.fileSizeBytes, req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!photo) throw new HttpError(404, "Photo not found");
    res.json(photo);
  })
);

photosRouter.get(
  "/photo-batches/:id",
  asyncRoute(async (req, res) => {
    const batch = await withOrgScope(req.auth!.organizationId, async (client) => {
      const batchResult = await client.query(
        `SELECT * FROM photo_batches WHERE id = $1 AND organization_id = $2`,
        [req.params.id, req.auth!.organizationId]
      );
      if (batchResult.rows.length === 0) return null;
      const statusResult = await client.query(
        `SELECT processing_status, count(*) FROM photos
         WHERE batch_id = $1 AND deleted_at IS NULL GROUP BY processing_status`,
        [req.params.id]
      );
      return { ...batchResult.rows[0], statusCounts: statusResult.rows };
    });
    if (!batch) throw new HttpError(404, "Batch not found");
    res.json(batch);
  })
);

// Mobile AI-assist review: expose the asynchronous processing state and the
// best identity suggested for each detected pet.  This endpoint deliberately
// returns low-confidence suggestions too, but labels them so the client can
// require an explicit staff check instead of silently accepting them.
photosRouter.get(
  "/photo-batches/:id/suggestions",
  asyncRoute(async (req, res) => {
    const batch = await withOrgScope(req.auth!.organizationId, async (client) => {
      const batchResult = await client.query(
        `SELECT id FROM photo_batches WHERE id = $1 AND organization_id = $2`,
        [req.params.id, req.auth!.organizationId]
      );
      if (batchResult.rows.length === 0) return null;

      const photoResult = await client.query(
        `SELECT id, processing_status, processing_error
         FROM photos
         WHERE batch_id = $1 AND organization_id = $2 AND deleted_at IS NULL
         ORDER BY created_at`,
        [req.params.id, req.auth!.organizationId]
      );
      const detectionResult = await client.query(
        `SELECT d.id AS detection_id, d.photo_id, d.matched_pet_id AS pet_id,
                d.matched_session_id AS session_id, d.match_confidence,
                d.match_status, d.detector_confidence, d.match_signals, p.name AS pet_name
         FROM photo_detections d
         LEFT JOIN pets p
           ON p.id = d.matched_pet_id AND p.organization_id = d.organization_id
         WHERE d.photo_id = ANY($1::uuid[]) AND d.organization_id = $2
         ORDER BY d.photo_id, d.match_confidence DESC NULLS LAST`,
        [photoResult.rows.map((photo) => photo.id), req.auth!.organizationId]
      );

      return {
        id: req.params.id,
        photos: photoResult.rows.map((photo) => ({
          id: photo.id,
          processingStatus: photo.processing_status,
          processingError: photo.processing_error,
          suggestions: detectionResult.rows
            .filter((detection) => detection.photo_id === photo.id && detection.pet_id && detection.session_id)
            .map((detection) => ({
              detectionId: detection.detection_id,
              petId: detection.pet_id,
              sessionId: detection.session_id,
              petName: detection.pet_name,
              confidence: detection.match_confidence === null ? null : Number(detection.match_confidence),
              detectorConfidence:
                detection.detector_confidence === null ? null : Number(detection.detector_confidence),
              secondaryLeashColorUsed: detection.match_signals?.leashColorAvailable === true,
              matchStatus: detection.match_status,
            })),
        })),
      };
    });
    if (!batch) throw new HttpError(404, "Batch not found");
    res.json(batch);
  })
);

// Current-appearance enrollment status for check-in. These rows are separate
// from report candidates and are safe to display to staff as reference-only.
photosRouter.get(
  "/sessions/:sessionId/identity-media",
  asyncRoute(async (req, res) => {
    const result = await withOrgScope(req.auth!.organizationId, async (client) => {
      const session = await client.query(
        `SELECT s.id, s.pet_id, p.name AS pet_name
         FROM sessions s JOIN pets p ON p.id = s.pet_id
         WHERE s.id = $1 AND s.organization_id = $2`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      if (!session.rows[0]) return null;
      const photos = await client.query(
        `SELECT ph.id, ph.processing_status, ph.processing_error, ph.thumbnail_key, ph.storage_key,
                ph.source_video_id, ph.capture_at, ph.uploaded_at,
                count(d.id)::int AS detected_pet_count,
                count(r.id)::int AS enrolled_embedding_count,
                max(d.quality_score) AS best_quality_score,
                max(d.detector_confidence) AS best_detector_confidence
         FROM photos ph
         LEFT JOIN photo_detections d ON d.photo_id = ph.id AND d.organization_id = ph.organization_id
           AND d.match_status <> 'manually_rejected'
         LEFT JOIN pet_reference_embeddings r ON r.source_detection_id = d.id AND r.is_active
         WHERE ph.reference_session_id = $1 AND ph.organization_id = $2
           AND ph.media_purpose = 'identity_reference'
           AND ph.identity_reference_removed_at IS NULL
           AND ph.deleted_at IS NULL
         GROUP BY ph.id
         ORDER BY ph.created_at DESC`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      const videos = await client.query(
        `SELECT id, processing_status, processing_error, extracted_frame_count, duration_seconds, uploaded_at
         FROM videos
         WHERE reference_session_id = $1 AND organization_id = $2
           AND media_purpose = 'identity_reference'
         ORDER BY uploaded_at DESC`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      return {
        session: session.rows[0],
        photos: await Promise.all(photos.rows.map(async (photo) => ({
          ...photo,
          viewUrl: await presignGetUrl(photo.thumbnail_key ?? photo.storage_key),
        }))),
        videos: videos.rows,
      };
    });
    if (!result) throw new HttpError(404, "Session not found");
    res.json(result);
  })
);

photosRouter.delete(
  "/identity-reference-photos/:id",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const orgId = req.auth!.organizationId;
    const removed = await withOrgScope(orgId, async (client) => {
      const photo = await client.query(
        `UPDATE photos
         SET identity_reference_removed_at = now(), identity_reference_removed_by = $1
         WHERE id = $2 AND organization_id = $3
           AND media_purpose = 'identity_reference'
           AND identity_reference_removed_at IS NULL
         RETURNING id`,
        [req.auth!.sub, req.params.id, orgId]
      );
      if (!photo.rows[0]) return null;

      const references = await client.query(
        `UPDATE pet_reference_embeddings r
         SET is_active = false
         FROM photo_detections d
         WHERE r.source_detection_id = d.id
           AND d.photo_id = $1
           AND r.organization_id = $2
           AND d.organization_id = $2
           AND r.is_active = true
         RETURNING r.id`,
        [req.params.id, orgId]
      );
      return { id: photo.rows[0].id, deactivatedEmbeddingCount: references.rowCount ?? 0 };
    });
    if (!removed) throw new HttpError(404, "Active identity reference not found");
    res.json(removed);
  })
);

photosRouter.post(
  "/identity-reference-photos/:id/promote-to-report",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const orgId = req.auth!.organizationId;
    const promoted = await withOrgScope(orgId, async (client) => {
      const sourceResult = await client.query(
        `SELECT ph.*
         FROM photos ph
         JOIN sessions s
           ON s.id = ph.reference_session_id
          AND s.organization_id = ph.organization_id
          AND s.pet_id = ph.reference_pet_id
         WHERE ph.id = $1 AND ph.organization_id = $2
           AND ph.media_purpose = 'identity_reference'
           AND ph.identity_reference_removed_at IS NULL
           AND ph.deleted_at IS NULL
           AND s.status <> 'cancelled'
         FOR UPDATE OF ph`,
        [req.params.id, orgId]
      );
      const source = sourceResult.rows[0];
      if (!source) return null;

      const existing = await client.query(
        `SELECT ph.id AS photo_id, l.id AS photo_link_id, l.review_state
         FROM photos ph
         JOIN photo_pet_links l
           ON l.photo_id = ph.id AND l.organization_id = ph.organization_id
         WHERE ph.organization_id = $1
           AND ph.source_identity_photo_id = $2
           AND ph.deleted_at IS NULL
           AND l.pet_id = $3 AND l.session_id = $4
         LIMIT 1`,
        [orgId, source.id, source.reference_pet_id, source.reference_session_id]
      );
      if (existing.rows[0]) return existing.rows[0];

      const photoResult = await client.query(
        `INSERT INTO photos
           (organization_id, batch_id, uploaded_by, storage_key, thumbnail_key,
            capture_at, uploaded_at, width, height, file_size_bytes,
            processing_status, media_purpose, source_video_id,
            source_identity_photo_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processed','report_media',$11,$12)
         RETURNING id`,
        [
          orgId, source.batch_id, source.uploaded_by, source.storage_key,
          source.thumbnail_key, source.capture_at, source.uploaded_at,
          source.width, source.height, source.file_size_bytes,
          source.source_video_id, source.id,
        ]
      );
      const reportPhotoId = photoResult.rows[0].id;

      const detectionResult = await client.query(
        `INSERT INTO photo_detections
           (photo_id, organization_id, bbox_x, bbox_y, bbox_width, bbox_height,
            crop_storage_key, detector_confidence, species_guess, embedding,
            quality_score, quality_metrics, accessory_attributes,
            matched_pet_id, matched_session_id, match_confidence, match_status,
            match_signals, embedding_model)
         SELECT $1, organization_id, bbox_x, bbox_y, bbox_width, bbox_height,
                crop_storage_key, detector_confidence, species_guess, embedding,
                quality_score, quality_metrics, accessory_attributes,
                $2, $3, 1, 'manually_assigned',
                jsonb_build_object('managerPromotedIdentityFrame', true), embedding_model
         FROM photo_detections
         WHERE photo_id = $4 AND organization_id = $5
           AND match_status <> 'manually_rejected'
         ORDER BY quality_score DESC NULLS LAST, detector_confidence DESC NULLS LAST
         LIMIT 1
         RETURNING id, quality_score`,
        [reportPhotoId, source.reference_pet_id, source.reference_session_id, source.id, orgId]
      );
      const detection = detectionResult.rows[0];
      const linkResult = await client.query(
        `INSERT INTO photo_pet_links
           (organization_id, photo_id, pet_id, session_id, source_detection_id,
            association_type, review_state, quality_score, is_manually_adjusted)
         VALUES ($1,$2,$3,$4,$5,'manual','candidate',$6,true)
         RETURNING id AS photo_link_id, review_state`,
        [
          orgId, reportPhotoId, source.reference_pet_id,
          source.reference_session_id, detection?.id ?? null,
          detection?.quality_score ?? null,
        ]
      );
      return { photo_id: reportPhotoId, ...linkResult.rows[0] };
    });

    if (!promoted) throw new HttpError(404, "Active identity reference not found");
    res.status(201).json(promoted);
  })
);

// Per-pet review screen (feature 5): candidate/pending/published/rejected photos for one stay.
photosRouter.get(
  "/sessions/:sessionId/photos",
  asyncRoute(async (req, res) => {
    const state = z
      .enum(["pending", "candidate", "rejected", "published"])
      .optional()
      .parse(req.query.state);

    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT l.*, p.storage_key, p.thumbnail_key
         FROM photo_pet_links l JOIN photos p
           ON p.id = l.photo_id AND p.organization_id = l.organization_id AND p.deleted_at IS NULL
         WHERE l.session_id = $1 AND l.organization_id = $2
           AND ($3::text IS NULL OR l.review_state = $3)
         ORDER BY l.quality_score DESC NULLS LAST`,
        [req.params.sessionId, req.auth!.organizationId, state ?? null]
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

// Org-wide low-confidence/unmatched queue staff triage manually.
photosRouter.get(
  "/photos/needs-review",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT d.*, p.storage_key, p.thumbnail_key
         FROM photo_detections d JOIN photos p
           ON p.id = d.photo_id AND p.organization_id = d.organization_id AND p.deleted_at IS NULL
         WHERE d.organization_id = $1 AND p.media_purpose = 'report_media'
           AND d.match_status IN ('low_confidence', 'no_match')
         ORDER BY d.created_at DESC LIMIT 100`,
        [req.auth!.organizationId]
      );
      return Promise.all(
        result.rows.map(async (row) => ({
          ...row,
          viewUrl: await presignGetUrl(row.crop_storage_key ?? row.thumbnail_key ?? row.storage_key),
        }))
      );
    });
    res.json(rows);
  })
);

const createLinkSchema = z.object({
  photoId: z.string().uuid(),
  petId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sourceDetectionId: z.string().uuid().optional(),
});

const confirmAssignmentsSchema = z.object({
  assignments: z
    .array(
      z.object({
        petId: z.string().uuid(),
        sessionId: z.string().uuid(),
        sourceDetectionId: z.string().uuid().optional(),
      })
    )
    .min(1)
    .max(20),
});

// Staff confirms the AI defaults (or their manual corrections) in one
// transaction. Existing unconfirmed automatic links that staff deselected are
// rejected, while published links remain immutable.
photosRouter.post(
  "/photos/:id/confirm-assignments",
  asyncRoute(async (req, res) => {
    const body = confirmAssignmentsSchema.parse(req.body);
    const orgId = req.auth!.organizationId;
    const uniqueAssignments = Array.from(
      new Map(body.assignments.map((assignment) => [assignment.petId, assignment])).values()
    );

    const links = await withOrgScope(orgId, async (client) => {
      const photo = await client.query(
        `SELECT id FROM photos WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [req.params.id, orgId]
      );
      if (photo.rows.length === 0) return null;

      const validSessions = await client.query(
        `SELECT id, pet_id
         FROM sessions
         WHERE organization_id = $1
           AND id = ANY($2::uuid[])
           AND status <> 'cancelled'`,
        [orgId, uniqueAssignments.map((assignment) => assignment.sessionId)]
      );
      const validPairs = new Set(validSessions.rows.map((row) => `${row.id}:${row.pet_id}`));
      if (
        uniqueAssignments.some(
          (assignment) => !validPairs.has(`${assignment.sessionId}:${assignment.petId}`)
        )
      ) {
        throw new HttpError(400, "One or more pet assignments are not valid active sessions");
      }

      const selectedPetIds = uniqueAssignments.map((assignment) => assignment.petId);
      await client.query(
        `UPDATE photo_pet_links
         SET review_state = 'rejected', is_manually_adjusted = true
         WHERE photo_id = $1 AND organization_id = $2
           AND review_state <> 'published'
           AND NOT (pet_id = ANY($3::uuid[]))`,
        [req.params.id, orgId, selectedPetIds]
      );
      await client.query(
        `UPDATE photo_detections
         SET match_status = 'manually_rejected'
         WHERE photo_id = $1 AND organization_id = $2
           AND matched_pet_id IS NOT NULL
           AND NOT (matched_pet_id = ANY($3::uuid[]))
           AND match_status IN ('matched', 'low_confidence')`,
        [req.params.id, orgId, selectedPetIds]
      );

      const confirmed = [];
      for (const assignment of uniqueAssignments) {
        let sourceDetectionId = assignment.sourceDetectionId;
        // Bootstrap a pet's reference corpus from a manually confirmed
        // single-pet photo. When there is exactly one selected pet and one
        // detected animal, the correspondence is unambiguous even if AI had
        // no prior reference with which to suggest an identity.
        if (!sourceDetectionId && uniqueAssignments.length === 1) {
          const soleDetection = await client.query(
            `SELECT id FROM photo_detections
             WHERE photo_id = $1 AND organization_id = $2
             ORDER BY detector_confidence DESC NULLS LAST
             LIMIT 2`,
            [req.params.id, orgId]
          );
          if (soleDetection.rows.length === 1) sourceDetectionId = soleDetection.rows[0].id;
        }

        const detection = sourceDetectionId
          ? await client.query(
              `SELECT matched_pet_id, embedding, embedding_model
               FROM photo_detections
               WHERE id = $1 AND photo_id = $2 AND organization_id = $3`,
              [sourceDetectionId, req.params.id, orgId]
            )
          : null;
        if (sourceDetectionId && detection?.rows.length === 0) {
          throw new HttpError(400, "AI suggestion does not belong to this photo");
        }

        const previousPetId = detection?.rows[0]?.matched_pet_id as string | null | undefined;
        const embedding = detection?.rows[0]?.embedding as string | null | undefined;
        const embeddingModel = detection?.rows[0]?.embedding_model as string | null | undefined;
        const result = await client.query(
          `INSERT INTO photo_pet_links
             (organization_id, photo_id, pet_id, session_id, source_detection_id,
              association_type, review_state, is_manually_adjusted)
           VALUES ($1, $2, $3, $4, $5, 'manual', 'candidate', true)
           ON CONFLICT (photo_id, pet_id) DO UPDATE SET
             session_id = EXCLUDED.session_id,
             source_detection_id = COALESCE(EXCLUDED.source_detection_id, photo_pet_links.source_detection_id),
             association_type = 'manual',
             review_state = CASE
               WHEN photo_pet_links.review_state = 'published' THEN 'published'
               ELSE 'candidate'
             END,
             is_manually_adjusted = true
           RETURNING *`,
          [orgId, req.params.id, assignment.petId, assignment.sessionId, sourceDetectionId]
        );
        confirmed.push(result.rows[0]);

        if (sourceDetectionId) {
          await client.query(
            `UPDATE photo_detections
             SET match_status = 'manually_assigned', matched_pet_id = $1, matched_session_id = $2
             WHERE id = $3 AND organization_id = $4`,
            [assignment.petId, assignment.sessionId, sourceDetectionId, orgId]
          );
          if (previousPetId && previousPetId !== assignment.petId) {
            await client.query(
              `INSERT INTO photo_match_corrections
                 (organization_id, photo_detection_id, previous_pet_id, corrected_pet_id, corrected_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [orgId, sourceDetectionId, previousPetId, assignment.petId, req.auth!.sub]
            );
          }
          if (embedding) {
            await client.query(
              `INSERT INTO pet_reference_embeddings
                 (organization_id, pet_id, source_type, source_detection_id, embedding, embedding_model)
               SELECT $1, $2, 'confirmed_session_photo', $3, $4, $5
               WHERE NOT EXISTS (
                 SELECT 1 FROM pet_reference_embeddings
                 WHERE organization_id = $1 AND pet_id = $2 AND source_detection_id = $3
               )`,
              [orgId, assignment.petId, sourceDetectionId, embedding, embeddingModel ?? "resnet18-imagenet-v1"]
            );
          }
        }
      }
      return confirmed;
    });

    if (!links) throw new HttpError(404, "Photo not found");
    res.json({ links });
  })
);

// Manual assign: crop/photo -> pet (used both for the review-queue triage flow
// and for fully-manual tagging before the ML pipeline exists, per plan §9 Phase 2).
photosRouter.post(
  "/photo-links",
  asyncRoute(async (req, res) => {
    const body = createLinkSchema.parse(req.body);
    const link = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO photo_pet_links
           (organization_id, photo_id, pet_id, session_id, source_detection_id,
            association_type, review_state, is_manually_adjusted)
         VALUES ($1, $2, $3, $4, $5, 'manual', 'candidate', true)
         ON CONFLICT (photo_id, pet_id) DO UPDATE SET
           source_detection_id = COALESCE(EXCLUDED.source_detection_id, photo_pet_links.source_detection_id),
           association_type = 'manual',
           review_state = CASE
             WHEN photo_pet_links.review_state = 'published' THEN 'published'
             ELSE 'candidate'
           END,
           is_manually_adjusted = true
         RETURNING *`,
        [req.auth!.organizationId, body.photoId, body.petId, body.sessionId, body.sourceDetectionId]
      );

      if (body.sourceDetectionId) {
        const detection = await client.query(
          `SELECT matched_pet_id, embedding, embedding_model FROM photo_detections WHERE id = $1 AND organization_id = $2`,
          [body.sourceDetectionId, req.auth!.organizationId]
        );
        const previousPetId = detection.rows[0]?.matched_pet_id as string | null | undefined;
        const embedding = detection.rows[0]?.embedding as string | null | undefined;
        const embeddingModel = detection.rows[0]?.embedding_model as string | null | undefined;

        await client.query(
          `UPDATE photo_detections SET match_status = 'manually_assigned', matched_pet_id = $1
           WHERE id = $2 AND organization_id = $3`,
          [body.petId, body.sourceDetectionId, req.auth!.organizationId]
        );

        // Every staff correction is a training signal for the re-id model (plan
        // §8 point 1) — recorded whenever the auto-suggested pet differs from
        // what staff actually picked, i.e. the pipeline got it wrong.
        if (previousPetId && previousPetId !== body.petId) {
          await client.query(
            `INSERT INTO photo_match_corrections
               (organization_id, photo_detection_id, previous_pet_id, corrected_pet_id, corrected_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.auth!.organizationId, body.sourceDetectionId, previousPetId, body.petId, req.auth!.sub]
          );
        }

        // Confirmed photos feed back into the pet's reference corpus (plan §3/§9
        // Phase 5), so match accuracy improves as a stay progresses.
        if (embedding) {
          await client.query(
            `INSERT INTO pet_reference_embeddings
               (organization_id, pet_id, source_type, source_detection_id, embedding, embedding_model)
             VALUES ($1, $2, 'confirmed_session_photo', $3, $4, $5)`,
            [req.auth!.organizationId, body.petId, body.sourceDetectionId, embedding, embeddingModel ?? "resnet18-imagenet-v1"]
          );
        }
      }

      return result.rows[0];
    });
    res.status(201).json(link);
  })
);

const updateLinkSchema = z.object({
  reviewState: z.enum(["pending", "candidate", "rejected", "published"]),
});

photosRouter.patch(
  "/photo-links/:id",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = updateLinkSchema.parse(req.body);
    // Once staff have explicitly promoted/demoted a photo, is_manually_adjusted
    // stops the background re-ranker from silently overriding that choice later.
    const link = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE photo_pet_links
         SET review_state = $1, is_manually_adjusted = true
         WHERE id = $2 AND organization_id = $3 AND review_state <> 'published'
         RETURNING *`,
        [body.reviewState, req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!link) throw new HttpError(404, "Photo link not found, or already published");
    res.json(link);
  })
);

const publishSchema = z.object({ photoLinkIds: z.array(z.string().uuid()).min(1) });

// Managers publish the reviewed/edited selection. Staff confirmation remains
// a candidate handoff and never makes media owner-visible by itself.
photosRouter.post(
  "/sessions/:sessionId/photos/publish",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = publishSchema.parse(req.body);
    const published = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE photo_pet_links
         SET review_state = 'published', published_at = now(), published_by = $1
         WHERE id = ANY($2::uuid[]) AND session_id = $3 AND organization_id = $4
           AND review_state <> 'rejected'
         RETURNING *`,
        [req.auth!.sub, body.photoLinkIds, req.params.sessionId, req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json({ publishedCount: published.length, photos: published });
  })
);
