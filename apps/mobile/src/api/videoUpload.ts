import { File } from "expo-file-system";
import { apiFetch } from "./client";

export interface PickedVideo {
  clientId: string;
  uri: string;
  fileName: string;
  mimeType: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export async function uploadVideo(
  video: PickedVideo,
  identityReference?: { petId: string; sessionId: string }
): Promise<{ videoId: string }> {
  const file = new File(video.uri);
  const target = await apiFetch<{ videoId: string; uploadUrl: string }>("/videos/upload-url", {
    method: "POST",
    body: JSON.stringify({
      fileName: video.fileName,
      contentType: video.mimeType,
      fileSizeBytes: file.size,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      identityReference,
    }),
  });
  const result = await file.upload(target.uploadUrl, {
    httpMethod: "PUT",
    headers: { "content-type": video.mimeType },
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`Video upload failed (${result.status})`);
  await apiFetch(`/videos/${target.videoId}/confirm-upload`, {
    method: "POST",
    body: JSON.stringify({ fileSizeBytes: file.size }),
  });
  return { videoId: target.videoId };
}
