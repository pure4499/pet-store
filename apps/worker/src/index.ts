import { config } from "./config.js";
import { processPhoto } from "./pipeline/processPhoto.js";
import { renderReportVideo } from "./pipeline/renderReportVideo.js";
import { extractIdentityFrames } from "./pipeline/extractIdentityFrames.js";
import { PollingIdentityVideoQueue } from "./queue/identityVideoQueue.js";
import { PollingPhotoQueue } from "./queue/photoQueue.js";
import { PollingReportVideoQueue } from "./queue/reportVideoQueue.js";

const queue = new PollingPhotoQueue();
const reportVideoQueue = new PollingReportVideoQueue();
const identityVideoQueue = new PollingIdentityVideoQueue();
let shuttingDown = false;

async function tick() {
  const identityVideos = await identityVideoQueue.poll(1);
  for (const video of identityVideos) {
    console.log(`extracting identity frames from video ${video.id} (org ${video.organizationId})`);
    try {
      await extractIdentityFrames(video);
      console.log(`extracted identity frames from video ${video.id}`);
    } catch (err) {
      console.error(`failed identity video ${video.id}:`, err);
      await identityVideoQueue.reportFailure(video, err);
    }
  }

  const claimed = await queue.poll(5);
  for (const photo of claimed) {
    console.log(`processing photo ${photo.id} (org ${photo.organizationId})`);
    try {
      await processPhoto(photo);
      console.log(`processed photo ${photo.id}`);
    } catch (err) {
      console.error(`failed photo ${photo.id}:`, err);
      // Local-dev equivalent of SQS's visibility-timeout retry + DLQ: mark
      // failed rather than silently retrying forever. A production SQS-backed
      // queue would redeliver on visibility timeout and DLQ after N attempts.
      await queue.reportFailure(photo, err);
    }
  }

  const videoJobs = await reportVideoQueue.poll(1);
  for (const job of videoJobs) {
    console.log(`rendering report video ${job.id} (org ${job.organizationId})`);
    try {
      await renderReportVideo(job);
      console.log(`rendered report video ${job.id}`);
    } catch (err) {
      console.error(`failed report video ${job.id}:`, err);
      await reportVideoQueue.reportFailure(job, err);
    }
  }
}

async function loop() {
  while (!shuttingDown) {
    try {
      await tick();
    } catch (err) {
      console.error("poll tick failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

process.on("SIGTERM", () => {
  shuttingDown = true;
});
process.on("SIGINT", () => {
  shuttingDown = true;
});

console.log(`Worker started, polling every ${config.pollIntervalMs}ms`);
loop();
