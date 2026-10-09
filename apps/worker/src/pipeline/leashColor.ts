import sharp from "sharp";

export interface LeashColorSignal {
  detected: true;
  hue: number;
  saturation: number;
  value: number;
  confidence: number;
  source: "narrow_color_region";
}

interface PixelPoint {
  x: number;
  y: number;
  hue: number;
  saturation: number;
  value: number;
}

const ANALYSIS_SIZE = 144;
const HUE_BUCKETS = 12;
const MIN_COMPONENT_PIXELS = 7;

function rgbToHsv(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
    else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: maximum === 0 ? 0 : delta / maximum, value: maximum };
}

function circularHueDistance(first: number, second: number) {
  const direct = Math.abs(first - second);
  return Math.min(direct, 360 - direct);
}

function hueFromHex(color: string | null | undefined) {
  const match = color?.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return rgbToHsv((value >> 16) & 255, (value >> 8) & 255, value & 255).hue;
}

function componentElongation(points: PixelPoint[]) {
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= points.length;
  yy /= points.length;
  xy /= points.length;
  const trace = xx + yy;
  const determinant = xx * yy - xy * xy;
  const root = Math.sqrt(Math.max(0, trace * trace / 4 - determinant));
  const major = trace / 2 + root;
  const minor = trace / 2 - root;
  return major / Math.max(0.35, minor);
}

/**
 * Finds a conservative leash-like color signal near a detected pet. This is
 * intentionally not a general object classifier: it accepts only compact,
 * saturated, narrow regions and ignores large colorful backgrounds/clothing.
 * A missing signal is the normal outcome and must never count against a pet.
 */
export async function detectLeashColor(
  image: Buffer,
  petBox: { bboxX: number; bboxY: number; bboxWidth: number; bboxHeight: number },
  assignedColorHex?: string | null
): Promise<LeashColorSignal | null> {
  const { data, info } = await sharp(image)
    .rotate()
    .resize({ width: ANALYSIS_SIZE, height: ANALYSIS_SIZE, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels < 3 || info.width < 8 || info.height < 8) return null;

  const marginX = petBox.bboxWidth * 0.2;
  const marginY = petBox.bboxHeight * 0.2;
  const left = Math.max(0, Math.floor((petBox.bboxX - marginX) * info.width));
  const top = Math.max(0, Math.floor((petBox.bboxY - marginY) * info.height));
  const right = Math.min(info.width - 1, Math.ceil((petBox.bboxX + petBox.bboxWidth + marginX) * info.width));
  const bottom = Math.min(info.height - 1, Math.ceil((petBox.bboxY + petBox.bboxHeight + marginY) * info.height));
  const regionArea = Math.max(1, (right - left + 1) * (bottom - top + 1));
  const assignedHue = hueFromHex(assignedColorHex);
  const pointsByBucket = Array.from({ length: HUE_BUCKETS }, () => new Map<number, PixelPoint>());

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const hsv = rgbToHsv(data[offset], data[offset + 1], data[offset + 2]);
      // Brightly colored operational leashes are the reliable case. Neutral,
      // black, white, or very dark accessories deliberately produce no signal.
      if (hsv.saturation < 0.48 || hsv.value < 0.24) continue;
      const bucket = Math.floor((hsv.hue / 360) * HUE_BUCKETS) % HUE_BUCKETS;
      pointsByBucket[bucket].set(y * info.width + x, { x, y, ...hsv });
    }
  }

  let best: LeashColorSignal | null = null;
  for (const bucketPoints of pointsByBucket) {
    const unvisited = new Set(bucketPoints.keys());
    while (unvisited.size > 0) {
      const first = unvisited.values().next().value as number;
      unvisited.delete(first);
      const queue = [first];
      const component: PixelPoint[] = [];
      while (queue.length > 0) {
        const key = queue.pop()!;
        const point = bucketPoints.get(key);
        if (!point) continue;
        component.push(point);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const neighbor = (point.y + dy) * info.width + point.x + dx;
            if (unvisited.delete(neighbor)) queue.push(neighbor);
          }
        }
      }

      if (component.length < MIN_COMPONENT_PIXELS || component.length > regionArea * 0.075) continue;
      const elongation = componentElongation(component);
      if (elongation < 5.5) continue;
      const hue = component.reduce((total, point) => total + point.hue, 0) / component.length;
      // A staff-assigned stay color is useful validation, but never evidence by
      // itself: the matching narrow region must still be visibly present.
      if (assignedHue !== null && circularHueDistance(hue, assignedHue) > 32) continue;
      const saturation = component.reduce((total, point) => total + point.saturation, 0) / component.length;
      const value = component.reduce((total, point) => total + point.value, 0) / component.length;
      const sizeConfidence = Math.min(1, component.length / Math.max(12, regionArea * 0.012));
      const shapeConfidence = Math.min(1, (elongation - 5.5) / 12);
      const confidence = Math.min(0.98, 0.48 + 0.24 * sizeConfidence + 0.2 * shapeConfidence + 0.08 * saturation);
      if (!best || confidence > best.confidence) {
        best = { detected: true, hue, saturation, value, confidence, source: "narrow_color_region" };
      }
    }
  }
  return best;
}

export function leashColorAgreement(query: unknown, reference: unknown) {
  const first = query as Partial<LeashColorSignal> | null;
  const second = reference as Partial<LeashColorSignal> | null;
  if (!first?.detected || !second?.detected || Number(first.confidence) < 0.68 || Number(second.confidence) < 0.68) {
    return { available: false, agreement: 0, adjustment: 0 };
  }
  const hueDistance = circularHueDistance(Number(first.hue), Number(second.hue));
  const agreement = Math.max(0, 1 - hueDistance / 90);
  // Bounded to five score points end-to-end: useful for similar-looking pets,
  // but far too small to rescue a weak appearance match.
  const adjustment = agreement >= 0.72
    ? 0.03 * agreement
    : agreement <= 0.22
      ? -0.02 * (1 - agreement)
      : 0;
  return { available: true, agreement, adjustment };
}
