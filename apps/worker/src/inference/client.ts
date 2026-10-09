import { config } from "../config.js";

export interface Detection {
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
  confidence: number;
  speciesGuess: "dog" | "cat" | "pet" | "unknown";
  reviewOnly?: boolean;
}

// This is the internal contract insulating the rest of the system from the
// CPU-vs-GPU hosting decision (plan §7): the worker only ever talks HTTP to
// whatever is behind INFERENCE_SERVICE_URL, so swapping that hosting choice
// later never touches this file.
export async function detect(imageBuffer: Buffer): Promise<Detection[]> {
  const response = await fetch(`${config.inferenceServiceUrl}/detect`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: imageBuffer,
  });
  if (!response.ok) {
    throw new Error(`Inference /detect failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { detections: Detection[] };
  return body.detections;
}

export interface EmbeddingResult {
  embedding: number[];
  modelVersion: string;
  dimensions: number;
}

export async function embed(cropBuffer: Buffer): Promise<EmbeddingResult> {
  const response = await fetch(`${config.inferenceServiceUrl}/embed`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: cropBuffer,
  });
  if (!response.ok) {
    throw new Error(`Inference /embed failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as Partial<EmbeddingResult>;
  if (!Array.isArray(body.embedding) || !body.embedding.length) {
    throw new Error("Inference /embed returned no embedding");
  }
  return {
    embedding: body.embedding,
    // Backward-compatible during rolling deploys. The old inference image is
    // necessarily the ResNet baseline.
    modelVersion: body.modelVersion ?? "resnet18-imagenet-v1",
    dimensions: body.dimensions ?? body.embedding.length,
  };
}
