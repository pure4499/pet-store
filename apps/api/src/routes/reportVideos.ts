import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { withOrgScope } from "../db/pool.js";
import { isEmailDeliveryConfigured, renderReportShareEmailHtml, sendEmail } from "../lib/email.js";
import { generateReportStory } from "../lib/reportStory.js";
import { promoteIdentityPhotoToReport } from "../lib/promoteIdentityPhoto.js";
import { deleteObject, presignGetUrl } from "../lib/s3.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";

export const reportVideosRouter = Router();
reportVideosRouter.use("/report-videos", requireAuth, requireRole("owner_admin", "manager"));

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportThemeSchema = z.enum(["storybook", "timeline_diary", "care_card", "photo_journal", "postcard"]);
const reportMusicStyleSchema = z.enum(["none", "warm_story", "day_in_motion", "gentle_care", "dreamy_memories", "sunny_postcard"]);
const reportVisualStyleSchema = z.enum(["clean", "sticker_dots", "cartoon_title"]);
const reportMediaWindowSchema = z.enum(["report_day", "last_2_days", "last_3_days", "full_stay"]);
const defaultMusicByTheme: Record<z.infer<typeof reportThemeSchema>, z.infer<typeof reportMusicStyleSchema>> = {
  storybook: "warm_story",
  timeline_diary: "day_in_motion",
  care_card: "gentle_care",
  photo_journal: "dreamy_memories",
  postcard: "sunny_postcard",
};
const createSchema = z.object({
  reportDate: dateSchema.optional(),
  mediaWindow: reportMediaWindowSchema.default("report_day"),
  title: z.string().min(1).max(120).optional(),
  closingCaption: z.string().max(180).optional(),
  targetSeconds: z.number().int().min(10).max(15).default(15),
  template: reportThemeSchema.default("storybook"),
  musicStyle: reportMusicStyleSchema.optional(),
  visualStyle: reportVisualStyleSchema.default("clean"),
  mainPhotoLinkId: z.string().uuid().optional(),
  // The combined server-side selection must contain at least three photos.
  // A client may submit fewer approved links when eligible check-in frames are
  // allowed to fill the remainder.
  photoLinkIds: z.array(z.string().uuid()).max(6).optional(),
  videoLinkIds: z.array(z.string().uuid()).max(1).optional(),
  includeQualityIdentityPhotos: z.boolean().default(true),
});

reportVideosRouter.post(
  "/sessions/:sessionId/report-videos",
  asyncRoute(async (req, res) => {
    const body = createSchema.parse(req.body);
    const reportDate = body.reportDate ?? new Date().toISOString().slice(0, 10);
    const draft = await withOrgScope(req.auth!.organizationId, async (client) => {
      const sessionResult = await client.query(
        `SELECT s.id, s.pet_id, s.check_in_at::date::text AS check_in_date, p.name AS pet_name
         FROM sessions s JOIN pets p ON p.id = s.pet_id
         WHERE s.id = $1 AND s.organization_id = $2`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      const session = sessionResult.rows[0];
      if (!session) throw new HttpError(404, "Session not found");
      const mediaStartDate = reportMediaWindowStart(reportDate, body.mediaWindow, session.check_in_date);

      const promotedPhotoLinkIds: string[] = [];
      if (body.includeQualityIdentityPhotos) {
        const identityResult = await client.query(
          `SELECT ph.id
           FROM photos ph
           JOIN LATERAL (
             SELECT d.quality_score, d.bbox_width, d.bbox_height
             FROM photo_detections d
             WHERE d.photo_id = ph.id AND d.organization_id = ph.organization_id
               AND d.match_status <> 'manually_rejected'
             ORDER BY d.quality_score DESC NULLS LAST, d.detector_confidence DESC NULLS LAST
             LIMIT 1
           ) best ON true
           WHERE ph.organization_id = $1
             AND ph.reference_session_id = $2
             AND ph.reference_pet_id = $3
             AND ph.media_purpose = 'identity_reference'
             AND ph.processing_status = 'processed'
             AND ph.identity_reference_removed_at IS NULL
             AND ph.deleted_at IS NULL
             AND COALESCE(ph.capture_at, ph.uploaded_at)::date BETWEEN $4::date AND $5::date
             AND best.quality_score >= 0.78
             AND (best.bbox_width * best.bbox_height) >= 0.08
             AND NOT EXISTS (
               SELECT 1
               FROM photos promoted_photo
               JOIN photo_pet_links promoted_link
                 ON promoted_link.photo_id = promoted_photo.id
                AND promoted_link.organization_id = promoted_photo.organization_id
               WHERE promoted_photo.organization_id = ph.organization_id
                 AND promoted_photo.source_identity_photo_id = ph.id
                 AND promoted_photo.deleted_at IS NULL
                 AND promoted_link.review_state = 'rejected'
             )
             AND (
               SELECT count(*)
               FROM photo_detections d2
               WHERE d2.photo_id = ph.id AND d2.organization_id = ph.organization_id
                 AND d2.match_status <> 'manually_rejected'
             ) = 1
           ORDER BY best.quality_score DESC, ph.uploaded_at DESC
           LIMIT 2`,
          [req.auth!.organizationId, session.id, session.pet_id, mediaStartDate, reportDate]
        );
        for (const identityPhoto of identityResult.rows) {
          const promoted = await promoteIdentityPhotoToReport(client, req.auth!.organizationId, identityPhoto.id);
          if (promoted && promoted.review_state !== "rejected") promotedPhotoLinkIds.push(promoted.photo_link_id);
        }
      }

      const requestedPhotoLinkIds = body.photoLinkIds
        ? [
            ...(body.mainPhotoLinkId ? [body.mainPhotoLinkId] : []),
            ...promotedPhotoLinkIds,
            ...body.photoLinkIds,
          ].filter((id, index, ids) => ids.indexOf(id) === index)
        : null;

      const photoResult = await client.query(
        `SELECT l.id AS link_id, p.id, p.capture_at, p.uploaded_at
         FROM photo_pet_links l JOIN photos p
           ON p.id = l.photo_id AND p.organization_id = l.organization_id AND p.deleted_at IS NULL
         WHERE l.session_id = $1 AND l.organization_id = $2
           AND (l.review_state = 'published' OR (l.review_state = 'candidate' AND l.id = ANY($7::uuid[])))
           AND ($3::uuid[] IS NULL OR l.id = ANY($3::uuid[]))
           AND COALESCE(p.capture_at, p.uploaded_at)::date BETWEEN $4::date AND $5::date
         ORDER BY CASE WHEN l.id = $6::uuid THEN 0 ELSE 1 END,
           CASE WHEN $3::uuid[] IS NOT NULL THEN array_position($3::uuid[], l.id) END NULLS LAST,
           l.quality_score DESC NULLS LAST, p.uploaded_at DESC
         LIMIT 6`,
        [req.params.sessionId, req.auth!.organizationId, requestedPhotoLinkIds, mediaStartDate, reportDate, body.mainPhotoLinkId ?? null, promotedPhotoLinkIds]
      );
      const videoResult = await client.query(
        `SELECT l.id AS link_id, v.id, v.uploaded_at
         FROM video_pet_links l JOIN videos v ON v.id = l.video_id
         WHERE l.session_id = $1 AND l.organization_id = $2 AND l.review_state = 'published'
           AND ($3::uuid[] IS NULL OR l.id = ANY($3::uuid[]))
           AND COALESCE(v.capture_at, v.uploaded_at)::date BETWEEN $4::date AND $5::date
         ORDER BY v.uploaded_at DESC
         LIMIT 1`,
        [req.params.sessionId, req.auth!.organizationId, body.videoLinkIds ?? null, mediaStartDate, reportDate]
      );
      if (photoResult.rows.length < 3) {
        throw new HttpError(400, "Choose at least three reviewed or high-quality check-in photos in the selected report window first");
      }
      if (body.mainPhotoLinkId && !photoResult.rows.some((photo) => photo.link_id === body.mainPhotoLinkId)) {
        throw new HttpError(400, "The main image must be a published photo from the selected report window");
      }

      const selectedPhotos = photoResult.rows.slice(0, videoResult.rows.length > 0 ? 4 : 6);
      const mainPhoto = selectedPhotos[0];

      const logsResult = await client.query(
        `SELECT id, entry_type, title, body, structured_data FROM daily_log_entries
         WHERE session_id = $1 AND organization_id = $2
           AND entry_at::date BETWEEN $3::date AND $4::date
         ORDER BY entry_at`,
        [req.params.sessionId, req.auth!.organizationId, mediaStartDate, reportDate]
      );
      const companionResult = await client.query(
        `SELECT companion_pet_id AS id, companion_name AS name,
                bool_or(source = 'photo') AS appeared_in_photo,
                bool_or(source = 'video') AS appeared_in_video
         FROM (
           SELECT photo_link.pet_id AS companion_pet_id, companion.name AS companion_name, 'photo'::text AS source
           FROM photo_pet_links photo_link
           JOIN pets companion
             ON companion.id = photo_link.pet_id AND companion.organization_id = photo_link.organization_id
           WHERE photo_link.organization_id = $1
             AND photo_link.photo_id = ANY($2::uuid[])
             AND photo_link.pet_id <> $3
             AND photo_link.review_state = 'published'
           UNION ALL
           SELECT video_link.pet_id, companion.name, 'video'::text
           FROM video_pet_links video_link
           JOIN pets companion
             ON companion.id = video_link.pet_id AND companion.organization_id = video_link.organization_id
           WHERE video_link.organization_id = $1
             AND video_link.video_id = ANY($4::uuid[])
             AND video_link.pet_id <> $3
             AND video_link.review_state = 'published'
         ) confirmed_companions
         GROUP BY companion_pet_id, companion_name
         ORDER BY companion_name
         LIMIT 4`,
        [
          req.auth!.organizationId,
          selectedPhotos.map((photo) => photo.id),
          session.pet_id,
          videoResult.rows.map((video) => video.id),
        ]
      );
      const story = generateReportStory({
        petName: session.pet_name,
        companions: companionResult.rows.map((companion) => ({
          id: companion.id,
          name: companion.name,
          appearedInPhoto: companion.appeared_in_photo,
          appearedInVideo: companion.appeared_in_video,
        })),
        logs: logsResult.rows,
        photoCount: selectedPhotos.length,
        includesVideo: videoResult.rows.length > 0,
        coversMultipleDays: body.mediaWindow !== "report_day",
      });

      const inserted = await client.query(
         `INSERT INTO report_video_drafts
           (organization_id, session_id, pet_id, report_date, media_window, template, music_style, visual_style, title,
            story_text, story_facts, closing_caption, target_seconds, requested_by, main_photo_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          req.auth!.organizationId,
          session.id,
          session.pet_id,
          reportDate,
          body.mediaWindow,
          body.template,
          body.musicStyle ?? defaultMusicByTheme[body.template],
          body.visualStyle,
          body.title ?? `${session.pet_name}'s Day`,
          story.text,
          JSON.stringify(story.facts),
          body.closingCaption ?? null,
          body.targetSeconds,
          req.auth!.sub,
          mainPhoto.id,
        ]
      );
      const created = inserted.rows[0];
      let order = 0;
      await client.query(
        `INSERT INTO report_video_items (organization_id, report_video_id, item_type, photo_id, sort_order)
         VALUES ($1, $2, 'photo', $3, $4)`,
        [req.auth!.organizationId, created.id, mainPhoto.id, order++]
      );
      if (videoResult.rows[0]) {
        await client.query(
          `INSERT INTO report_video_items (organization_id, report_video_id, item_type, video_id, sort_order)
           VALUES ($1, $2, 'video', $3, $4)`,
          [req.auth!.organizationId, created.id, videoResult.rows[0].id, order++]
        );
      }
      for (const photo of selectedPhotos.slice(1)) {
        await client.query(
          `INSERT INTO report_video_items (organization_id, report_video_id, item_type, photo_id, sort_order)
           VALUES ($1, $2, 'photo', $3, $4)`,
          [req.auth!.organizationId, created.id, photo.id, order++]
        );
      }
      for (const log of logsResult.rows) {
        await client.query(
          `INSERT INTO report_video_items
             (organization_id, report_video_id, item_type, log_entry_id, sort_order, caption)
           VALUES ($1, $2, 'log', $3, $4, $5)`,
          [req.auth!.organizationId, created.id, log.id, order++, log.title ?? log.body]
        );
      }
      return created;
    });
    res.status(202).json(draft);
  })
);

reportVideosRouter.get(
  "/sessions/:sessionId/report-videos",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT * FROM report_video_drafts
         WHERE session_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
        [req.params.sessionId, req.auth!.organizationId]
      );
      return Promise.all(result.rows.map(async (row) => ({
        ...row,
        previewUrl: row.output_storage_key ? await presignGetUrl(row.output_storage_key) : null,
        emailRecipientOverride: config.email.testRecipient ?? null,
        emailDeliveryConfigured: isEmailDeliveryConfigured(),
      })));
    });
    res.json(rows);
  })
);

reportVideosRouter.get(
  "/report-videos/:id",
  asyncRoute(async (req, res) => {
    const draft = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT * FROM report_video_drafts WHERE id = $1 AND organization_id = $2`,
        [req.params.id, req.auth!.organizationId]
      );
      if (!result.rows[0]) return null;
      const items = await client.query(
        `SELECT * FROM report_video_items WHERE report_video_id = $1 AND organization_id = $2 ORDER BY sort_order`,
        [req.params.id, req.auth!.organizationId]
      );
      return { ...result.rows[0], items: items.rows };
    });
    if (!draft) throw new HttpError(404, "Report video not found");
    res.json({
      ...draft,
      previewUrl: draft.output_storage_key ? await presignGetUrl(draft.output_storage_key) : null,
      emailRecipientOverride: config.email.testRecipient ?? null,
      emailDeliveryConfigured: isEmailDeliveryConfigured(),
    });
  })
);

reportVideosRouter.delete(
  "/report-videos/:id",
  asyncRoute(async (req, res) => {
    const deleted = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT id, status, output_storage_key
         FROM report_video_drafts
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [req.params.id, req.auth!.organizationId]
      );
      const draft = result.rows[0];
      if (!draft) throw new HttpError(404, "Report draft not found");
      if (!(["ready", "failed", "approved"] as string[]).includes(draft.status)) {
        throw new HttpError(409, "Only ready, failed, or approved private report drafts can be deleted");
      }

      if (draft.output_storage_key) await deleteObject(draft.output_storage_key);
      await client.query(
        `DELETE FROM report_video_drafts
         WHERE id = $1 AND organization_id = $2 AND status IN ('ready', 'failed', 'approved')`,
        [draft.id, req.auth!.organizationId]
      );
      return draft.id as string;
    });
    res.json({ deleted: true, id: deleted });
  })
);

reportVideosRouter.post(
  "/report-videos/:id/approve",
  asyncRoute(async (req, res) => {
    const draft = await transition(req.params.id, req.auth!.organizationId, "ready", "approved", req.auth!.sub);
    if (!draft) throw new HttpError(409, "Only a ready video can be approved");
    res.json(draft);
  })
);

reportVideosRouter.post(
  "/report-videos/:id/publish",
  asyncRoute(async (req, res) => {
    const draft = await transition(req.params.id, req.auth!.organizationId, "approved", "published", req.auth!.sub);
    if (!draft) throw new HttpError(409, "Only an approved video can be published");
    res.json(draft);
  })
);

reportVideosRouter.post(
  "/report-videos/:id/email-share",
  asyncRoute(async (req, res) => {
    if (!config.email.resendApiKey) {
      throw new HttpError(503, "Email delivery is not configured yet. Use Copy link for now, or add a Resend API key.");
    }
    const delivery = await withOrgScope(req.auth!.organizationId, async (client) => {
      const reportResult = await client.query(
        `SELECT r.id, r.report_date, r.title, r.status, r.public_share_token,
                p.name AS pet_name, p.owner_id,
                owner.full_name AS owner_name, owner.phone AS owner_phone,
                owner.household_id, o.name AS organization_name
         FROM report_video_drafts r
         JOIN pets p ON p.id = r.pet_id AND p.organization_id = r.organization_id
         LEFT JOIN owners owner ON owner.id = p.owner_id AND owner.organization_id = r.organization_id
         JOIN organizations o ON o.id = r.organization_id
         WHERE r.id = $1 AND r.organization_id = $2`,
        [req.params.id, req.auth!.organizationId]
      );
      const report = reportResult.rows[0];
      if (!report) throw new HttpError(404, "Report not found");
      if (report.status !== "published") throw new HttpError(409, "Publish the report before emailing its share link");
      if (!report.owner_id && !config.email.testRecipient) throw new HttpError(400, "This pet does not have an owner contact");

      const tokenResult = await client.query(
        `UPDATE report_video_drafts
         SET public_share_token = COALESCE(public_share_token, gen_random_uuid()),
             share_created_at = COALESCE(share_created_at, now()), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND status = 'published'
         RETURNING public_share_token`,
        [report.id, req.auth!.organizationId]
      );
      const emailsResult = await client.query(
        `SELECT DISTINCT lower(email) AS email
         FROM owners
         WHERE organization_id = $1 AND email IS NOT NULL
           AND (id = $2 OR ($3::uuid IS NOT NULL AND household_id = $3))
         ORDER BY email`,
        [req.auth!.organizationId, report.owner_id, report.household_id]
      );
      const recipients = config.email.testRecipient
        ? [config.email.testRecipient]
        : emailsResult.rows.map((row) => row.email as string);
      if (!recipients.length) throw new HttpError(400, "No email address is on file for this pet's owner");
      return { ...report, public_share_token: tokenResult.rows[0].public_share_token as string, recipients };
    });

    const shareUrl = `${config.publicReportBaseUrl}/${delivery.public_share_token}`;
    await sendEmail({
      to: delivery.recipients,
      subject: `${delivery.pet_name}'s report from ${delivery.organization_name}`,
      html: renderReportShareEmailHtml({
        ownerName: delivery.owner_name || "there",
        petName: delivery.pet_name,
        organizationName: delivery.organization_name,
        reportDate: String(delivery.report_date).slice(0, 10),
        shareUrl,
      }),
    });

    const sentAt = new Date().toISOString();
    await withOrgScope(req.auth!.organizationId, async (client) => {
      for (const recipient of delivery.recipients) {
        await client.query(
          `INSERT INTO report_share_deliveries
             (organization_id, report_video_id, channel, recipient, sent_by)
           VALUES ($1, $2, 'email', $3, $4)`,
          [req.auth!.organizationId, delivery.id, recipient, req.auth!.sub]
        );
      }
      await client.query(
        `UPDATE report_video_drafts SET last_emailed_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [delivery.id, req.auth!.organizationId]
      );
    });

    res.json({ shareUrl, recipients: delivery.recipients, ownerPhone: delivery.owner_phone, sentAt, testMode: Boolean(config.email.testRecipient) });
  })
);

async function transition(id: string, organizationId: string, from: "ready" | "approved", to: "approved" | "published", userId: string) {
  return withOrgScope(organizationId, async (client) => {
    const approval = to === "approved";
    const result = await client.query(
      `UPDATE report_video_drafts SET status = $1,
         approved_by = CASE WHEN $2 THEN $3::uuid ELSE approved_by END,
         approved_at = CASE WHEN $2 THEN now() ELSE approved_at END,
         published_by = CASE WHEN NOT $2 THEN $3::uuid ELSE published_by END,
         published_at = CASE WHEN NOT $2 THEN now() ELSE published_at END,
         public_share_token = CASE WHEN NOT $2 THEN COALESCE(public_share_token, gen_random_uuid()) ELSE public_share_token END,
         share_created_at = CASE WHEN NOT $2 THEN COALESCE(share_created_at, now()) ELSE share_created_at END,
         updated_at = now()
       WHERE id = $4 AND organization_id = $5 AND status = $6
       RETURNING *`,
      [to, approval, userId, id, organizationId, from]
    );
    return result.rows[0];
  });
}

function reportMediaWindowStart(
  reportDate: string,
  mediaWindow: z.infer<typeof reportMediaWindowSchema>,
  checkInDate: string,
) {
  if (mediaWindow === "full_stay") return checkInDate > reportDate ? reportDate : checkInDate;
  const daysBack = mediaWindow === "last_3_days" ? 2 : mediaWindow === "last_2_days" ? 1 : 0;
  const start = new Date(`${reportDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const calculated = start.toISOString().slice(0, 10);
  return calculated < checkInDate ? checkInDate : calculated;
}
