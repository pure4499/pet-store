import type { PoolClient } from "pg";
import sharp from "sharp";
import { withOrgScope } from "../db/pool.js";
import { detect, embed } from "../inference/client.js";
import type { ClaimedPhoto } from "../queue/photoQueue.js";
import { downloadObject, uploadObject } from "../s3/client.js";
import { findCandidateMatches, getOrgThresholds } from "./matching.js";
import { compositeScore, scoreQuality } from "./quality.js";
import { detectLeashColor } from "./leashColor.js";

const THUMBNAIL_WIDTH = 800;
const REVIEWABLE_REFERENCE_CONFIDENCE = 0.15;
const REVIEWABLE_REFERENCE_QUALITY = 0.62;
const REVIEWABLE_REFERENCE_MIN_BOX_AREA = 0.12;

type PetDetection = Awaited<ReturnType<typeof detect>>[number];

function normalizedSpeciesGuess(value: PetDetection["speciesGuess"]): "dog" | "cat" | "unknown" {
  return value === "dog" || value === "cat" ? value : "unknown";
}

function overlapMetrics(first: PetDetection, second: PetDetection) {
  const left = Math.max(first.bboxX, second.bboxX);
  const top = Math.max(first.bboxY, second.bboxY);
  const right = Math.min(first.bboxX + first.bboxWidth, second.bboxX + second.bboxWidth);
  const bottom = Math.min(first.bboxY + first.bboxHeight, second.bboxY + second.bboxHeight);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const firstArea = first.bboxWidth * first.bboxHeight;
  const secondArea = second.bboxWidth * second.bboxHeight;
  const union = firstArea + secondArea - intersection;
  return {
    iou: union > 0 ? intersection / union : 0,
    smallerCoverage: Math.min(firstArea, secondArea) > 0 ? intersection / Math.min(firstArea, secondArea) : 0,
  };
}

/**
 * Identity media is intentionally centered on one pet. Generic COCO detectors
 * often emit a strong whole-animal box plus weaker face, body, or full-frame
 * boxes for that same subject. Preserve a real, distinct second pet when its
 * detection is credible, but do not let duplicate/background proposals block
 * identity enrollment.
 */
export function filterIdentityDetections(detections: PetDetection[]): PetDetection[] {
  const ranked = [...detections].sort((first, second) => second.confidence - first.confidence);
  const primary = ranked[0];
  if (!primary) return [];
  const credibleSecondaryThreshold = Math.max(0.35, primary.confidence * 0.45);
  const kept: PetDetection[] = [];

  for (const candidate of ranked) {
    if (candidate !== primary && (candidate.reviewOnly || candidate.confidence < credibleSecondaryThreshold)) {
      continue;
    }
    const duplicatesExisting = kept.some((existing) => {
      const overlap = overlapMetrics(existing, candidate);
      if (overlap.iou >= 0.7) return true;
      return overlap.smallerCoverage >= 0.88 && candidate.confidence <= existing.confidence * 0.8;
    });
    if (!duplicatesExisting) kept.push(candidate);
  }
  return kept;
}

/**
 * The per-photo pipeline from plan §5: fetch -> thumbnail -> detect -> crop+embed
 * -> quality score -> match -> re-rank. Runs entirely off the API request path
 * (see apps/worker/src/index.ts), triggered by the photo queue abstraction so
 * uploads never block on this.
 */
export async function processPhoto(photo: ClaimedPhoto): Promise<void> {
  const original = await downloadObject(photo.storageKey);
  const metadata = await sharp(original).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const thumbnailKey = photo.storageKey.replace(/^raw\//, "thumbs/");
  const thumbnail = await sharp(original).resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true }).jpeg().toBuffer();
  await uploadObject(thumbnailKey, thumbnail, "image/jpeg");

  const detections = await detect(original);

  await withOrgScope(photo.organizationId, async (client) => {
    const photoContextResult = await client.query(
      `SELECT ph.capture_at, ph.media_purpose, ph.reference_pet_id, ph.reference_session_id,
              ph.source_video_id,
              collar.color_hex AS assigned_color_hex
       FROM photos ph
       LEFT JOIN sessions reference_session
         ON reference_session.id = ph.reference_session_id
        AND reference_session.organization_id = ph.organization_id
       LEFT JOIN organization_collar_palette collar
         ON collar.id = reference_session.collar_palette_id
        AND collar.organization_id = reference_session.organization_id
       WHERE ph.id = $1 AND ph.organization_id = $2 AND ph.deleted_at IS NULL
       FOR UPDATE OF ph`,
      [photo.id, photo.organizationId]
    );
    const photoContext = photoContextResult.rows[0];
    // A manager may delete an upload after the queue has claimed it.
    if (!photoContext) return;

    await client.query(
      `UPDATE photos SET thumbnail_key = $1, width = $2, height = $3,
              capture_at = COALESCE(capture_at, uploaded_at)
       WHERE id = $4`,
      [thumbnailKey, width, height, photo.id]
    );

    if (detections.length === 0) {
      await client.query(`UPDATE photos SET processing_status = 'processed' WHERE id = $1`, [photo.id]);
      return;
    }

    const captureAt: Date = photoContext.capture_at;
    const isIdentityReference = photoContext.media_purpose === "identity_reference";
    // Enrollment media is accepted automatically only when exactly one animal
    // was detected. A crowded arrival frame must not teach the system that a
    // neighboring pet is the checked-in pet.
    const usableDetections = isIdentityReference ? filterIdentityDetections(detections) : detections;
    const canEnrollIdentity = isIdentityReference && usableDetections.length === 1;
    const bestPhotoCount = (await getOrgThresholds(client, photo.organizationId)).bestPhotoCount;
    const affectedSessionPetPairs = new Set<string>();

    for (const detection of usableDetections) {
      const cropKey = photo.storageKey.replace(/^raw\//, "crops/").replace(/(\.\w+)?$/, `-crop${Math.random().toString(36).slice(2, 8)}$1`);
      const cropBuffer = await sharp(original)
        .extract({
          left: Math.round(detection.bboxX * width),
          top: Math.round(detection.bboxY * height),
          width: Math.round(detection.bboxWidth * width),
          height: Math.round(detection.bboxHeight * height),
        })
        .jpeg()
        .toBuffer();
      await uploadObject(cropKey, cropBuffer, "image/jpeg");

      const embeddingResult = await embed(cropBuffer);
      const embedding = embeddingResult.embedding;
      const thresholds = await getOrgThresholds(
        client,
        photo.organizationId,
        embeddingResult.modelVersion
      );
      const leashColor = await detectLeashColor(
        original,
        detection,
        isIdentityReference ? photoContext.assigned_color_hex : null
      );
      const metrics = await scoreQuality(cropBuffer, detection.bboxWidth, detection.bboxHeight);
      const qualityScore = compositeScore(metrics, detection.confidence);
      const speciesGuess = normalizedSpeciesGuess(detection.speciesGuess);
      // The inference service uses a low-confidence, nearly full-frame `pet`
      // proposal when its generic COCO detector misses an unusually groomed,
      // close-up, or overhead animal. The database deliberately stores only
      // normalized species values. For an explicit check-in reference, trust
      // the staff's pet assignment when that single fallback frame is still
      // good-quality; report photos continue to require normal AI review.
      const isIdentityFallback = isIdentityReference &&
        photoContext.source_video_id === null &&
        detection.reviewOnly === true &&
        speciesGuess === "unknown" &&
        detection.confidence <= 0.05 &&
        detection.bboxWidth >= 0.9 &&
        detection.bboxHeight >= 0.9;
      // Check-in media has already been assigned to this pet by a staff member.
      // A generic COCO detector can be cautious around white, freshly groomed,
      // side-profile dogs even when its box is accurate. Accept that useful
      // crop as an identity reference when it is one known-species proposal,
      // large in the frame, and objectively high quality. This deliberately
      // excludes the 0.01 whole-frame fallback and small background objects.
      const isGuardedReviewableReference = isIdentityReference &&
        detection.reviewOnly === true &&
        speciesGuess !== "unknown" &&
        detection.confidence >= REVIEWABLE_REFERENCE_CONFIDENCE &&
        qualityScore >= REVIEWABLE_REFERENCE_QUALITY &&
        detection.bboxWidth * detection.bboxHeight >= REVIEWABLE_REFERENCE_MIN_BOX_AREA;
      const shouldEnrollIdentity = canEnrollIdentity &&
        qualityScore >= 0.45 &&
        (detection.confidence >= 0.55 || isIdentityFallback || isGuardedReviewableReference);
      const embeddingLiteral = `[${embedding.join(",")}]`;

      const matches = isIdentityReference
        ? []
        : await findCandidateMatches(
            client,
            photo.organizationId,
            embedding,
            embeddingResult.modelVersion,
            captureAt,
            leashColor
          );
      const best = matches[0];
      const second = matches[1];
      const detectorRequiresReview = detection.reviewOnly === true;
      // A margin exists only when there is a real second identity to compare.
      // Treating a missing runner-up as similarity 0 made the sole enrolled
      // pet look artificially decisive and caused unrelated dogs to inherit
      // that identity.
      const matchMargin = best && second ? best.similarity - second.similarity : null;
      const hasConfidentIdentity = !detectorRequiresReview && Boolean(best) && (
        second
          ? best!.appearanceSimilarity >= thresholds.matchConfidenceThreshold &&
            matchMargin! >= thresholds.minimumMatchMargin
          : best!.appearanceSimilarity >= thresholds.singleCandidateMatchThreshold
      );
      const hasReviewableIdentity = Boolean(best) && (
        second
          ? best!.appearanceSimilarity >= thresholds.lowConfidenceThreshold
          : best!.appearanceSimilarity >= thresholds.singleCandidateReviewThreshold
      );
      const matchStatus = shouldEnrollIdentity
        ? "manually_assigned"
        : hasConfidentIdentity
          ? "matched"
          : hasReviewableIdentity
            ? "low_confidence"
            : "no_match";

      const detectionResult = await client.query(
        `INSERT INTO photo_detections
           (photo_id, organization_id, bbox_x, bbox_y, bbox_width, bbox_height, crop_storage_key,
            detector_confidence, species_guess, embedding, quality_score, quality_metrics,
            accessory_attributes, matched_pet_id, matched_session_id, match_confidence, match_status,
            match_signals, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          photo.id,
          photo.organizationId,
          detection.bboxX,
          detection.bboxY,
          detection.bboxWidth,
          detection.bboxHeight,
          cropKey,
          detection.confidence,
          speciesGuess,
          embeddingLiteral,
          qualityScore,
          JSON.stringify(metrics),
          JSON.stringify(leashColor ?? {}),
          // Keep the best identity on low-confidence detections as a visible
          // suggestion.  Only a fully matched detection creates an automatic
          // photo link below; low-confidence suggestions still require staff
          // confirmation in the mobile review step.
          shouldEnrollIdentity ? photoContext.reference_pet_id : matchStatus !== "no_match" ? best?.petId : null,
          shouldEnrollIdentity ? photoContext.reference_session_id : matchStatus !== "no_match" ? best?.sessionId : null,
          best?.appearanceSimilarity ?? null,
          matchStatus,
          JSON.stringify(best ? {
            appearanceSimilarity: best.appearanceSimilarity,
            leashColorAvailable: best.leashColorAvailable,
            leashColorAgreement: best.leashColorAgreement,
            leashColorAdjustment: best.leashColorAdjustment,
            combinedRankingScore: best.similarity,
          } : {}),
          embeddingResult.modelVersion,
        ]
      );

      if (shouldEnrollIdentity) {
        await client.query(
          `INSERT INTO pet_reference_embeddings
             (organization_id, pet_id, source_type, source_detection_id, embedding, embedding_model)
           VALUES ($1, $2, 'registration_photo', $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [photo.organizationId, photoContext.reference_pet_id, detectionResult.rows[0].id, embeddingLiteral, embeddingResult.modelVersion]
        );
      }

      // Only a confident match auto-creates the curated link; low_confidence is
      // left as a suggestion on the detection row for staff to confirm via the
      // needs-review queue (plan §5 step 6) rather than silently auto-sorted.
      if (!isIdentityReference && matchStatus === "matched" && best) {
        await client.query(
          `INSERT INTO photo_pet_links
             (organization_id, photo_id, pet_id, session_id, source_detection_id, association_type, quality_score)
           VALUES ($1, $2, $3, $4, $5, 'auto_matched', $6)
           ON CONFLICT (photo_id, pet_id) DO NOTHING`,
          [photo.organizationId, photo.id, best.petId, best.sessionId, detectionResult.rows[0].id, qualityScore]
        );
        affectedSessionPetPairs.add(`${best.sessionId}:${best.petId}`);
      }
    }

    for (const pair of affectedSessionPetPairs) {
      const [sessionId, petId] = pair.split(":");
      await reRankCandidates(client, photo.organizationId, sessionId, petId, bestPhotoCount);
    }

    await client.query(`UPDATE photos SET processing_status = 'processed' WHERE id = $1`, [photo.id]);
  });
}

/**
 * Re-ranks one pet+session's non-manually-adjusted photo pool by quality_score
 * and marks the top `bestPhotoCount` as candidates. is_manually_adjusted rows
 * are left untouched so a later re-rank (triggered by more photos arriving)
 * never silently undoes a staff promote/demote decision (plan §5 step 7).
 */
async function reRankCandidates(
  client: PoolClient,
  organizationId: string,
  sessionId: string,
  petId: string,
  bestPhotoCount: number
): Promise<void> {
  await client.query(
    `WITH ranked AS (
       SELECT id, row_number() OVER (ORDER BY quality_score DESC NULLS LAST) AS rank
       FROM photo_pet_links
       WHERE session_id = $1 AND pet_id = $2 AND organization_id = $3
         AND is_manually_adjusted = false AND review_state <> 'published'
     )
     UPDATE photo_pet_links l
     SET review_state = CASE WHEN ranked.rank <= $4 THEN 'candidate' ELSE 'pending' END
     FROM ranked
     WHERE l.id = ranked.id`,
    [sessionId, petId, organizationId, bestPhotoCount]
  );
}
