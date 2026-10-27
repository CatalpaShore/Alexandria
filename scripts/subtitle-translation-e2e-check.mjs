import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-subtitle-translation-e2e-"));
const dataDir = path.join(root, "data");
const mediaRoot = path.join(root, "media");
const mediaDir = path.join(mediaRoot, "A");
const speechPath = path.join(root, "speech.aiff");
const videoPath = path.join(mediaDir, "VOICE-001.mp4");
const embeddedChineseVideoPath = path.join(mediaDir, "VOICE-002-C.mp4");
fs.mkdirSync(mediaDir, { recursive: true });

process.env.DATA_DIR = dataDir;
process.env.THUMBNAIL_DIR = path.join(dataDir, "thumbnails");
process.env.DERIVATIVE_DIR = path.join(dataDir, "derivatives");
process.env.MEDIA_SOURCES = `JAV:Fixture=${mediaRoot}`;
process.env.MEDIA_LIBRARY_ROOTS = "";
process.env.SCAN_ON_START = "false";
process.env.METADATA_AUTO_ENRICH = "false";
process.env.SUBTITLE_WHISPER_COMMAND = process.env.SUBTITLE_WHISPER_COMMAND || "whisper";
const installedWhisperModel = ["large-v3-turbo", "small", "base"]
  .find((model) => fs.existsSync(path.join(os.homedir(), ".cache", "whisper.cpp", `ggml-${model}.bin`)))
  || "base";
process.env.SUBTITLE_WHISPER_MODEL = process.env.SUBTITLE_WHISPER_MODEL
  || installedWhisperModel;
process.env.SUBTITLE_WHISPER_THREADS = process.env.SUBTITLE_WHISPER_THREADS || "6";
process.env.SUBTITLE_TRANSLATION_PROVIDER = process.env.SUBTITLE_TRANSLATION_PROVIDER || "google";
process.env.SUBTITLE_TRANSLATION_DELAY_MS = "100";
process.env.SUBTITLE_CONTEXTUAL_TRANSLATION = "false";

let database;
let stopMediaJobWorker;
try {
  run("say", [
    "-v",
    "Kyoko",
    "こんにちは。今日はいい天気ですね。これは字幕翻訳のテストです。ご視聴ありがとうございます。",
    "-o",
    speechPath
  ]);
  if (fs.statSync(speechPath).size <= 4_096) {
    throw new Error("macOS 语音合成未生成音频；请授予终端语音资源权限后重试，已阻止 ffmpeg 对无限色视频持续写盘");
  }
  run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=24",
    "-i", speechPath,
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    videoPath
  ]);
  fs.writeFileSync(embeddedChineseVideoPath, "fixture with embedded Chinese subtitles\n", "utf8");

  const [{ db }, scanner, mediaJobs, subtitleTranslation] = await Promise.all([
    import("../server/src/db.ts"),
    import("../server/src/scanner.ts"),
    import("../server/src/mediaJobs.ts"),
    import("../server/src/subtitleTranslation.ts")
  ]);
  database = db;
  stopMediaJobWorker = mediaJobs.stopMediaJobWorker;

  const summary = await scanner.scanMediaLibrary({ forceFull: true });
  assert.equal(summary.indexed, 2);
  const media = db.prepare("SELECT id, relative_path AS relativePath FROM media_files WHERE normalized_code = 'VOICE-001'").get();
  assert.ok(media?.id);
  const embeddedChineseMedia = db.prepare("SELECT id FROM media_files WHERE normalized_code = 'VOICE-002'").get();
  assert.ok(embeddedChineseMedia?.id);
  const skippedEmbeddedTranslation = subtitleTranslation.requestSubtitleTranslation(embeddedChineseMedia.id, {
    trigger: "priority-auto"
  });
  assert.equal(skippedEmbeddedTranslation.status, "cancelled");
  assert.match(skippedEmbeddedTranslation.error ?? "", /内嵌中文字幕/);
  assert.equal(
    db.prepare("SELECT id FROM media_jobs WHERE media_id = ? AND job_type = 'subtitle-translate'").get(embeddedChineseMedia.id),
    undefined
  );

  fs.writeFileSync(path.join(dataDir, "favorites.txt"), `${media.relativePath}\n`, "utf8");
  assert.equal(subtitleTranslation.getFavoriteTranslationBacklogCount(), 1);
  assert.equal(subtitleTranslation.getTranslationPriorityBacklog().total, 1);
  subtitleTranslation.setAutoTranslateFavoritesEnabled(false);
  assert.equal(subtitleTranslation.getAutoTranslateFavoritesEnabled(), false);
  assert.equal(subtitleTranslation.enqueueNextFavoriteTranslationIfIdle(), null);
  subtitleTranslation.setAutoTranslateFavoritesEnabled(true);
  assert.equal(subtitleTranslation.getAutoTranslateFavoritesEnabled(), true);
  assert.equal(subtitleTranslation.enqueueNextFavoriteTranslationIfIdle(), media.id);
  assert.equal(subtitleTranslation.enqueueNextFavoriteTranslationIfIdle(), null);
  const queued = subtitleTranslation.getSubtitleTranslation(media.id);
  assert.equal(queued?.status, "pending");
  assert.equal(subtitleTranslation.getFavoriteTranslationBacklogCount(), 0);
  mediaJobs.startMediaJobWorker({ concurrency: 3, idleDelayMs: 100 });

  const deadline = Date.now() + 10 * 60_000;
  let translation;
  let lastStage = "";
  while (Date.now() < deadline) {
    translation = subtitleTranslation.getSubtitleTranslation(media.id);
    const stage = `${translation?.stage}:${translation?.progress}`;
    if (stage !== lastStage) {
      console.log(`translation ${stage}`);
      lastStage = stage;
    }
    if (translation?.status === "ready" || translation?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.equal(translation?.status, "ready", translation?.error || "translation timed out");
  assert.equal(translation?.sourceKind, "speech");
  assert.equal(translation?.stageProgress, 100);
  assert.equal(translation?.estimatedRemainingSeconds, 0);
  assert.equal(translation?.pipelineSteps.length, 6);
  assert.ok(translation?.pipelineSteps.every((step) => step.status === "complete"));
  assert.ok(translation.cueCount > 0);
  assert.equal(translation.translatedCueCount, translation.cueCount);
  const vtt = fs.readFileSync(translation.outputPath, "utf8");
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /[\u3400-\u9fff]/u);
  const persistedSourcePath = path.join(dataDir, "derivatives", "translated-subtitles", `${media.id}.source.vtt`);
  assert.equal(fs.existsSync(persistedSourcePath), true);
  assert.match(fs.readFileSync(persistedSourcePath, "utf8"), /[\u3040-\u30ff]/u);
  const translatedSidecar = subtitleTranslation.getReadyTranslationSidecar(media.id);
  assert.equal(translatedSidecar?.isTranslated, true);
  assert.equal(translatedSidecar?.trackUrl, `/api/media/${media.id}/subtitle-translation.vtt`);

  console.log("Subtitle translation end-to-end test passed");
  console.log(JSON.stringify({
    model: translation.model,
    provider: translation.provider,
    cues: translation.cueCount,
    outputPreview: vtt.split("\n").filter(Boolean).slice(0, 6)
  }, null, 2));

  const removal = subtitleTranslation.removeSubtitleTranslation(media.id);
  assert.equal(removal.action, "removed");
  assert.equal(fs.existsSync(translation.outputPath), false);
  assert.equal(fs.existsSync(persistedSourcePath), false);
  assert.equal(subtitleTranslation.enqueueNextFavoriteTranslationIfIdle(), null);
} finally {
  stopMediaJobWorker?.();
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (database?.open) database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
