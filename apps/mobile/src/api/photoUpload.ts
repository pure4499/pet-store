import { File } from "expo-file-system";
import { apiFetch } from "./client";

export interface PickedPhoto {
  clientId: string;
  uri: string;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface UploadProgressUpdate {
  fileName: string;
  status: "pending" | "uploading" | "done" | "failed";
}

export interface PhotoAiSuggestion {
  detectionId: string;
  petId: string;
  sessionId: string;
  petName: string;
  confidence: number | null;
  detectorConfidence: number | null;
  matchStatus: "matched" | "low_confidence" | "no_match" | "manually_assigned" | "manually_rejected";
}

export interface BatchAiSuggestions {
  id: string;
  photos: {
    id: string;
    processingStatus: "uploaded" | "queued" | "processing" | "processed" | "failed";
    processingError: string | null;
    suggestions: PhotoAiSuggestion[];
  }[];
}

const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Batches + uploads photos directly to S3 via presigned URLs (never proxied
 * through the API), capped at a small concurrency since on-site hotel wifi
 * isn't guaranteed reliable (plan §6). This is the "highest client-side
 * technical-risk surface" the plan flags — background upload (continuing once
 * the app is fully suspended, not just open) needs a custom EAS dev client
 * and is called out there as a risk to spike early, not something this
 * foreground batch uploader already solves.
 */
export async function uploadPhotoBatch(
  photos: PickedPhoto[],
  onProgress?: (update: UploadProgressUpdate) => void
): Promise<{
  batchId: string;
  uploadedPhotoIds: string[];
  uploads: { clientId: string; photoId: string; status: "done" | "failed" }[];
}> {
  const batch = await apiFetch<{ id: string }>("/photo-batches", { method: "POST" });
  const files = photos.map((photo) => new File(photo.uri));

  const uploadUrls = await apiFetch<{ photoId: string; storageKey: string; uploadUrl: string }[]>(
    "/photos/upload-urls",
    {
      method: "POST",
      body: JSON.stringify({
        batchId: batch.id,
        files: photos.map((p, index) => ({
          fileName: p.fileName,
          contentType: p.mimeType,
          fileSizeBytes: files[index].size,
          width: p.width,
          height: p.height,
        })),
      }),
    }
  );

  const uploadedPhotoIds: string[] = [];
  const uploads: { clientId: string; photoId: string; status: "done" | "failed" }[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < photos.length) {
      const index = cursor++;
      const photo = photos[index];
      const target = uploadUrls[index];
      onProgress?.({ fileName: photo.fileName, status: "uploading" });
      try {
        const file = files[index];
        const result = await file.upload(target.uploadUrl, {
          httpMethod: "PUT",
          headers: { "content-type": photo.mimeType },
        });
        if (result.status >= 200 && result.status < 300) {
          await apiFetch(`/photos/${target.photoId}/confirm-upload`, {
            method: "POST",
            body: JSON.stringify({ fileSizeBytes: file.size }),
          });
          uploadedPhotoIds.push(target.photoId);
          uploads.push({ clientId: photo.clientId, photoId: target.photoId, status: "done" });
          onProgress?.({ fileName: photo.fileName, status: "done" });
        } else {
          uploads.push({ clientId: photo.clientId, photoId: target.photoId, status: "failed" });
          onProgress?.({ fileName: photo.fileName, status: "failed" });
        }
      } catch {
        uploads.push({ clientId: photo.clientId, photoId: target.photoId, status: "failed" });
        onProgress?.({ fileName: photo.fileName, status: "failed" });
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_CONCURRENT_UPLOADS }, worker));

  return { batchId: batch.id, uploadedPhotoIds, uploads };
}

export async function uploadIdentityPhotoBatch(
  photos: PickedPhoto[],
  petId: string,
  sessionId: string,
  onProgress?: (update: UploadProgressUpdate) => void
): Promise<{ batchId: string; uploadedCount: number }> {
  const batch = await apiFetch<{ id: string }>("/photo-batches", { method: "POST" });
  const files = photos.map((photo) => new File(photo.uri));
  const targets = await apiFetch<{ photoId: string; uploadUrl: string }[]>("/photos/upload-urls", {
    method: "POST",
    body: JSON.stringify({
      batchId: batch.id,
      deferProcessing: true,
      identityReference: { petId, sessionId },
      files: photos.map((photo, index) => ({
        fileName: photo.fileName,
        contentType: photo.mimeType,
        fileSizeBytes: files[index].size,
        width: photo.width,
        height: photo.height,
      })),
    }),
  });
  let uploadedCount = 0;
  for (const [index, photo] of photos.entries()) {
    const target = targets[index];
    onProgress?.({ fileName: photo.fileName, status: "uploading" });
    try {
      const file = files[index];
      const result = await file.upload(target.uploadUrl, {
        httpMethod: "PUT",
        headers: { "content-type": photo.mimeType },
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`Photo upload failed (${result.status})`);
      await apiFetch(`/photos/${target.photoId}/confirm-upload`, {
        method: "POST",
        body: JSON.stringify({ fileSizeBytes: file.size }),
      });
      uploadedCount += 1;
      onProgress?.({ fileName: photo.fileName, status: "done" });
    } catch (error) {
      onProgress?.({ fileName: photo.fileName, status: "failed" });
      throw error;
    }
  }
  return { batchId: batch.id, uploadedCount };
}

export async function waitForBatchAiSuggestions(
  batchId: string,
  timeoutMs = 60_000
): Promise<BatchAiSuggestions> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await apiFetch<BatchAiSuggestions>(`/photo-batches/${batchId}/suggestions`);
    const finished = result.photos.every((photo) =>
      photo.processingStatus === "processed" || photo.processingStatus === "failed"
    );
    if (finished) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error("AI analysis timed out");
}

export async function confirmPhotoAssignments(
  photoId: string,
  assignments: { petId: string; sessionId: string; sourceDetectionId?: string }[]
): Promise<void> {
  await apiFetch(`/photos/${photoId}/confirm-assignments`, {
    method: "POST",
    body: JSON.stringify({ assignments }),
  });
}
