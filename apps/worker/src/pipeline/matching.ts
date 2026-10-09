import type { PoolClient } from "pg";
import { leashColorAgreement, type LeashColorSignal } from "./leashColor.js";

export interface OrgThresholds {
  matchConfidenceThreshold: number;
  lowConfidenceThreshold: number;
  minimumMatchMargin: number;
  singleCandidateMatchThreshold: number;
  singleCandidateReviewThreshold: number;
  bestPhotoCount: number;
}

export async function getOrgThresholds(
  client: PoolClient,
  organizationId: string,
  embeddingModel = "resnet18-imagenet-v1"
): Promise<OrgThresholds> {
  const result = await client.query(
    `SELECT match_confidence_threshold, low_confidence_threshold, best_photo_count
     FROM organization_settings WHERE organization_id = $1`,
    [organizationId]
  );
  const row = result.rows[0];
  const configured = {
    matchConfidenceThreshold: Number(row?.match_confidence_threshold ?? 0.65),
    lowConfidenceThreshold: Number(row?.low_confidence_threshold ?? 0.4),
    // ImageNet embeddings are useful for candidate ranking, but their cosine
    // similarity is not a calibrated identity probability. Require a useful
    // gap between first and second place before calling a result confident.
    minimumMatchMargin: 0.08,
    // With only one enrolled pet there is no runner-up comparison. Use a very
    // conservative absolute gate so the model cannot label every dog as the
    // sole pet merely because that pet is the nearest available reference.
    singleCandidateMatchThreshold: 0.9,
    singleCandidateReviewThreshold: 0.85,
    bestPhotoCount: Number(row?.best_photo_count ?? 8),
  };

  // Cosine scores are model-specific rather than probabilities. DINOv2
  // separates the current labeled pets much more strongly than ImageNet
  // ResNet, but its absolute similarities are lower. Keep independently
  // calibrated gates so selecting a new embedding model cannot accidentally
  // inherit thresholds from an incompatible feature space.
  if (embeddingModel === "dinov2-vits14-reg-padded512-v1") {
    return {
      ...configured,
      matchConfidenceThreshold: 0.5,
      lowConfidenceThreshold: 0.4,
      minimumMatchMargin: 0.1,
      singleCandidateMatchThreshold: 0.55,
      singleCandidateReviewThreshold: 0.48,
    };
  }

  return configured;
}

export interface CandidateMatch {
  petId: string;
  sessionId: string;
  appearanceSimilarity: number;
  similarity: number;
  leashColorAvailable: boolean;
  leashColorAgreement: number;
  leashColorAdjustment: number;
}

/**
 * The scoped match query from plan §3: only pets with a session covering the
 * photo's capture time are candidates. This is what keeps matching both cheap
 * (a handful of active pets per org, not the whole historical database) and
 * correct (a pet that already checked out before capture_at can't match,
 * regardless of when processing happens to run).
 */
export async function findCandidateMatches(
  client: PoolClient,
  organizationId: string,
  queryEmbedding: number[],
  embeddingModel: string,
  captureAt: Date,
  queryLeashColor: LeashColorSignal | null = null
): Promise<CandidateMatch[]> {
  const result = await client.query(
    `SELECT DISTINCT ON (pe.pet_id)
       pe.pet_id, s.id AS session_id, 1 - (pe.embedding <=> $1) AS appearance_similarity,
       current_reference.accessory_attributes AS reference_accessory_attributes
     FROM pet_reference_embeddings pe
     JOIN pets p ON p.id = pe.pet_id
     JOIN sessions s ON s.pet_id = p.id
     LEFT JOIN LATERAL (
       SELECT d.accessory_attributes
       FROM photos identity_photo
       JOIN photo_detections d
         ON d.photo_id = identity_photo.id
        AND d.organization_id = identity_photo.organization_id
       WHERE identity_photo.organization_id = p.organization_id
         AND identity_photo.media_purpose = 'identity_reference'
         AND identity_photo.reference_session_id = s.id
         AND identity_photo.deleted_at IS NULL
         AND d.matched_pet_id = pe.pet_id
         AND d.accessory_attributes->>'detected' = 'true'
       ORDER BY (d.accessory_attributes->>'confidence')::numeric DESC NULLS LAST
       LIMIT 1
     ) current_reference ON true
     WHERE p.organization_id = $2
       AND pe.is_active = true
       AND pe.embedding_model = $3
       AND s.status <> 'cancelled'
       AND s.check_in_at <= $4
       AND (s.check_out_at IS NULL OR s.check_out_at >= $4)
     ORDER BY pe.pet_id, pe.embedding <=> $1
     LIMIT 20`,
    [`[${queryEmbedding.join(",")}]`, organizationId, embeddingModel, captureAt]
  );
  return result.rows
    .map((row) => {
      const appearanceSimilarity = Number(row.appearance_similarity);
      const leash = leashColorAgreement(queryLeashColor, row.reference_accessory_attributes);
      return {
        petId: row.pet_id,
        sessionId: row.session_id,
        appearanceSimilarity,
        similarity: appearanceSimilarity + leash.adjustment,
        leashColorAvailable: leash.available,
        leashColorAgreement: leash.agreement,
        leashColorAdjustment: leash.adjustment,
      };
    })
    .sort((a, b) => b.similarity - a.similarity);
}
