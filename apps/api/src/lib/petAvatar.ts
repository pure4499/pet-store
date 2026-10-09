import type { PoolClient } from "pg";
import { presignGetUrl } from "./s3.js";

export interface PetAvatarTarget {
  petId: string;
  sessionId?: string | null;
}

export async function loadPetAvatarUrls(
  client: PoolClient,
  organizationId: string,
  targets: PetAvatarTarget[]
): Promise<Map<string, string>> {
  const uniqueTargets = Array.from(
    new Map(targets.map((target) => [`${target.sessionId ?? ""}:${target.petId}`, target])).values()
  );
  if (uniqueTargets.length === 0) return new Map();

  const result = await client.query<{ pet_id: string; session_id: string | null; storage_key: string | null }>(
    `WITH targets AS (
       SELECT pet_id, session_id
       FROM jsonb_to_recordset($2::jsonb) AS target(pet_id uuid, session_id uuid)
     )
     SELECT target.pet_id, target.session_id,
            COALESCE(identity_photo.storage_key, report_photo.storage_key) AS storage_key
     FROM targets target
     LEFT JOIN LATERAL (
       SELECT detection.crop_storage_key AS storage_key
       FROM photos photo
       JOIN photo_detections detection
         ON detection.photo_id = photo.id
        AND detection.organization_id = photo.organization_id
       WHERE photo.organization_id = $1
         AND photo.reference_pet_id = target.pet_id
         AND (target.session_id IS NULL OR photo.reference_session_id = target.session_id)
         AND photo.media_purpose = 'identity_reference'
         AND photo.identity_reference_removed_at IS NULL
         AND photo.deleted_at IS NULL
         AND detection.matched_pet_id = target.pet_id
         AND (target.session_id IS NULL OR detection.matched_session_id = target.session_id)
         AND detection.crop_storage_key IS NOT NULL
         AND detection.match_status = 'manually_assigned'
       ORDER BY detection.quality_score DESC NULLS LAST,
                detection.detector_confidence DESC NULLS LAST,
                COALESCE(photo.capture_at, photo.uploaded_at) DESC
       LIMIT 1
     ) identity_photo ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(detection.crop_storage_key, photo.thumbnail_key, photo.storage_key) AS storage_key
       FROM photo_pet_links link
       JOIN photos photo
         ON photo.id = link.photo_id
        AND photo.organization_id = link.organization_id
        AND photo.deleted_at IS NULL
       LEFT JOIN photo_detections detection
         ON detection.id = link.source_detection_id
        AND detection.photo_id = link.photo_id
        AND detection.organization_id = link.organization_id
        AND detection.matched_pet_id = link.pet_id
       WHERE link.organization_id = $1
         AND link.pet_id = target.pet_id
         AND (target.session_id IS NULL OR link.session_id = target.session_id)
         AND link.review_state IN ('pending', 'candidate', 'published')
       ORDER BY CASE link.review_state WHEN 'published' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
                link.quality_score DESC NULLS LAST,
                COALESCE(photo.capture_at, photo.uploaded_at) DESC
       LIMIT 1
     ) report_photo ON true`,
    [organizationId, JSON.stringify(uniqueTargets.map((target) => ({ pet_id: target.petId, session_id: target.sessionId ?? null })))]
  );

  const urls = await Promise.all(result.rows.map(async (row) => ({
    key: `${row.session_id ?? ""}:${row.pet_id}`,
    url: row.storage_key ? await presignGetUrl(row.storage_key) : null,
  })));
  return new Map(urls.filter((entry): entry is { key: string; url: string } => Boolean(entry.url)).map((entry) => [entry.key, entry.url]));
}

export function petAvatarKey(petId: string, sessionId?: string | null) {
  return `${sessionId ?? ""}:${petId}`;
}
