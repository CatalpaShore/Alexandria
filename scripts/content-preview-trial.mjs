import { performance } from "node:perf_hooks";

const defaultTrialIds = [
  "0db51a588627eb45",
  "73117f2ce7d627db",
  "2a33f44041379e30",
  "4d283e3a763ea55a",
  "5d97ccbe81b37f9a",
  "cf9c9dc7de929a9a",
  "cb016a0846664345",
  "ed968520c9c52072",
  "2daded8658944de7",
  "09efe47cffd7d376"
];

const ids = (process.env.CONTENT_PREVIEW_TRIAL_IDS ?? defaultTrialIds.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .slice(0, 10);

const [{ db }, previews, mediaJobs] = await Promise.all([
  import("../server/src/db.ts"),
  import("../server/src/contentPreviews.ts"),
  import("../server/src/mediaJobs.ts")
]);

const storage = previews.inspectContentPreviewStorage();
if (!storage.ready) throw new Error(storage.message);
if (mediaJobs.getMediaJobStatus().playbackActive) {
  throw new Error("Playback is active; stop playback before running the content preview trial");
}

const results = [];
try {
  for (let index = 0; index < ids.length; index += 1) {
    const media = db.prepare("SELECT * FROM media_files WHERE id = ?").get(ids[index]);
    if (!media) {
      results.push({ id: ids[index], status: "failed", error: "Media not found" });
      continue;
    }
    const label = media.normalized_code || media.basename;
    console.log(`[${index + 1}/${ids.length}] ${label} · ${media.video_codec || "unknown"} · ${Math.round((media.duration_seconds ?? 0) / 60)} min`);
    const startedAt = performance.now();
    try {
      const manifest = await previews.generateContentPreview(media);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const result = {
        id: media.id,
        code: label,
        source: media.source_name,
        codec: media.video_codec,
        extension: media.extension,
        durationMinutes: Math.round(((media.duration_seconds ?? manifest.durationSeconds) / 60) * 10) / 10,
        fallbackShort: manifest.window.fallbackShort,
        photos: manifest.photos.length,
        gifs: manifest.gifs.length,
        bytes: manifest.totalBytes,
        elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
        status: "ready"
      };
      results.push(result);
      console.log(`  ready · ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MiB · ${result.elapsedSeconds}s`);
    } catch (error) {
      const result = {
        id: media.id,
        code: label,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
      results.push(result);
      console.error(`  failed · ${result.error}`);
    }
  }
} finally {
  if (db.open) db.close();
}

const ready = results.filter((result) => result.status === "ready");
const summary = {
  requested: ids.length,
  ready: ready.length,
  failed: results.length - ready.length,
  totalBytes: ready.reduce((sum, result) => sum + (result.bytes ?? 0), 0),
  totalElapsedSeconds: Math.round(ready.reduce((sum, result) => sum + (result.elapsedSeconds ?? 0), 0) * 10) / 10,
  results
};
console.log("CONTENT_PREVIEW_TRIAL_RESULT");
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;
