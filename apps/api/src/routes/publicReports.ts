import { Router } from "express";
import { z } from "zod";
import { withOrgScope, withoutOrgScope } from "../db/pool.js";
import { escapeHtml } from "../lib/email.js";
import { presignGetUrl } from "../lib/s3.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";

export const publicReportsRouter = Router();

const shareTokenSchema = z.string().uuid();

publicReportsRouter.get(
  "/public/reports/:token",
  asyncRoute(async (req, res) => {
    const token = shareTokenSchema.parse(req.params.token);
    const resolved = await withoutOrgScope(async (client) => {
      const result = await client.query(
        "SELECT organization_id, report_video_id FROM resolve_public_report_share($1)",
        [token]
      );
      return result.rows[0] as { organization_id: string; report_video_id: string } | undefined;
    });
    if (!resolved) throw new HttpError(404, "This report link is unavailable");

    const report = await withOrgScope(resolved.organization_id, async (client) => {
      const reportResult = await client.query(
        `SELECT r.id, r.session_id, r.pet_id, r.report_date, r.media_window, r.template, r.visual_style, r.title,
                r.story_text, r.closing_caption,
                r.output_storage_key, r.main_photo_id, r.published_at,
                p.name AS pet_name, p.species, p.breed,
                o.name AS organization_name
         FROM report_video_drafts r
         JOIN pets p ON p.id = r.pet_id AND p.organization_id = r.organization_id
         JOIN organizations o ON o.id = r.organization_id
         WHERE r.id = $1 AND r.organization_id = $2
           AND r.public_share_token = $3 AND r.status = 'published'`,
        [resolved.report_video_id, resolved.organization_id, token]
      );
      const row = reportResult.rows[0];
      if (!row) return null;

      const photosResult = await client.query(
          `SELECT p.id, p.storage_key, p.thumbnail_key, i.sort_order,
                  focus.bbox_x, focus.bbox_y, focus.bbox_width, focus.bbox_height
           FROM report_video_items i
           JOIN photos p ON p.id = i.photo_id
             AND p.organization_id = i.organization_id AND p.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT d.bbox_x, d.bbox_y, d.bbox_width, d.bbox_height
             FROM photo_detections d
             WHERE d.photo_id = p.id
               AND d.organization_id = i.organization_id
               AND d.matched_pet_id = $5
               AND d.match_status <> 'manually_rejected'
             ORDER BY d.quality_score DESC NULLS LAST,
                      d.detector_confidence DESC NULLS LAST
             LIMIT 1
           ) focus ON true
           WHERE i.report_video_id = $1 AND i.organization_id = $2
             AND i.item_type = 'photo'
             AND EXISTS (
               SELECT 1 FROM photo_pet_links l
               WHERE l.photo_id = p.id AND l.session_id = $3
                 AND l.organization_id = $2 AND l.review_state = 'published'
             )
           ORDER BY CASE WHEN p.id = $4::uuid THEN 0 ELSE 1 END, i.sort_order`,
          [row.id, resolved.organization_id, row.session_id, row.main_photo_id, row.pet_id]
        );
      const logsResult = await client.query(
          `SELECT l.entry_type, l.entry_at, l.title, l.body, i.sort_order
           FROM report_video_items i
           JOIN daily_log_entries l ON l.id = i.log_entry_id
             AND l.organization_id = i.organization_id
           WHERE i.report_video_id = $1 AND i.organization_id = $2
             AND i.item_type = 'log'
           ORDER BY i.sort_order`,
          [row.id, resolved.organization_id]
        );

      return {
        ...row,
        photos: await Promise.all(
          photosResult.rows.map(async (photo) => ({
            url: await presignGetUrl(photo.storage_key),
            bboxX: photo.bbox_x,
            bboxY: photo.bbox_y,
            bboxWidth: photo.bbox_width,
            bboxHeight: photo.bbox_height,
          }))
        ),
        videoUrl: row.output_storage_key ? await presignGetUrl(row.output_storage_key) : null,
        logs: logsResult.rows,
      };
    });
    if (!report) throw new HttpError(404, "This report link is unavailable");

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
    res.setHeader("content-security-policy", "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.send(renderPublicReport(report));
  })
);

function renderPublicReport(report: Record<string, any>): string {
  const photos = (report.photos as Array<Record<string, any>>).map((photo, index) =>
    `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(report.pet_name)} report photo ${index + 1}" loading="lazy" style="object-position:${publicPhotoFocalPoint(photo)}">`
  );
  const hero = photos[0] ?? "";
  const gallery = photos.slice(1).join("");
  const logs = (report.logs as Array<Record<string, any>>).map((log) => {
    const label = String(log.title || log.entry_type || "Care update").replace(/_/g, " ");
    return `<article><time>${escapeHtml(formatTime(log.entry_at))}</time><div><strong>${escapeHtml(label)}</strong>${log.body ? `<p>${escapeHtml(String(log.body))}</p>` : ""}</div></article>`;
  }).join("");
  const date = formatDate(report.report_date);
  const theme = ["storybook", "timeline_diary", "care_card", "photo_journal", "postcard"].includes(report.template)
    ? report.template
    : "storybook";
  const visualStyle = ["clean", "sticker_dots", "cartoon_title"].includes(report.visual_style)
    ? report.visual_style
    : "clean";
  const description = `${report.pet_name}'s report from ${report.organization_name}`;

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(report.title)} · ${escapeHtml(report.organization_name)}</title>
  <style>
    :root{--ink:#153f37;--green:#177462;--mint:#dff1eb;--cream:#f6f1e7;--gold:#dca63b;--muted:#667b75}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--cream);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{position:relative;width:min(900px,100%);margin:0 auto;background:#fffdf9;min-height:100vh;box-shadow:0 18px 70px rgba(22,63,55,.13)}header{position:relative;min-height:480px;display:flex;align-items:flex-end;overflow:hidden;background:var(--ink)}header>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}header:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,rgba(8,42,36,.92),rgba(8,42,36,.05) 72%)}header>div{position:relative;z-index:1;padding:42px;color:white}.eyebrow{font-size:12px;font-weight:850;letter-spacing:.16em;text-transform:uppercase}h1{max-width:680px;margin:10px 0 8px;font-family:Georgia,serif;font-size:clamp(40px,8vw,72px);line-height:.98}header p{margin:0;color:#dcebe6;font-size:16px}.intro{padding:36px 42px 24px;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:start}.intro h2{margin:0 0 8px;font-family:Georgia,serif;font-size:30px}.intro p{margin:0;color:var(--muted);font-size:16px;line-height:1.6}.date{padding:12px 16px;border-radius:999px;background:var(--mint);font-weight:800;white-space:nowrap}.video{margin:0 42px 32px;overflow:hidden;border-radius:20px;background:#102e29}.video video{display:block;width:100%;max-height:640px;background:#102e29}.section{padding:0 42px 36px}.section h2{margin:0 0 18px;font-family:Georgia,serif;font-size:28px}.gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.gallery img{width:100%;aspect-ratio:1;display:block;border-radius:18px;object-fit:cover}.timeline{display:grid;gap:10px}.timeline article{display:grid;grid-template-columns:80px 1fr;gap:16px;padding:16px;border-radius:15px;background:#edf6f2}.timeline time{color:var(--green);font-weight:800}.timeline strong{text-transform:capitalize}.timeline p{margin:5px 0 0;color:var(--muted);line-height:1.5}.closing{margin:0 42px 38px;padding:26px 30px;border-left:5px solid var(--gold);background:#fff7e5;font-family:Georgia,serif;font-size:23px;line-height:1.45}footer{padding:24px 42px 34px;color:var(--muted);background:#edf5f1;text-align:center;font-size:13px}.photo_journal .gallery{grid-template-columns:repeat(3,1fr)}.postcard .closing{background:#f8e6dc}.care_card .date{background:#d8eee6}.timeline_diary .timeline article{border-left:4px solid var(--green)}.sticker_dots .gallery img,.sticker_dots .video{border:5px solid #fff;outline:3px dotted var(--gold);outline-offset:3px;box-shadow:0 8px 22px rgba(21,63,55,.18)}.sticker_dots:before,.sticker_dots:after{position:absolute;z-index:4;display:grid;place-items:center;width:58px;height:58px;border:3px dotted #fff;border-radius:50%;color:#fff;background:var(--gold);font-size:27px;box-shadow:0 5px 15px rgba(0,0,0,.15)}.sticker_dots:before{content:"🐾";top:18px;right:18px;transform:rotate(10deg)}.sticker_dots:after{content:"✦";top:88px;right:64px;width:36px;height:36px;font-size:18px;transform:rotate(-8deg)}.cartoon_title h1{font-family:"Trebuchet MS",ui-rounded,sans-serif;font-weight:900;letter-spacing:-.04em;transform:rotate(-1.5deg);text-shadow:3px 3px 0 #e7a93b,-2px -2px 0 rgba(16,67,57,.9),0 6px 0 rgba(0,0,0,.14)}.cartoon_title .intro h2,.cartoon_title .section h2{font-family:"Trebuchet MS",ui-rounded,sans-serif;font-weight:900;color:#a95542}
    @media(max-width:640px){header{min-height:390px}header>div,.intro,.section{padding-left:20px;padding-right:20px}.intro{grid-template-columns:1fr}.video,.closing{margin-left:20px;margin-right:20px}.gallery,.photo_journal .gallery{grid-template-columns:1fr}.timeline article{grid-template-columns:1fr;gap:5px}h1{font-size:44px}}
  </style>
</head><body><main class="shell ${theme} ${visualStyle}">
  <header>${hero}<div><span class="eyebrow">${escapeHtml(report.organization_name)} · ${escapeHtml(date)}</span><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(report.pet_name)}${report.breed ? ` · ${escapeHtml(report.breed)}` : ""}</p></div></header>
  <section class="intro"><div><h2>${report.media_window && report.media_window !== "report_day" ? "A little story from this stay" : "A little story from today"}</h2><p>${escapeHtml(report.story_text || report.closing_caption || `${report.pet_name} had a wonderful day with us.`)}</p></div><span class="date">${escapeHtml(date)}</span></section>
  ${report.videoUrl ? `<figure class="video"><video controls playsinline preload="metadata" src="${escapeHtml(report.videoUrl)}"></video></figure>` : ""}
  ${gallery ? `<section class="section"><h2>Moments from the day</h2><div class="gallery">${gallery}</div></section>` : ""}
  ${logs ? `<section class="section"><h2>Care timeline</h2><div class="timeline">${logs}</div></section>` : ""}
  ${report.closing_caption ? `<blockquote class="closing">“${escapeHtml(report.closing_caption)}”</blockquote>` : ""}
  <footer>Shared by ${escapeHtml(report.organization_name)} through UCBarkley.<br>Anyone with this private link can view this report.</footer>
</main></body></html>`;
}

function publicPhotoFocalPoint(photo: Record<string, any>): string {
  const x = Number(photo.bboxX);
  const y = Number(photo.bboxY);
  const width = Number(photo.bboxWidth);
  const height = Number(photo.bboxHeight);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return "50% 50%";
  }

  const centerX = Math.min(0.9, Math.max(0.1, x + width / 2));
  const centerY = Math.min(0.9, Math.max(0.1, y + height / 2));
  return `${(centerX * 100).toFixed(1)}% ${(centerY * 100).toFixed(1)}%`;
}

function formatDate(value: string | Date): string {
  const raw = String(value);
  const date = value instanceof Date
    ? value
    : /^\d{4}-\d{2}-\d{2}/.test(raw)
      ? new Date(`${raw.slice(0, 10)}T12:00:00Z`)
      : new Date(raw);
  if (Number.isNaN(date.getTime())) return "Report day";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}
