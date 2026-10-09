import sharp from "sharp";

export interface QualityMetrics {
  sharpness: number; // variance of Laplacian, unbounded, higher = sharper
  exposureScore: number; // 0-1, peaks at well-exposed mid-range brightness
  resolutionScore: number; // 0-1, saturates once the crop is comfortably model-sized
  aspectScore: number; // 0-1, proxy for "frontal/close" per plan §8 point 2 (no real landmark model in v1)
}

const REFERENCE_AREA_PX = 224 * 224; // a small embedding backbone's typical input size

/**
 * Practical heuristics only (blur/exposure/resolution/aspect) — no learned
 * aesthetic model. Animal facial-landmark detection is a much smaller research
 * area than for humans, so "face visible" is approximated via bbox aspect
 * ratio rather than true landmarks (flagged as a possible post-v1 investment
 * in the plan, §8 point 2).
 */
export async function scoreQuality(
  cropBuffer: Buffer,
  bboxWidth: number,
  bboxHeight: number
): Promise<QualityMetrics> {
  const image = sharp(cropBuffer).greyscale();
  const { width = 1, height = 1 } = await image.metadata();

  // Variance of Laplacian: a standard, cheap blur-detection technique.
  const laplacian = await image
    .clone()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .stats();
  const sharpness = laplacian.channels[0].stdev ** 2;

  const brightness = await sharp(cropBuffer).greyscale().stats();
  const meanBrightness = brightness.channels[0].mean; // 0-255
  // Peaks at 128 (mid-range), falls off toward blown-out or underexposed.
  const exposureScore = 1 - Math.abs(meanBrightness - 128) / 128;

  const resolutionScore = Math.min(1, (width * height) / REFERENCE_AREA_PX);

  // Close to 1:1 (a head-on headshot-style crop) scores highest; very wide/tall
  // crops (a pet mid-stride, partially out of frame) score lower.
  const aspectRatio = bboxWidth / bboxHeight;
  const aspectScore = Math.max(0, 1 - Math.abs(1 - aspectRatio));

  return { sharpness, exposureScore, resolutionScore, aspectScore };
}

/** Combines the raw metrics (plus the detector's own confidence) into one sortable score. */
export function compositeScore(metrics: QualityMetrics, detectorConfidence: number): number {
  const normalizedSharpness = Math.min(1, metrics.sharpness / 500); // empirical scale, tune against real photos
  return (
    normalizedSharpness * 0.35 +
    metrics.exposureScore * 0.2 +
    metrics.resolutionScore * 0.15 +
    metrics.aspectScore * 0.1 +
    detectorConfidence * 0.2
  );
}
