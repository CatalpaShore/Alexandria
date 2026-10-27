import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const restoreLockPath = path.join(config.dataDir, "restore.lock");
const restoreWorkerAckPath = path.join(config.dataDir, "restore-worker.stopped");

async function waitForRestoreWindow(): Promise<void> {
  while (fs.existsSync(restoreLockPath)) {
    console.log("Media worker waiting for database restore to finish");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  fs.rmSync(restoreWorkerAckPath, { force: true });
}

await waitForRestoreWindow();
await import("./mediaDerivatives.js");
await import("./storyboards.js");
await import("./contentPreviews.js");
await import("./highlights.js");
const subtitleDerivatives = await import("./subtitleDerivatives.js");
await import("./subtitleTranslation.js");
await import("./thumbnails.js");
const mediaJobs = await import("./mediaJobs.js");
const { db } = await import("./db.js");

const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

console.log(`Media worker starting with concurrency=${config.mediaWorkerConcurrency}`);
mediaJobs.startMediaJobWorker({ concurrency: config.mediaWorkerConcurrency });
mediaJobs.markMediaWorkerHeartbeat();
const startupSchedule = mediaJobs.getMediaJobStatus().schedule;
console.log(
  `Media worker schedule timezone=${startupSchedule.timeZone} night=${startupSchedule.nightStartHour}:00-${startupSchedule.nightEndHour}:00 daytimeCooldown=${Math.round(startupSchedule.daytimeCooldownMs / 60_000)}m ffmpegThreads=${startupSchedule.ffmpegThreads} nice=${startupSchedule.processNiceness}`
);

const queued = mediaJobs.enqueuePendingProbeJobs(config.mediaProbeStartupBatch);
if (queued > 0) console.log(`Queued ${queued} background media probes`);
const subtitleJobs = subtitleDerivatives.enqueuePendingSubtitleJobs(240);
if (subtitleJobs > 0) console.log(`Queued ${subtitleJobs} subtitle cache jobs`);

let restoreStopping = false;
const restoreWatchTimer = setInterval(() => {
  if (!fs.existsSync(restoreLockPath)) return;
  if (restoreStopping) return;
  restoreStopping = true;
  console.log("Media worker pausing for database restore");
  mediaJobs.stopMediaJobWorker();
  void mediaJobs.waitForMediaJobWorkerStop(15_000)
    .then(() => {
      if (db.open) db.close();
      fs.writeFileSync(
        restoreWorkerAckPath,
        `${JSON.stringify({ pid: process.pid, stoppedAt: new Date().toISOString() })}\n`
      );
      setTimeout(() => process.exit(0), 100).unref();
    })
    .catch((error) => {
      console.error("Media worker could not stop safely for restore", error);
      setTimeout(() => process.exit(1), 100).unref();
    });
}, 1_000);

const statusTimer = setInterval(() => {
  mediaJobs.markMediaWorkerHeartbeat();
  const status = mediaJobs.getMediaJobStatus();
  const pending = status.counts
    .filter((entry) => entry.status === "pending" || entry.status === "running")
    .reduce((sum, entry) => sum + entry.count, 0);
  console.log(`Media worker heartbeat pending=${pending} playbackActive=${status.playbackActive}`);
}, 15_000);
statusTimer.unref();

for (const signal of shutdownSignals) {
  process.once(signal, () => {
    console.log(`Media worker received ${signal}, stopping`);
    mediaJobs.stopMediaJobWorker();
    clearInterval(statusTimer);
    clearInterval(restoreWatchTimer);
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}
