import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { withOrgScope } from "../db/pool.js";
import type { ClaimedIdentityVideo } from "../queue/identityVideoQueue.js";
import { downloadObject, uploadObject } from "../s3/client.js";

const ffmpegBinary = ffmpegPath as unknown as string | null;
const MAX_FRAMES = 6;

export async function extractIdentityFrames(job: ClaimedIdentityVideo): Promise<void> {
  if (!ffmpegBinary) throw new Error("ffmpeg-static did not provide an FFmpeg binary for this platform");
  const context = await withOrgScope(job.organizationId, async (client) => {
    const result = await client.query(
      `SELECT uploaded_by, reference_pet_id, reference_session_id, content_type, duration_seconds
       FROM videos
       WHERE id = $1 AND organization_id = $2 AND media_purpose = 'identity_reference'
         AND processing_status = 'processing'`,
      [job.id, job.organizationId]
    );
    return result.rows[0];
  });
  if (!context) throw new Error("Claimed identity video was not found");

  const workDir = await mkdtemp(join(tmpdir(), `ucbarkley-identity-${job.id}-`));
  try {
    const extension = extname(job.storageKey) || (context.content_type === "video/quicktime" ? ".mov" : ".mp4");
    const inputPath = join(workDir, `arrival${extension}`);
    await writeFile(inputPath, await downloadObject(job.storageKey));
    const durationSeconds = Math.min(30, Math.max(1, Number(context.duration_seconds ?? 7.5)));
    const frameIntervalSeconds = durationSeconds / MAX_FRAMES;
    await runFfmpeg(ffmpegBinary, [
      "-y", "-i", inputPath,
      "-vf", `fps=1/${frameIntervalSeconds.toFixed(3)},scale='min(1600,iw)':-2`,
      "-frames:v", String(MAX_FRAMES),
      "-q:v", "2",
      join(workDir, "frame-%02d.jpg"),
    ]);
    const frameFiles = (await readdir(workDir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    if (frameFiles.length === 0) throw new Error("No usable frames could be extracted from the video");

    await withOrgScope(job.organizationId, async (client) => {
      const batch = await client.query(
        `INSERT INTO photo_batches (organization_id, uploaded_by, photo_count)
         VALUES ($1, $2, $3) RETURNING id`,
        [job.organizationId, context.uploaded_by, frameFiles.length]
      );
      for (const [index, frameFile] of frameFiles.entries()) {
        const key = `raw/${job.organizationId}/${batch.rows[0].id}/${job.id}-frame-${String(index + 1).padStart(2, "0")}.jpg`;
        await uploadObject(key, await readFile(join(workDir, frameFile)), "image/jpeg");
        await client.query(
          `INSERT INTO photos
             (organization_id, batch_id, uploaded_by, storage_key, processing_status,
              media_purpose, reference_pet_id, reference_session_id, source_video_id)
           VALUES ($1, $2, $3, $4, 'uploaded', 'identity_reference', $5, $6, $7)`,
          [
            job.organizationId,
            batch.rows[0].id,
            context.uploaded_by,
            key,
            context.reference_pet_id,
            context.reference_session_id,
            job.id,
          ]
        );
      }
      await client.query(
        `UPDATE videos
         SET processing_status = 'processed', processing_error = NULL, extracted_frame_count = $1
         WHERE id = $2 AND organization_id = $3`,
        [frameFiles.length, job.id, job.organizationId]
      );
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(binary: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr}`)));
  });
}
