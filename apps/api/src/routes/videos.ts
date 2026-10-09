import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { MAX_SOURCE_VIDEO_DURATION_SECONDS } from "@ucbarkley/shared-types";
import { withOrgScope } from "../db/pool.js";
import { presignGetUrl, presignPutUrl } from "../lib/s3.js";
import { currentSourceMediaBytes, MAX_VIDEO_UPLOAD_BYTES } from "../lib/mediaLimits.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";

export const videosRouter = Router();
videosRouter.use(requireAuth);

const uploadSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.enum(["video/mp4", "video/quicktime"]),
  fileSizeBytes: z.number().int().positive().max(MAX_VIDEO_UPLOAD_BYTES),
  durationSeconds: z.number().positive().max(
    MAX_SOURCE_VIDEO_DURATION_SECONDS,
    `Videos must be ${MAX_SOURCE_VIDEO_DURATION_SECONDS} seconds or shorter`
  ).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  identityReference: z.object({
    petId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }).optional(),
  reportAssignment: z.object({
    petId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }).optional(),
}).superRefine((body, context) => {
  if (body.identityReference && body.reportAssignment) {
    context.addIssue({
      code: "custom",
      message: "An upload cannot be both identity reference and report media",
    });
  }
});

videosRouter.post(
  "/videos/upload-url",
  asyncRoute(async (req, res) => {
    const body = uploadSchema.parse(req.body);
    const orgId = req.auth!.organizationId;
    const storageKey = `raw-videos/${orgId}/${randomUUID()}-${body.fileName}`;
    const video = await withOrgScope(orgId, async (client) => {
      const settings = await client.query(
        `SELECT media_storage_limit_bytes::text AS bytes
         FROM organization_settings WHERE organization_id = $1`,
        [orgId]
      );
      const usedBytes = await currentSourceMediaBytes(client, orgId);
      if (usedBytes + body.fileSizeBytes > Number(settings.rows[0]?.bytes ?? 0)) {
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
      const result = await client.query(
        `INSERT INTO videos
           (organization_id, uploaded_by, storage_key, content_type, duration_seconds, width, height,
            media_purpose, reference_pet_id, reference_session_id, processing_status, file_size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, storage_key`,
        [
          orgId,
          req.auth!.sub,
          storageKey,
          body.contentType,
          body.durationSeconds,
          body.width,
          body.height,
          body.identityReference ? "identity_reference" : "report_media",
          body.identityReference?.petId ?? null,
          body.identityReference?.sessionId ?? null,
          body.identityReference ? "queued" : "processed",
          body.fileSizeBytes,
        ]
      );
      if (body.reportAssignment) {
        await client.query(
          `INSERT INTO video_pet_links
             (organization_id, video_id, pet_id, session_id, association_type, review_state, is_manually_adjusted)
           VALUES ($1, $2, $3, $4, 'manual', 'candidate', true)
           ON CONFLICT (video_id, pet_id) DO UPDATE SET
             session_id = EXCLUDED.session_id,
             review_state = CASE WHEN video_pet_links.review_state = 'published' THEN 'published' ELSE 'candidate' END,
             is_manually_adjusted = true`,
          [orgId, result.rows[0].id, body.reportAssignment.petId, body.reportAssignment.sessionId]
        );
      }
      return result.rows[0];
    });
    res.status(201).json({
      videoId: video.id,
      storageKey: video.storage_key,
      uploadUrl: await presignPutUrl(storageKey, body.contentType),
    });
  })
);

const confirmSchema = z.object({
  fileSizeBytes: z.number().int().positive().max(MAX_VIDEO_UPLOAD_BYTES).optional(),
});

videosRouter.post(
  "/videos/:id/confirm-upload",
  asyncRoute(async (req, res) => {
    const body = confirmSchema.parse(req.body);
    const video = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE videos SET file_size_bytes = COALESCE($1, file_size_bytes),
                           processing_status = CASE WHEN processing_status = 'queued' THEN 'uploaded' ELSE processing_status END
         WHERE id = $2 AND organization_id = $3 RETURNING *`,
        [body.fileSizeBytes, req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!video) throw new HttpError(404, "Video not found");
    res.json(video);
  })
);

const linkSchema = z.object({
  videoId: z.string().uuid(),
  petId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

videosRouter.post(
  "/video-links",
  asyncRoute(async (req, res) => {
    const body = linkSchema.parse(req.body);
    const link = await withOrgScope(req.auth!.organizationId, async (client) => {
      const valid = await client.query(
        `SELECT 1
         FROM videos v JOIN sessions s ON s.id = $2
         WHERE v.id = $1 AND v.organization_id = $3
           AND s.organization_id = $3 AND s.pet_id = $4`,
        [body.videoId, body.sessionId, req.auth!.organizationId, body.petId]
      );
      if (valid.rows.length === 0) throw new HttpError(400, "Video, pet, or session does not match");

      const result = await client.query(
        `INSERT INTO video_pet_links
           (organization_id, video_id, pet_id, session_id, association_type, review_state, is_manually_adjusted)
         VALUES ($1, $2, $3, $4, 'manual', 'candidate', true)
         ON CONFLICT (video_id, pet_id) DO UPDATE SET
           session_id = EXCLUDED.session_id,
           review_state = CASE WHEN video_pet_links.review_state = 'published' THEN 'published' ELSE 'candidate' END,
           is_manually_adjusted = true
         RETURNING *`,
        [req.auth!.organizationId, body.videoId, body.petId, body.sessionId]
      );
      return result.rows[0];
    });
    res.status(201).json(link);
  })
);

videosRouter.get(
  "/sessions/:sessionId/videos",
  asyncRoute(async (req, res) => {
    const state = z.enum(["candidate", "rejected", "published"]).optional().parse(req.query.state);
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT l.*, v.storage_key, v.duration_seconds, v.width, v.height, v.content_type
         FROM video_pet_links l JOIN videos v ON v.id = l.video_id
         WHERE l.session_id = $1 AND l.organization_id = $2
           AND ($3::text IS NULL OR l.review_state = $3)
         ORDER BY v.uploaded_at DESC`,
        [req.params.sessionId, req.auth!.organizationId, state ?? null]
      );
      return Promise.all(result.rows.map(async (row) => ({ ...row, viewUrl: await presignGetUrl(row.storage_key) })));
    });
    res.json(rows);
  })
);

const reviewSchema = z.object({ reviewState: z.enum(["candidate", "rejected"]) });

videosRouter.patch(
  "/video-links/:id",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = reviewSchema.parse(req.body);
    const link = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE video_pet_links SET review_state = $1, is_manually_adjusted = true
         WHERE id = $2 AND organization_id = $3 AND review_state <> 'published'
         RETURNING *`,
        [body.reviewState, req.params.id, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!link) throw new HttpError(404, "Video link not found, or already published");
    res.json(link);
  })
);

const publishSchema = z.object({ videoLinkIds: z.array(z.string().uuid()).min(1) });

videosRouter.post(
  "/sessions/:sessionId/videos/publish",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = publishSchema.parse(req.body);
    const published = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE video_pet_links
         SET review_state = 'published', published_at = now(), published_by = $1
         WHERE id = ANY($2::uuid[]) AND session_id = $3 AND organization_id = $4
           AND review_state <> 'rejected'
         RETURNING *`,
        [req.auth!.sub, body.videoLinkIds, req.params.sessionId, req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json({ publishedCount: published.length, videos: published });
  })
);
