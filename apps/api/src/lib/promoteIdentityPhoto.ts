import type { PoolClient } from "pg";

export type PromotedIdentityPhoto = {
  photo_id: string;
  photo_link_id: string;
  review_state: string;
};

/**
 * Copies an identity-only check-in frame into the normalized report-media pool.
 * The copied link remains a private candidate until a manager publishes it (or
 * approves a private report containing it). The source identity reference is
 * left untouched so it can continue helping pet matching.
 */
export async function promoteIdentityPhotoToReport(
  client: PoolClient,
  organizationId: string,
  sourcePhotoId: string,
): Promise<PromotedIdentityPhoto | null> {
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
    [sourcePhotoId, organizationId]
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
    [organizationId, source.id, source.reference_pet_id, source.reference_session_id]
  );
  if (existing.rows[0]) return existing.rows[0] as PromotedIdentityPhoto;

  const photoResult = await client.query(
    `INSERT INTO photos
       (organization_id, batch_id, uploaded_by, storage_key, thumbnail_key,
        capture_at, uploaded_at, width, height, file_size_bytes,
        processing_status, media_purpose, source_video_id,
        source_identity_photo_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processed','report_media',$11,$12)
     RETURNING id`,
    [
      organizationId, source.batch_id, source.uploaded_by, source.storage_key,
      source.thumbnail_key, source.capture_at, source.uploaded_at,
      source.width, source.height, source.file_size_bytes,
      source.source_video_id, source.id,
    ]
  );
  const reportPhotoId = photoResult.rows[0].id as string;

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
    [reportPhotoId, source.reference_pet_id, source.reference_session_id, source.id, organizationId]
  );
  const detection = detectionResult.rows[0];
  const linkResult = await client.query(
    `INSERT INTO photo_pet_links
       (organization_id, photo_id, pet_id, session_id, source_detection_id,
        association_type, review_state, quality_score, is_manually_adjusted)
     VALUES ($1,$2,$3,$4,$5,'manual','candidate',$6,true)
     RETURNING id AS photo_link_id, review_state`,
    [
      organizationId, reportPhotoId, source.reference_pet_id,
      source.reference_session_id, detection?.id ?? null,
      detection?.quality_score ?? null,
    ]
  );
  return { photo_id: reportPhotoId, ...linkResult.rows[0] } as PromotedIdentityPhoto;
}
