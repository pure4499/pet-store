import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { withOrgScope } from "../db/pool.js";
import { presignGetUrl } from "../lib/s3.js";
import { loadPetAvatarUrls, petAvatarKey } from "../lib/petAvatar.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";

export const adminRouter = Router();
adminRouter.use("/admin", requireAuth, requireRole("owner_admin", "manager"));

adminRouter.get(
  "/admin/dashboard",
  asyncRoute(async (req, res) => {
    const dashboard = await withOrgScope(req.auth!.organizationId, async (client) => {
      const [organizationResult, statsResult, sessionsResult, mediaUsageResult] = await Promise.all([
        client.query(
          `SELECT o.id, o.name, o.slug, s.best_photo_count
           FROM organizations o
           JOIN organization_settings s ON s.organization_id = o.id
           WHERE o.id = $1`,
          [req.auth!.organizationId]
        ),
        client.query(
          `SELECT
             (SELECT count(*)::int FROM sessions
              WHERE organization_id = $1 AND status = 'active') AS active_sessions,
             (SELECT count(DISTINCT p.id)::int
             FROM photos p
             WHERE p.organization_id = $1
                AND p.media_purpose = 'report_media'
                AND p.deleted_at IS NULL
                AND (
                  EXISTS (
                    SELECT 1 FROM photo_pet_links l
                    JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
                    WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                  )
                  OR EXISTS (
                    SELECT 1 FROM photo_detections d
                    JOIN sessions s ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
                    WHERE d.photo_id = p.id AND d.organization_id = $1 AND s.status = 'active'
                  )
                  OR (
                    NOT EXISTS (
                      SELECT 1 FROM photo_pet_links l
                      WHERE l.photo_id = p.id AND l.organization_id = $1
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM photo_detections d
                      WHERE d.photo_id = p.id AND d.organization_id = $1
                        AND d.matched_session_id IS NOT NULL
                    )
                  )
                )
                AND (
                  p.processing_status IN ('uploaded', 'queued', 'processing', 'failed')
                  OR (
                    p.processing_status = 'processed'
                    AND NOT EXISTS (
                      SELECT 1 FROM photo_detections d
                      WHERE d.photo_id = p.id AND d.organization_id = $1
                    )
                  )
                  OR EXISTS (
                    SELECT 1 FROM photo_detections d
                    LEFT JOIN sessions s
                      ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
                    WHERE d.photo_id = p.id AND d.organization_id = $1 AND (
                      d.match_status = 'no_match'
                      OR (d.match_status = 'low_confidence' AND s.status = 'active')
                    )
                  )
                  OR EXISTS (
                    SELECT 1 FROM photo_pet_links l
                    JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
                    WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                      AND l.review_state IN ('pending', 'candidate')
                  )
                )) AS photos_to_review,
             (SELECT count(*)::int FROM photo_pet_links
              WHERE organization_id = $1 AND review_state = 'published'
                AND published_at::date = current_date) AS photos_published_today,
             (SELECT count(*)::int FROM video_pet_links
              WHERE organization_id = $1 AND review_state = 'candidate') AS videos_to_review,
             (SELECT count(*)::int FROM report_video_drafts
              WHERE organization_id = $1 AND status = 'ready') AS videos_ready_to_approve`,
          [req.auth!.organizationId]
        ),
        client.query(
          `SELECT s.id AS session_id, s.pet_id, s.session_type, s.check_in_at,
                  s.expected_check_out_at, p.name AS pet_name, p.species, p.breed,
                  count(DISTINCT l.id) FILTER (WHERE l.review_state = 'candidate')::int AS candidate_photo_count,
                  count(DISTINCT l.id) FILTER (WHERE l.review_state = 'published')::int AS published_photo_count,
                  count(DISTINCT vl.id) FILTER (WHERE vl.review_state = 'candidate')::int AS candidate_video_count,
                  count(DISTINCT log.id) FILTER (WHERE log.entry_at::date = current_date)::int AS logs_today,
                  max(COALESCE(ph.capture_at, ph.uploaded_at)) AS latest_photo_at
           FROM sessions s
           JOIN pets p ON p.id = s.pet_id AND p.organization_id = s.organization_id
           LEFT JOIN photo_pet_links l
             ON l.session_id = s.id AND l.organization_id = s.organization_id
           LEFT JOIN photos ph ON ph.id = l.photo_id
             AND ph.organization_id = s.organization_id AND ph.deleted_at IS NULL
           LEFT JOIN video_pet_links vl
             ON vl.session_id = s.id AND vl.organization_id = s.organization_id
           LEFT JOIN daily_log_entries log
             ON log.session_id = s.id AND log.organization_id = s.organization_id
           WHERE s.organization_id = $1 AND s.status = 'active'
           GROUP BY s.id, p.id
           ORDER BY s.check_in_at DESC`,
          [req.auth!.organizationId]
        ),
        client.query(
          `SELECT
             COALESCE((SELECT sum(file_size_bytes) FROM photos WHERE organization_id = $1), 0)::text AS photo_bytes,
             COALESCE((SELECT sum(file_size_bytes) FROM videos WHERE organization_id = $1), 0)::text AS video_bytes,
             (SELECT count(*)::int FROM photos WHERE organization_id = $1) AS photo_count,
             (SELECT count(*)::int FROM videos WHERE organization_id = $1) AS video_count,
             settings.media_storage_limit_bytes::text AS storage_limit_bytes
           FROM organization_settings settings
           WHERE settings.organization_id = $1`,
          [req.auth!.organizationId]
        ),
      ]);

      const usage = mediaUsageResult.rows[0];
      const photoBytes = Number(usage?.photo_bytes ?? 0);
      const videoBytes = Number(usage?.video_bytes ?? 0);

      const avatarUrls = await loadPetAvatarUrls(client, req.auth!.organizationId, sessionsResult.rows.map((row) => ({ petId: row.pet_id, sessionId: row.session_id })));
      return {
        organization: organizationResult.rows[0],
        stats: statsResult.rows[0],
        sessions: sessionsResult.rows.map((row) => ({ ...row, photo_thumbnail_url: avatarUrls.get(petAvatarKey(row.pet_id, row.session_id)) ?? null })),
        mediaUsage: {
          photoBytes,
          videoBytes,
          totalBytes: photoBytes + videoBytes,
          photoCount: Number(usage?.photo_count ?? 0),
          videoCount: Number(usage?.video_count ?? 0),
          storageLimitBytes: Number(usage?.storage_limit_bytes ?? 0),
        },
      };
    });
    res.json(dashboard);
  })
);

const reviewFilterSchema = z.enum(["review", "candidate", "unmatched", "failed", "published", "all"]);
const finalSelectionSchema = z.object({
  selectedPhotoLinkIds: z.array(z.string().uuid()).max(100),
});
const deletePhotoSchema = z.object({
  reason: z.string().trim().min(1).max(240).default("Deleted by manager"),
});

adminRouter.get(
  "/admin/photos",
  asyncRoute(async (req, res) => {
    const filter = reviewFilterSchema.default("review").parse(req.query.filter);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
    const batchId = z.string().uuid().optional().parse(req.query.batchId);
    const orgId = req.auth!.organizationId;

    const result = await withOrgScope(orgId, async (client) => {
      const photosResult = await client.query(
        `SELECT p.id, p.batch_id, p.processing_status, p.processing_error,
                p.capture_at, p.uploaded_at, p.width, p.height, p.storage_key, p.thumbnail_key,
                u.full_name AS uploaded_by_name
         FROM photos p
         JOIN users u ON u.id = p.uploaded_by AND u.organization_id = p.organization_id
         WHERE p.organization_id = $1
           AND p.media_purpose = 'report_media'
           AND p.deleted_at IS NULL
           AND ($4::uuid IS NULL OR p.batch_id = $4)
           AND (
             EXISTS (
               SELECT 1 FROM photo_pet_links l
               JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
               WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
             )
             OR EXISTS (
               SELECT 1 FROM photo_detections d
               JOIN sessions s ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
               WHERE d.photo_id = p.id AND d.organization_id = $1 AND s.status = 'active'
             )
             OR (
               NOT EXISTS (
                 SELECT 1 FROM photo_pet_links l
                 WHERE l.photo_id = p.id AND l.organization_id = $1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM photo_detections d
                 WHERE d.photo_id = p.id AND d.organization_id = $1
                   AND d.matched_session_id IS NOT NULL
               )
             )
           )
           AND CASE $2::text
             WHEN 'review' THEN
               p.processing_status IN ('uploaded', 'queued', 'processing', 'failed')
               OR (
                 p.processing_status = 'processed'
                 AND NOT EXISTS (
                   SELECT 1 FROM photo_detections d
                   WHERE d.photo_id = p.id AND d.organization_id = $1
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM photo_detections d
                 LEFT JOIN sessions s
                   ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
                 WHERE d.photo_id = p.id AND d.organization_id = $1 AND (
                   d.match_status = 'no_match'
                   OR (d.match_status = 'low_confidence' AND s.status = 'active')
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM photo_pet_links l
                 JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
                 WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                   AND l.review_state IN ('pending', 'candidate')
               )
             WHEN 'candidate' THEN EXISTS (
               SELECT 1 FROM photo_pet_links l
               JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
               WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                 AND l.review_state IN ('pending', 'candidate')
             )
             WHEN 'unmatched' THEN
               (
                 p.processing_status = 'processed'
                 AND NOT EXISTS (
                   SELECT 1 FROM photo_detections d
                   WHERE d.photo_id = p.id AND d.organization_id = $1
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM photo_detections d
                 LEFT JOIN sessions s
                   ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
                 WHERE d.photo_id = p.id AND d.organization_id = $1 AND (
                   d.match_status = 'no_match'
                   OR (d.match_status = 'low_confidence' AND s.status = 'active')
                 )
               )
             WHEN 'failed' THEN p.processing_status = 'failed'
             WHEN 'published' THEN EXISTS (
               SELECT 1 FROM photo_pet_links l
               JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
               WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                 AND l.review_state = 'published'
             )
             ELSE true
           END
         ORDER BY COALESCE(p.capture_at, p.uploaded_at) DESC
         LIMIT $3`,
        [orgId, filter, limit, batchId ?? null]
      );

      const photos = [];
      for (const photo of photosResult.rows) {
        const [detectionsResult, linksResult] = await Promise.all([
          client.query(
            `SELECT d.id, d.bbox_x, d.bbox_y, d.bbox_width, d.bbox_height,
                    d.crop_storage_key, d.detector_confidence, d.species_guess,
                    d.quality_score, d.matched_pet_id, d.matched_session_id,
                    d.match_confidence, d.match_status, d.match_signals,
                    p.name AS matched_pet_name
             FROM photo_detections d
             LEFT JOIN sessions s
               ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
             LEFT JOIN pets p
               ON p.id = d.matched_pet_id AND p.organization_id = d.organization_id
             WHERE d.photo_id = $1 AND d.organization_id = $2
               AND (d.matched_session_id IS NULL OR s.status = 'active')
             ORDER BY d.detector_confidence DESC NULLS LAST, d.created_at DESC`,
            [photo.id, orgId]
          ),
          client.query(
            `SELECT l.id, l.pet_id, l.session_id, l.source_detection_id,
                    l.association_type, l.review_state, l.quality_score,
                    l.is_manually_adjusted, l.published_at, p.name AS pet_name
             FROM photo_pet_links l
             JOIN pets p ON p.id = l.pet_id AND p.organization_id = l.organization_id
             JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
             WHERE l.photo_id = $1 AND l.organization_id = $2 AND s.status = 'active'
             ORDER BY p.name`,
            [photo.id, orgId]
          ),
        ]);

        photos.push({
          ...photo,
          viewUrl: await presignGetUrl(photo.thumbnail_key ?? photo.storage_key),
          detections: await Promise.all(
            detectionsResult.rows.map(async (detection) => ({
              ...detection,
              cropUrl: detection.crop_storage_key
                ? await presignGetUrl(detection.crop_storage_key)
                : null,
            }))
          ),
          links: linksResult.rows,
        });
      }

      return { filter, photos };
    });

    res.json(result);
  })
);

adminRouter.get(
  "/admin/sessions/:id/workspace",
  asyncRoute(async (req, res) => {
    const orgId = req.auth!.organizationId;
    const workspace = await withOrgScope(orgId, async (client) => {
      const sessionResult = await client.query(
        `SELECT s.*, p.name AS pet_name, p.species, p.breed,
                o.full_name AS owner_name, o.email AS owner_email, o.phone AS owner_phone,
                checked_in_by.full_name AS checked_in_by_name,
                collar.color_name AS collar_color_name, collar.color_hex AS collar_color_hex
         FROM sessions s
         JOIN pets p ON p.id = s.pet_id AND p.organization_id = s.organization_id
         LEFT JOIN owners o ON o.id = p.owner_id AND o.organization_id = p.organization_id
         LEFT JOIN users checked_in_by
           ON checked_in_by.id = s.checked_in_by AND checked_in_by.organization_id = s.organization_id
         LEFT JOIN organization_collar_palette collar
           ON collar.id = s.collar_palette_id AND collar.organization_id = s.organization_id
         WHERE s.id = $1 AND s.organization_id = $2`,
        [req.params.id, orgId]
      );
      if (!sessionResult.rows[0]) return null;

      const [photosResult, videosResult, logsResult, reportsResult] = await Promise.all([
        client.query(
          `SELECT l.*, ph.storage_key, ph.thumbnail_key, ph.capture_at, ph.uploaded_at,
                  ph.source_identity_photo_id,
                  ph.width, ph.height,
                  hero.bbox_x AS hero_bbox_x, hero.bbox_y AS hero_bbox_y,
                  hero.bbox_width AS hero_bbox_width, hero.bbox_height AS hero_bbox_height,
                  hero.detector_confidence AS hero_detector_confidence,
                  (SELECT count(*)::int FROM photo_detections all_d
                   WHERE all_d.photo_id = ph.id AND all_d.organization_id = ph.organization_id
                     AND all_d.match_status <> 'manually_rejected') AS detected_pet_count
           FROM photo_pet_links l
           JOIN photos ph ON ph.id = l.photo_id
             AND ph.organization_id = l.organization_id AND ph.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT d.bbox_x, d.bbox_y, d.bbox_width, d.bbox_height, d.detector_confidence
             FROM photo_detections d
             WHERE d.photo_id = ph.id AND d.organization_id = l.organization_id
               AND (
                 d.id = l.source_detection_id
                 OR (l.source_detection_id IS NULL AND d.matched_pet_id = l.pet_id)
               )
             ORDER BY (d.id = l.source_detection_id) DESC, d.quality_score DESC NULLS LAST
             LIMIT 1
           ) hero ON true
           WHERE l.session_id = $1 AND l.organization_id = $2
           ORDER BY l.quality_score DESC NULLS LAST, ph.uploaded_at DESC`,
          [req.params.id, orgId]
        ),
        client.query(
          `SELECT l.*, v.storage_key, v.capture_at, v.uploaded_at,
                  v.duration_seconds, v.content_type
           FROM video_pet_links l
           JOIN videos v ON v.id = l.video_id
           WHERE l.session_id = $1 AND l.organization_id = $2
           ORDER BY v.uploaded_at DESC`,
          [req.params.id, orgId]
        ),
        client.query(
          `SELECT log.*, users.full_name AS created_by_name
           FROM daily_log_entries log
           LEFT JOIN users ON users.id = log.created_by AND users.organization_id = log.organization_id
           WHERE log.session_id = $1 AND log.organization_id = $2
           ORDER BY log.entry_at DESC`,
          [req.params.id, orgId]
        ),
        client.query(
          `SELECT report.*,
                  ARRAY(
                    SELECT item.photo_id
                    FROM report_video_items item
                    WHERE item.report_video_id = report.id
                      AND item.organization_id = report.organization_id
                      AND item.item_type = 'photo' AND item.photo_id IS NOT NULL
                    ORDER BY item.sort_order
                  ) AS photo_ids
           FROM report_video_drafts report
           WHERE report.session_id = $1 AND report.organization_id = $2
           ORDER BY report.created_at DESC`,
          [req.params.id, orgId]
        ),
      ]);

      const avatarUrls = await loadPetAvatarUrls(client, orgId, [{ petId: sessionResult.rows[0].pet_id, sessionId: sessionResult.rows[0].id }]);
      return {
        session: { ...sessionResult.rows[0], photo_thumbnail_url: avatarUrls.get(petAvatarKey(sessionResult.rows[0].pet_id, sessionResult.rows[0].id)) ?? null },
        photos: await Promise.all(
          photosResult.rows.map(async (row) => ({
            ...row,
            viewUrl: await presignGetUrl(row.thumbnail_key ?? row.storage_key),
          }))
        ),
        videos: await Promise.all(
          videosResult.rows.map(async (row) => ({
            ...row,
            viewUrl: await presignGetUrl(row.storage_key),
          }))
        ),
        logs: logsResult.rows,
        reports: await Promise.all(
            reportsResult.rows.map(async (row) => ({
              ...row,
              previewUrl: row.output_storage_key ? await presignGetUrl(row.output_storage_key) : null,
              shareUrl: row.public_share_token ? `${config.publicReportBaseUrl}/${row.public_share_token}` : null,
            }))
        ),
      };
    });

    if (!workspace) throw new HttpError(404, "Session not found");
    res.json(workspace);
  })
);

// Save the manager's entire unpublished selection in one transaction. Selected
// links become owner-visible and every unselected pending/candidate link is
// explicitly excluded. Existing published links remain immutable here.
adminRouter.post(
  "/admin/sessions/:id/photos/finalize-selection",
  asyncRoute(async (req, res) => {
    const body = finalSelectionSchema.parse(req.body);
    const orgId = req.auth!.organizationId;
    const result = await withOrgScope(orgId, async (client) => {
      const session = await client.query(
        `SELECT id FROM sessions WHERE id = $1 AND organization_id = $2`,
        [req.params.id, orgId]
      );
      if (!session.rows[0]) return null;

      const reviewable = await client.query(
        `SELECT l.id
         FROM photo_pet_links l
         JOIN photos p ON p.id = l.photo_id AND p.organization_id = l.organization_id
         WHERE l.session_id = $1 AND l.organization_id = $2
           AND l.review_state IN ('pending', 'candidate')
           AND p.deleted_at IS NULL
         FOR UPDATE OF l`,
        [req.params.id, orgId]
      );
      const reviewableIds = new Set(reviewable.rows.map((row) => row.id as string));
      if (body.selectedPhotoLinkIds.some((id) => !reviewableIds.has(id))) {
        throw new HttpError(400, "Selection contains a photo that is not available for review");
      }

      const published = body.selectedPhotoLinkIds.length
        ? await client.query(
            `UPDATE photo_pet_links
             SET review_state = 'published', published_at = now(), published_by = $1,
                 is_manually_adjusted = true
             WHERE id = ANY($2::uuid[]) AND session_id = $3 AND organization_id = $4
               AND review_state IN ('pending', 'candidate')
             RETURNING id`,
            [req.auth!.sub, body.selectedPhotoLinkIds, req.params.id, orgId]
          )
        : { rowCount: 0 };
      const excluded = await client.query(
        `UPDATE photo_pet_links
         SET review_state = 'rejected', is_manually_adjusted = true
         WHERE session_id = $1 AND organization_id = $2
           AND review_state IN ('pending', 'candidate')
           AND NOT (id = ANY($3::uuid[]))
         RETURNING id`,
        [req.params.id, orgId, body.selectedPhotoLinkIds]
      );
      return {
        publishedCount: published.rowCount ?? 0,
        excludedCount: excluded.rowCount ?? 0,
      };
    });
    if (!result) throw new HttpError(404, "Session not found");
    res.json(result);
  })
);

// This exceptional manager operation can remove even published media. It is a
// recoverable soft delete: owner galleries and all active product queries hide
// the photo immediately, while audit data and object bytes remain retained.
adminRouter.delete(
  "/admin/photos/:id",
  asyncRoute(async (req, res) => {
    const body = deletePhotoSchema.parse(req.body ?? {});
    const orgId = req.auth!.organizationId;
    const result = await withOrgScope(orgId, async (client) => {
      const photo = await client.query(
        `UPDATE photos
         SET deleted_at = now(), deleted_by = $1, deletion_reason = $2
         WHERE id = $3 AND organization_id = $4
           AND media_purpose = 'report_media' AND deleted_at IS NULL
         RETURNING id`,
        [req.auth!.sub, body.reason, req.params.id, orgId]
      );
      if (!photo.rows[0]) return null;

      const links = await client.query(
        `UPDATE photo_pet_links
         SET review_state = 'rejected', is_manually_adjusted = true
         WHERE photo_id = $1 AND organization_id = $2
         RETURNING published_at IS NOT NULL AS was_published`,
        [req.params.id, orgId]
      );
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
      return {
        id: req.params.id,
        removedLinkCount: links.rowCount ?? 0,
        removedFromOwnerView: links.rows.some((row) => row.was_published),
        deactivatedEmbeddingCount: references.rowCount ?? 0,
      };
    });
    if (!result) throw new HttpError(404, "Active uploaded photo not found");
    res.json(result);
  })
);

adminRouter.post(
  "/admin/photos/reprocess-all",
  asyncRoute(async (req, res) => {
    const filter = z.enum(["review", "unmatched", "failed", "all"]).parse(req.body?.filter);
    const orgId = req.auth!.organizationId;
    const queuedCount = await withOrgScope(orgId, async (client) => {
      const targets = await client.query(
        `SELECT p.id
         FROM photos p
         WHERE p.organization_id = $1
           AND p.media_purpose = 'report_media'
           AND p.deleted_at IS NULL
           AND p.processing_status IN ('processed', 'failed')
           AND (
             EXISTS (
               SELECT 1 FROM photo_pet_links l
               JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
               WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
             )
             OR EXISTS (
               SELECT 1 FROM photo_detections d
               JOIN sessions s ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
               WHERE d.photo_id = p.id AND d.organization_id = $1 AND s.status = 'active'
             )
             OR (
               NOT EXISTS (
                 SELECT 1 FROM photo_pet_links l
                 WHERE l.photo_id = p.id AND l.organization_id = $1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM photo_detections d
                 WHERE d.photo_id = p.id AND d.organization_id = $1
                   AND d.matched_session_id IS NOT NULL
               )
             )
           )
           AND CASE $2::text
             WHEN 'review' THEN
               p.processing_status = 'failed'
               OR EXISTS (
                 SELECT 1 FROM photo_detections d
                 LEFT JOIN sessions s
                   ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
                 WHERE d.photo_id = p.id AND d.organization_id = $1 AND (
                   d.match_status = 'no_match'
                   OR (d.match_status = 'low_confidence' AND s.status = 'active')
                 )
               )
               OR EXISTS (
                 SELECT 1 FROM photo_pet_links l
                 JOIN sessions s ON s.id = l.session_id AND s.organization_id = l.organization_id
                 WHERE l.photo_id = p.id AND l.organization_id = $1 AND s.status = 'active'
                   AND l.review_state IN ('pending', 'candidate')
               )
             WHEN 'unmatched' THEN EXISTS (
               SELECT 1 FROM photo_detections d
               LEFT JOIN sessions s
                 ON s.id = d.matched_session_id AND s.organization_id = d.organization_id
               WHERE d.photo_id = p.id AND d.organization_id = $1 AND (
                 d.match_status = 'no_match'
                 OR (d.match_status = 'low_confidence' AND s.status = 'active')
               )
             )
             WHEN 'failed' THEN p.processing_status = 'failed'
             ELSE true
           END`,
        [orgId, filter]
      );
      const photoIds = targets.rows.map((row) => row.id as string);
      if (!photoIds.length) return 0;

      await client.query(
        `DELETE FROM photo_pet_links
         WHERE organization_id = $1 AND photo_id = ANY($2::uuid[])
           AND review_state <> 'published' AND is_manually_adjusted = false`,
        [orgId, photoIds]
      );
      await client.query(
        `UPDATE photo_detections
         SET match_status = 'manually_rejected'
         WHERE organization_id = $1 AND photo_id = ANY($2::uuid[])
           AND match_status IN ('pending', 'matched', 'low_confidence', 'no_match')`,
        [orgId, photoIds]
      );
      const updated = await client.query(
        `UPDATE photos
         SET processing_status = 'uploaded', processing_error = NULL
         WHERE organization_id = $1 AND id = ANY($2::uuid[])
         RETURNING id`,
        [orgId, photoIds]
      );
      return updated.rowCount ?? 0;
    });
    res.status(202).json({ queuedCount });
  })
);

adminRouter.post(
  "/admin/photos/:id/reprocess",
  asyncRoute(async (req, res) => {
    const orgId = req.auth!.organizationId;
    const photo = await withOrgScope(orgId, async (client) => {
      const existing = await client.query(
        `SELECT id FROM photos WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [req.params.id, orgId]
      );
      if (!existing.rows[0]) return null;

      // Keep published and human-adjusted links immutable. Only supersede the
      // prior machine result so a new worker pass can use the latest reference
      // embeddings without discarding manager corrections.
      await client.query(
        `DELETE FROM photo_pet_links
         WHERE photo_id = $1 AND organization_id = $2
           AND review_state <> 'published' AND is_manually_adjusted = false`,
        [req.params.id, orgId]
      );
      await client.query(
        `UPDATE photo_detections
         SET match_status = 'manually_rejected'
         WHERE photo_id = $1 AND organization_id = $2
           AND match_status IN ('pending', 'matched', 'low_confidence', 'no_match')`,
        [req.params.id, orgId]
      );
      const updated = await client.query(
        `UPDATE photos
         SET processing_status = 'uploaded', processing_error = NULL
         WHERE id = $1 AND organization_id = $2
         RETURNING id, processing_status, processing_error`,
        [req.params.id, orgId]
      );
      return updated.rows[0];
    });

    if (!photo) throw new HttpError(404, "Photo not found");
    res.status(202).json(photo);
  })
);

adminRouter.post(
  "/admin/photos/:id/reject",
  asyncRoute(async (req, res) => {
    const orgId = req.auth!.organizationId;
    const result = await withOrgScope(orgId, async (client) => {
      const photo = await client.query(
        `SELECT id FROM photos WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [req.params.id, orgId]
      );
      if (!photo.rows[0]) return null;

      const links = await client.query(
        `UPDATE photo_pet_links
         SET review_state = 'rejected', is_manually_adjusted = true
         WHERE photo_id = $1 AND organization_id = $2 AND review_state <> 'published'
         RETURNING id`,
        [req.params.id, orgId]
      );
      const detections = await client.query(
        `UPDATE photo_detections
         SET match_status = 'manually_rejected'
         WHERE photo_id = $1 AND organization_id = $2
           AND match_status <> 'manually_assigned'
         RETURNING id`,
        [req.params.id, orgId]
      );
      return { photoId: req.params.id, rejectedLinks: links.rowCount, rejectedDetections: detections.rowCount };
    });

    if (!result) throw new HttpError(404, "Photo not found");
    res.json(result);
  })
);
