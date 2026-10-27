import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { db, type MediaRow } from "./db.js";
import { readFavoriteKeys } from "./favorites.js";
import { trackFfmpegProcess } from "./ffmpegProcesses.js";
import { withMediaWorkerFfmpegLimits } from "./ffmpegResources.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";
import { externalAiWaitError, inspectExternalAiRuntime } from "./externalAiRuntime.js";
import {
  enqueueMediaJob,
  isMediaSourceWaitError,
  mediaSourceWaitError,
  registerMediaJobHandler,
  registerMediaJobIdleRefillHandler
} from "./mediaJobs.js";
import { subtitleToVtt } from "./services/subtitleService.js";
import {
  correctJapaneseCuesWithOllama,
  correctJapaneseRecognitionWithContext,
  shouldUseStandaloneAsrCorrection,
  translateContextualCuesIndividually,
  translateWithDedicatedOllama
} from "./services/subtitleContextualTranslation.js";
import {
  buildVtt,
  assessSubtitleTranslationText,
  filterSpeechCuesByVad,
  hasPositiveCueDuration,
  normalizeSpeechRecognitionText,
  normalizeRepeatedSpeechText,
  normalizeTranslatedSpeechText,
  parseVadSpeechIntervals,
  parseVttCues,
  sanitizeSpeechCues,
  type SubtitleCue
} from "./services/subtitleTranslationText.js";

export { buildVtt, parseVttCues, sanitizeSpeechCues } from "./services/subtitleTranslationText.js";

export type SubtitleTranslationStatus = "pending" | "running" | "ready" | "failed" | "cancelled";
export type SubtitleTranslationStage = "queued" | "source" | "extracting" | "transcribing" | "translating" | "writing" | "ready" | "failed" | "cancelled";
export type SubtitleTranslationPipelineStepStatus = "pending" | "active" | "complete" | "skipped" | "failed" | "cancelled";
export type SubtitleTranslationEstimateConfidence = "calculating" | "low" | "medium" | "high";

export type SubtitleTranslationPipelineStep = {
  key: "queued" | "source" | "extracting" | "transcribing" | "translating" | "writing";
  label: string;
  status: SubtitleTranslationPipelineStepStatus;
};

export type SubtitleTranslation = {
  mediaId: string;
  mediaJobId: string;
  status: SubtitleTranslationStatus;
  stage: SubtitleTranslationStage;
  progress: number;
  stageProgress: number;
  stageStartedAt: string | null;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  estimateConfidence: SubtitleTranslationEstimateConfidence;
  pipelineSteps: SubtitleTranslationPipelineStep[];
  sourceKind: string;
  sourceSidecarId: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  outputPath: string;
  bytes: number;
  cueCount: number;
  translatedCueCount: number;
  provider: string;
  model: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

type TranslationRow = {
  media_id: string;
  media_job_id: string;
  status: SubtitleTranslationStatus;
  stage: SubtitleTranslationStage;
  progress: number;
  stage_progress: number;
  stage_started_at: string;
  source_kind: string;
  source_sidecar_id: string | null;
  source_language: string;
  target_language: string;
  output_path: string;
  bytes: number;
  cue_count: number;
  translated_cue_count: number;
  provider: string;
  model: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

type TranslationQueueTier = "media-favorite" | "topic-favorite" | "actor-favorite" | "library";

type TranslationPriorityBacklog = {
  total: number;
  mediaFavorites: number;
  topicFavorites: number;
  actorFavorites: number;
  library: number;
};

type SubtitleSource = {
  kind: "sidecar" | "embedded" | "speech" | "existing-chinese";
  language: string;
  sidecarId: string | null;
  vtt: string;
  model?: string;
};

const outputDir = path.join(config.derivativeDir, "translated-subtitles");
const temporaryDir = path.join(outputDir, ".work");
const translationCheckpointVersion = 1;
const autoFavoriteTranslationSettingKey = "subtitle-translation:auto-favorites";

type TranslationCheckpoint = {
  version: number;
  fingerprint: string;
  correctedSourceCues: SubtitleCue[];
  translatedCues: SubtitleCue[];
};

function translationCheckpointPath(mediaId: string): string {
  return path.join(temporaryDir, `${mediaId}.translation-checkpoint.json`);
}

function translationCheckpointFingerprint(cues: SubtitleCue[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: translationCheckpointVersion,
      source: buildVtt(cues),
      contextualModel: config.subtitleTranslation.contextualTranslationModel,
      asrCorrectionModel: config.subtitleTranslation.asrCorrectionModel,
      dedicatedModel: config.subtitleTranslation.dedicatedTranslationModel,
      batchSize: config.subtitleTranslation.contextualTranslationBatchSize
    }))
    .digest("hex");
}

function validCheckpointCues(value: unknown, sourceCues: SubtitleCue[]): value is SubtitleCue[] {
  return Array.isArray(value)
    && value.length <= sourceCues.length
    && value.every((cue, index) => (
      cue
      && typeof cue === "object"
      && typeof (cue as SubtitleCue).timing === "string"
      && typeof (cue as SubtitleCue).text === "string"
      && (cue as SubtitleCue).text.trim().length > 0
      && (cue as SubtitleCue).timing === sourceCues[index]?.timing
    ));
}

async function loadTranslationCheckpoint(
  mediaId: string,
  sourceCues: SubtitleCue[],
  fingerprint: string
): Promise<TranslationCheckpoint | null> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(translationCheckpointPath(mediaId), "utf8")
    ) as Partial<TranslationCheckpoint>;
    if (parsed.version !== translationCheckpointVersion || parsed.fingerprint !== fingerprint) return null;
    if (!validCheckpointCues(parsed.correctedSourceCues, sourceCues)) return null;
    if (!validCheckpointCues(parsed.translatedCues, sourceCues)) return null;
    if (parsed.correctedSourceCues.length !== parsed.translatedCues.length) return null;
    let validLength = parsed.translatedCues.length;
    for (let index = 0; index < parsed.translatedCues.length; index += 1) {
      const quality = assessSubtitleTranslationText(
        parsed.correctedSourceCues[index]?.text ?? sourceCues[index]?.text ?? "",
        parsed.translatedCues[index]?.text ?? ""
      );
      if (!quality.okay) {
        validLength = index;
        break;
      }
    }
    if (validLength === 0) return null;
    return {
      ...(parsed as TranslationCheckpoint),
      correctedSourceCues: parsed.correctedSourceCues.slice(0, validLength),
      translatedCues: parsed.translatedCues.slice(0, validLength)
    };
  } catch {
    return null;
  }
}

async function saveTranslationCheckpoint(
  mediaId: string,
  fingerprint: string,
  correctedSourceCues: SubtitleCue[],
  translatedCues: SubtitleCue[]
): Promise<void> {
  await fs.promises.mkdir(temporaryDir, { recursive: true });
  const checkpointPath = translationCheckpointPath(mediaId);
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify({
    version: translationCheckpointVersion,
    fingerprint,
    correctedSourceCues,
    translatedCues
  } satisfies TranslationCheckpoint), "utf8");
  await fs.promises.rename(temporaryPath, checkpointPath);
}

async function removeTranslationCheckpoint(mediaId: string): Promise<void> {
  await fs.promises.rm(translationCheckpointPath(mediaId), { force: true });
}
const chineseLanguagePattern = /^(zh|zho|chi|chs|cht)(-|$)/i;
const pipelineStepDefinitions: Array<Pick<SubtitleTranslationPipelineStep, "key" | "label">> = [
  { key: "queued", label: "排队" },
  { key: "source", label: "检测字幕源" },
  { key: "extracting", label: "提取音频" },
  { key: "transcribing", label: "语音识别" },
  { key: "translating", label: "中文字幕翻译" },
  { key: "writing", label: "写入字幕" }
];
const stageProgressFloor: Record<SubtitleTranslationPipelineStep["key"], number> = {
  queued: 0,
  source: 3,
  extracting: 8,
  transcribing: 20,
  translating: 50,
  writing: 98
};

function translatedSourceOutputPath(mediaId: string): string {
  return path.join(outputDir, `${mediaId}.source.vtt`);
}

async function findPersistedSpeechSource(mediaId: string): Promise<SubtitleSource | null> {
  const row = getTranslationRow(mediaId);
  const sourcePath = translatedSourceOutputPath(mediaId);
  if (row?.source_kind !== "speech" || !fileReadable(sourcePath)) return null;
  try {
    const vtt = await fs.promises.readFile(sourcePath, "utf8");
    if (parseVttCues(vtt).length === 0) return null;
    return {
      kind: "speech",
      language: row.source_language || config.subtitleTranslation.sourceLanguage,
      sidecarId: row.source_sidecar_id,
      vtt,
      model: row.model || config.subtitleTranslation.whisperModel
    };
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function commandAvailable(command: string): boolean {
  if (!command) return false;
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((directory) => {
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function fileReadable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

type WhisperBackendCapabilities = {
  preferred: "auto" | "whisper-cpp" | "openai";
  active: "whisper-cpp" | "openai" | "unavailable";
  whisperCppCommandAvailable: boolean;
  whisperCppModelAvailable: boolean;
  whisperCppVadAvailable: boolean;
  openAiWhisperAvailable: boolean;
};

function getWhisperBackendCapabilities(): WhisperBackendCapabilities {
  const settings = config.subtitleTranslation;
  const whisperCppCommandAvailable = commandAvailable(settings.whisperCppCommand);
  const whisperCppModelAvailable = fileReadable(settings.whisperCppModel);
  const whisperCppReady = whisperCppCommandAvailable && whisperCppModelAvailable;
  const openAiWhisperAvailable = commandAvailable(settings.whisperCommand);
  const active = settings.whisperBackend !== "openai" && whisperCppReady
    ? "whisper-cpp"
    : openAiWhisperAvailable
      ? "openai"
      : "unavailable";
  return {
    preferred: settings.whisperBackend,
    active,
    whisperCppCommandAvailable,
    whisperCppModelAvailable,
    whisperCppVadAvailable: settings.whisperCppVad
      && commandAvailable(settings.whisperCppVadCommand)
      && fileReadable(settings.whisperCppVadModel),
    openAiWhisperAvailable
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function secondsBetween(start: string | null | undefined, endMs: number): number {
  if (!start) return 0;
  const startedAt = Date.parse(start);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.round((endMs - startedAt) / 1000));
}

function shouldSkipPipelineStep(row: TranslationRow, key: SubtitleTranslationPipelineStep["key"]): boolean {
  if (!row.source_kind) return false;
  if ((key === "extracting" || key === "transcribing") && row.source_kind !== "speech") return true;
  return key === "translating" && row.source_kind === "existing-chinese";
}

function buildPipelineSteps(row: TranslationRow): SubtitleTranslationPipelineStep[] {
  const activeIndex = pipelineStepDefinitions.findIndex((step) => step.key === row.stage);
  const inferredIndex = pipelineStepDefinitions.reduce((latest, step, index) => (
    row.progress >= stageProgressFloor[step.key] ? index : latest
  ), 0);
  return pipelineStepDefinitions.map((step, index) => {
    if (shouldSkipPipelineStep(row, step.key)) return { ...step, status: "skipped" as const };
    if (row.status === "ready") return { ...step, status: "complete" as const };
    if (row.status === "pending") return { ...step, status: step.key === "queued" ? "active" as const : "pending" as const };
    if (row.status === "failed" || row.status === "cancelled") {
      if (index < inferredIndex) return { ...step, status: "complete" as const };
      if (index === inferredIndex) return { ...step, status: row.status as "failed" | "cancelled" };
      return { ...step, status: "pending" as const };
    }
    if (activeIndex >= 0 && index < activeIndex) return { ...step, status: "complete" as const };
    if (index === activeIndex) return { ...step, status: "active" as const };
    return { ...step, status: "pending" as const };
  });
}

function estimateFutureStageSeconds(
  row: TranslationRow,
  durationSeconds: number | null | undefined,
  currentStage: SubtitleTranslationStage
): number {
  const duration = Math.max(0, durationSeconds ?? 0);
  const whisperCpp = getWhisperBackendCapabilities().active === "whisper-cpp";
  const extraction = duration > 0 ? duration / 90 : 0;
  const transcription = duration > 0 ? duration / (whisperCpp ? 55 : 2.5) : 0;
  const translation = row.cue_count > 0
    ? row.cue_count * 0.14
    : duration > 0
      ? duration * 0.007
      : 0;
  if (currentStage === "queued") return extraction + transcription + translation + 10;
  if (currentStage === "source") return extraction + transcription + translation + 7;
  if (currentStage === "extracting") return transcription + translation + 4;
  if (currentStage === "transcribing") return translation + 4;
  if (currentStage === "translating") return 2;
  if (currentStage === "writing") return 0;
  return 0;
}

function estimateRemaining(
  row: TranslationRow,
  durationSeconds: number | null | undefined,
  stageElapsedSeconds: number
): { seconds: number | null; confidence: SubtitleTranslationEstimateConfidence } {
  if (row.status === "ready") return { seconds: 0, confidence: "high" };
  if (row.status === "failed" || row.status === "cancelled") return { seconds: null, confidence: "calculating" };
  if (row.status === "pending" || row.stage === "queued") return { seconds: null, confidence: "calculating" };

  const stageProgress = clampPercent(
    row.stage === "translating" && row.cue_count > 0
      ? row.translated_cue_count / row.cue_count * 100
      : row.stage_progress
  );
  const futureSeconds = estimateFutureStageSeconds(row, durationSeconds, row.stage);
  if (stageProgress >= 1 && stageProgress < 100 && stageElapsedSeconds >= 2) {
    const currentRemaining = stageElapsedSeconds * (100 - stageProgress) / stageProgress;
    return {
      seconds: Math.max(1, Math.round(currentRemaining + futureSeconds)),
      confidence: stageProgress >= 5 ? "high" : "medium"
    };
  }

  const fallbackSeconds = row.stage === "source"
    ? estimateFutureStageSeconds(row, durationSeconds, "source")
    : row.stage === "extracting" && durationSeconds
      ? durationSeconds / 90 + futureSeconds
      : row.stage === "transcribing" && durationSeconds
        ? durationSeconds / (getWhisperBackendCapabilities().active === "whisper-cpp" ? 55 : 2.5) + futureSeconds
        : row.stage === "translating" && row.cue_count > 0
          ? row.cue_count * 0.14
          : row.stage === "writing"
            ? 2
            : 0;
  return fallbackSeconds > 0
    ? { seconds: Math.max(1, Math.round(fallbackSeconds)), confidence: "low" }
    : { seconds: null, confidence: "calculating" };
}

function mapTranslation(
  row: TranslationRow,
  durationSeconds?: number | null
): SubtitleTranslation {
  const endMs = row.finished_at ? Date.parse(row.finished_at) : Date.now();
  const safeEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  const elapsedSeconds = secondsBetween(row.started_at, safeEndMs);
  const stageStartedAt = row.stage_started_at || row.started_at || row.updated_at || null;
  const stageElapsedSeconds = secondsBetween(stageStartedAt, safeEndMs);
  const stageProgress = row.status === "ready" ? 100 : clampPercent(row.stage_progress);
  const estimate = estimateRemaining(row, durationSeconds, stageElapsedSeconds);
  return {
    mediaId: row.media_id,
    mediaJobId: row.media_job_id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    stageProgress,
    stageStartedAt,
    elapsedSeconds,
    stageElapsedSeconds,
    estimatedRemainingSeconds: estimate.seconds,
    estimateConfidence: estimate.confidence,
    pipelineSteps: buildPipelineSteps(row),
    sourceKind: row.source_kind,
    sourceSidecarId: row.source_sidecar_id,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    outputPath: row.output_path,
    bytes: row.bytes,
    cueCount: row.cue_count,
    translatedCueCount: row.translated_cue_count,
    provider: row.provider,
    model: row.model,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

function getTranslationRow(mediaId: string): TranslationRow | undefined {
  return db.prepare("SELECT * FROM video_subtitle_translations WHERE media_id = ?").get(mediaId) as TranslationRow | undefined;
}

export function getSubtitleTranslation(mediaId: string): SubtitleTranslation | null {
  let row = getTranslationRow(mediaId);
  if (!row) return null;
  if ((row.status === "pending" || row.status === "running") && row.media_job_id) {
    const job = db.prepare("SELECT status, error FROM media_jobs WHERE id = ?").get(row.media_job_id) as {
      status: string;
      error: string | null;
    } | undefined;
    if (!job || job.status === "failed") {
      updateTranslation(mediaId, {
        status: "failed",
        stage: "failed",
        error: job?.error || "翻译任务执行记录已丢失，请重试",
        finished_at: nowIso()
      });
      row = getTranslationRow(mediaId)!;
    } else if (job.status === "pending" && row.status === "running") {
      updateTranslation(mediaId, {
        status: "pending",
        stage: "queued",
        progress: 0,
        stage_progress: 0,
        started_at: null
      });
      row = getTranslationRow(mediaId)!;
    }
  }
  if (row.status === "ready" && (!row.output_path || !fs.existsSync(row.output_path))) {
    db.prepare(`UPDATE video_subtitle_translations SET status = 'failed', stage = 'failed', error = '翻译字幕文件已丢失', updated_at = ? WHERE media_id = ?`)
      .run(nowIso(), mediaId);
    return getSubtitleTranslation(mediaId);
  }
  const media = db.prepare("SELECT duration_seconds AS durationSeconds FROM media_files WHERE id = ?")
    .get(mediaId) as { durationSeconds: number | null } | undefined;
  return mapTranslation(row, media?.durationSeconds);
}

function updateTranslation(mediaId: string, values: Record<string, unknown>): void {
  const nextValues = { ...values };
  if (typeof nextValues.stage === "string") {
    const current = getTranslationRow(mediaId);
    if (current && current.stage !== nextValues.stage) {
      nextValues.stage_started_at = nowIso();
      if (nextValues.stage_progress === undefined) nextValues.stage_progress = nextValues.stage === "ready" ? 100 : 0;
    }
  }
  const allowed = new Set([
    "media_job_id", "status", "stage", "progress", "stage_progress", "stage_started_at", "source_kind", "source_sidecar_id", "source_language",
    "target_language", "output_path", "bytes", "cue_count", "translated_cue_count", "provider", "model",
    "error", "started_at", "finished_at"
  ]);
  const entries = Object.entries(nextValues).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;
  const params: Record<string, unknown> = { mediaId, updatedAt: nowIso() };
  const assignments = entries.map(([key, value], index) => {
    const param = `value${index}`;
    params[param] = value;
    return `${key} = @${param}`;
  });
  db.prepare(`UPDATE video_subtitle_translations SET ${assignments.join(", ")}, updated_at = @updatedAt WHERE media_id = @mediaId`)
    .run(params);
}

function assertNotCancelled(mediaId: string): void {
  if (getTranslationRow(mediaId)?.status === "cancelled") throw new Error("翻译任务已取消");
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    shouldCancel?: () => boolean;
    onStderr?: (chunk: string) => void;
    captureStderr?: boolean;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const commandArgs = command === "ffmpeg" ? withMediaWorkerFfmpegLimits(args) : args;
    const child = trackFfmpegProcess(spawn(command, commandArgs, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }));
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : null;
    const cancellationTimer = options.shouldCancel
      ? setInterval(() => {
        if (options.shouldCancel?.()) child.kill("SIGTERM");
      }, 1_000)
      : null;
    cancellationTimer?.unref();
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
    };
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-200_000); });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(options.captureStderr ? -2_000_000 : -20_000);
      options.onStderr?.(text);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve(options.captureStderr ? `${stdout}\n${stderr}` : stdout);
      else reject(new Error(`${path.basename(command)} 执行失败（${signal ?? code}）：${stderr.trim().slice(-1200)}`));
    });
  });
}

function createStageProgressReporter(
  mediaId: string,
  stage: SubtitleTranslationStage,
  overallStart: number,
  overallEnd: number
): (progress: number) => void {
  let lastStageProgress = -1;
  let lastUpdateAt = 0;
  return (rawProgress: number) => {
    const stageProgress = clampPercent(rawProgress);
    const now = Date.now();
    if (stageProgress < 100 && stageProgress < lastStageProgress + 1 && now - lastUpdateAt < 2_000) return;
    lastStageProgress = stageProgress;
    lastUpdateAt = now;
    updateTranslation(mediaId, {
      stage,
      stage_progress: stageProgress,
      progress: Math.round(overallStart + (overallEnd - overallStart) * stageProgress / 100)
    });
  };
}

function createFfmpegProgressHandler(durationSeconds: number | null, report: (progress: number) => void) {
  let buffer = "";
  return (chunk: string) => {
    if (!durationSeconds || durationSeconds <= 0) return;
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^out_time=(\d+):(\d+):([\d.]+)/.exec(line.trim());
      if (!match) continue;
      const processedSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      report(processedSeconds / durationSeconds * 100);
    }
  };
}

function createWhisperProgressHandler(report: (progress: number) => void) {
  return (chunk: string) => {
    for (const match of chunk.matchAll(/progress\s*=\s*(\d{1,3})%|\b(\d{1,3})%/gi)) {
      report(Number(match[1] ?? match[2]));
    }
  };
}

async function findSidecarSource(mediaId: string): Promise<SubtitleSource | null> {
  const rows = db.prepare(`
    SELECT id, absolute_path AS absolutePath, language, format
    FROM media_sidecars
    WHERE media_id = ? AND kind = 'subtitle'
    ORDER BY CASE WHEN language LIKE 'zh%' THEN 0 WHEN language LIKE 'ja%' THEN 1 ELSE 2 END, updated_at DESC
  `).all(mediaId) as Array<{ id: string; absolutePath: string; language: string; format: string }>;
  for (const row of rows) {
    try {
      const content = await fs.promises.readFile(row.absolutePath, "utf8");
      return {
        kind: chineseLanguagePattern.test(row.language) ? "existing-chinese" : "sidecar",
        language: row.language || "auto",
        sidecarId: row.id,
        vtt: subtitleToVtt(content, row.format)
      };
    } catch {
      // Continue to another usable subtitle source.
    }
  }
  return null;
}

async function findEmbeddedSource(media: MediaRow, workDir: string): Promise<SubtitleSource | null> {
  if (!commandAvailable("ffprobe") || !commandAvailable("ffmpeg")) return null;
  const output = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "s", "-show_entries", "stream=index:stream_tags=language", "-of", "json", media.absolute_path
  ], { timeoutMs: 60_000 });
  const parsed = JSON.parse(output) as { streams?: Array<{ index: number; tags?: { language?: string } }> };
  const stream = parsed.streams?.find((candidate) => chineseLanguagePattern.test(candidate.tags?.language ?? ""))
    ?? parsed.streams?.find((candidate) => /^(ja|jpn)(-|$)/i.test(candidate.tags?.language ?? ""))
    ?? parsed.streams?.[0];
  if (!stream) return null;
  const outputPath = path.join(workDir, "embedded.vtt");
  await runCommand("ffmpeg", ["-y", "-v", "error", "-threads", "1", "-i", media.absolute_path, "-map", `0:${stream.index}`, "-f", "webvtt", outputPath], {
    timeoutMs: 10 * 60_000,
    shouldCancel: () => getTranslationRow(media.id)?.status === "cancelled"
  });
  return {
    kind: chineseLanguagePattern.test(stream.tags?.language ?? "") ? "existing-chinese" : "embedded",
    language: stream.tags?.language ?? "auto",
    sidecarId: null,
    vtt: await fs.promises.readFile(outputPath, "utf8")
  };
}

async function readGeneratedVtt(filePath: string, backendLabel: string): Promise<string> {
  try {
    const vtt = await fs.promises.readFile(filePath, "utf8");
    if (!vtt.trim() || parseVttCues(vtt).length === 0) throw new Error("字幕内容为空");
    return vtt;
  } catch (error) {
    throw new Error(`${backendLabel} 未生成有效字幕：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function transcribeWithWhisperCpp(
  mediaId: string,
  audioPath: string,
  workDir: string,
  reportProgress: (progress: number) => void
): Promise<SubtitleSource> {
  const settings = config.subtitleTranslation;
  const outputPrefix = path.join(workDir, "speech-whisper-cpp");
  const outputPath = `${outputPrefix}.vtt`;
  const capabilities = getWhisperBackendCapabilities();
  const configuredModelDir = path.dirname(settings.whisperCppModel);
  const modelCandidates = [
    settings.whisperCppModel,
    path.join(configuredModelDir, "ggml-small.bin"),
    path.join(configuredModelDir, "ggml-base.bin")
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index && fileReadable(candidate));
  const errors: string[] = [];
  let selectedModel = "";
  // The external qwen runtime already occupies unified GPU memory. When
  // Metal is disabled, use whisper.cpp's CPU path directly instead of
  // attempting a Metal allocation that can hang on macOS under contention.
  let cpuFallback = !settings.whisperCppMetal;
  for (const modelPath of modelCandidates) {
    await fs.promises.rm(outputPath, { force: true });
    try {
      await runCommand(settings.whisperCppCommand, [
        ...(cpuFallback ? ["-ng"] : []),
        "-m", modelPath,
        "-f", audioPath,
        "-l", settings.sourceLanguage,
        "-t", String(settings.whisperThreads),
        "-ovtt",
        "-of", outputPrefix,
        "-pp",
        "-np",
        "-mc", "0",
        "-nf",
        "-sns",
        "-nth", "0.35",
        "-lpt", "-0.45",
        "-et", "2.10",
        "-bo", "5",
        "-bs", "5"
      ], {
        shouldCancel: () => getTranslationRow(mediaId)?.status === "cancelled",
        onStderr: createWhisperProgressHandler(reportProgress)
      });
      selectedModel = modelPath;
      break;
    } catch (error) {
      assertNotCancelled(mediaId);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${path.basename(modelPath)}${cpuFallback ? "（CPU）" : "（Metal）"}：${message}`);
      if (/SIGSEGV|段错误|segmentation fault/i.test(message)) cpuFallback = true;
    }
  }
  if (!selectedModel) {
    throw new Error(`whisper.cpp 可用模型均识别失败：${errors.join("；")}`);
  }
  let vtt = await readGeneratedVtt(outputPath, "whisper.cpp");
  if (capabilities.whisperCppVadAvailable) {
    const vadOutput = await runCommand(settings.whisperCppVadCommand, [
      "-f", audioPath,
      "-vm", settings.whisperCppVadModel,
      "-vt", "0.10",
      "--vad-min-speech-duration-ms", "120",
      "-vsd", "350",
      "-vmsd", "18",
      "-vp", "220",
      "-vo", "0.20",
      "-np"
    ], {
      shouldCancel: () => getTranslationRow(mediaId)?.status === "cancelled",
      captureStderr: true
    });
    const intervals = parseVadSpeechIntervals(vadOutput);
    const filtered = filterSpeechCuesByVad(parseVttCues(vtt), intervals);
    if (filtered.cues.length === 0) throw new Error("VAD 未检测到可用的人声字幕时间轴");
    vtt = buildVtt(filtered.cues);
  }
  reportProgress(100);
  return {
    kind: "speech",
    language: settings.sourceLanguage,
    sidecarId: null,
    vtt,
    model: `${path.basename(selectedModel).replace(/^ggml-|\.bin$/gi, "")} · ${cpuFallback ? "CPU（Metal 崩溃回退）" : "Metal"}${capabilities.whisperCppVadAvailable ? " + VAD 时间轴校准" : ""} · 质量增强`
  };
}

async function transcribeWithOpenAiWhisper(
  mediaId: string,
  audioPath: string,
  workDir: string,
  fallbackUsed: boolean,
  reportProgress: (progress: number) => void
): Promise<SubtitleSource> {
  const settings = config.subtitleTranslation;
  const outputPath = path.join(workDir, "speech.vtt");
  await fs.promises.mkdir(settings.whisperModelDir, { recursive: true });
  await runCommand(settings.whisperCommand, [
    audioPath,
    "--model", settings.whisperModel,
    "--model_dir", settings.whisperModelDir,
    "--language", settings.sourceLanguage,
    "--task", "transcribe",
    "--output_format", "vtt",
    "--output_dir", workDir,
    "--verbose", "False"
  ], {
    env: { ...process.env, OMP_NUM_THREADS: String(settings.whisperThreads) },
    shouldCancel: () => getTranslationRow(mediaId)?.status === "cancelled",
    onStderr: createWhisperProgressHandler(reportProgress)
  });
  reportProgress(100);
  return {
    kind: "speech",
    language: settings.sourceLanguage,
    sidecarId: null,
    vtt: await readGeneratedVtt(outputPath, "OpenAI Whisper"),
    model: `${settings.whisperModel} · CPU${fallbackUsed ? "（Metal 回退）" : ""}`
  };
}

async function transcribeSpeech(media: MediaRow, workDir: string): Promise<SubtitleSource> {
  const settings = config.subtitleTranslation;
  const capabilities = getWhisperBackendCapabilities();
  if (capabilities.active === "unavailable") {
    throw new Error(
      `未检测到可用的本地语音识别后端。whisper.cpp 命令：${settings.whisperCppCommand}，模型：${settings.whisperCppModel}；OpenAI Whisper 命令：${settings.whisperCommand}`
    );
  }
  const audioPath = path.join(workDir, "speech.wav");
  const extractingProgress = createStageProgressReporter(media.id, "extracting", 8, 20);
  updateTranslation(media.id, { stage: "extracting", stage_progress: 0, progress: 8 });
  await runCommand("ffmpeg", [
    "-y", "-v", "error", "-threads", "1", "-i", media.absolute_path,
    "-progress", "pipe:2", "-nostats",
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath
  ], {
    shouldCancel: () => getTranslationRow(media.id)?.status === "cancelled",
    onStderr: createFfmpegProgressHandler(media.duration_seconds, extractingProgress)
  });
  extractingProgress(100);
  assertNotCancelled(media.id);
  const transcriptionProgress = createStageProgressReporter(media.id, "transcribing", 20, 50);
  updateTranslation(media.id, { stage: "transcribing", stage_progress: 0, progress: 20 });

  const errors: string[] = [];
  const shouldTryWhisperCpp = settings.whisperBackend !== "openai"
    && capabilities.whisperCppCommandAvailable
    && capabilities.whisperCppModelAvailable;
  if (shouldTryWhisperCpp) {
    try {
      return await transcribeWithWhisperCpp(media.id, audioPath, workDir, transcriptionProgress);
    } catch (error) {
      assertNotCancelled(media.id);
      errors.push(error instanceof Error ? error.message : String(error));
      await fs.promises.rm(path.join(workDir, "speech-whisper-cpp.vtt"), { force: true });
    }
  }
  if (capabilities.openAiWhisperAvailable) {
    try {
      return await transcribeWithOpenAiWhisper(media.id, audioPath, workDir, errors.length > 0, transcriptionProgress);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!shouldTryWhisperCpp) {
    if (!capabilities.whisperCppCommandAvailable) errors.push(`未找到 whisper.cpp 命令 ${settings.whisperCppCommand}`);
    else if (!capabilities.whisperCppModelAvailable) errors.push(`未找到 whisper.cpp 模型 ${settings.whisperCppModel}`);
  }
  throw new Error(`本地语音识别失败：${errors.join("；")}`);
}

async function translateRemote(text: string, sourceLanguage: string): Promise<string> {
  const settings = config.subtitleTranslation;
  const resolvedSourceLanguage = sourceLanguage && sourceLanguage !== "auto"
    ? sourceLanguage
    : settings.sourceLanguage;
  if (settings.provider === "libretranslate") {
    const response = await fetch(`${settings.libreTranslateUrl}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source: resolvedSourceLanguage,
        target: settings.targetLanguage,
        format: "text",
        api_key: settings.libreTranslateApiKey || undefined
      }),
      signal: AbortSignal.timeout(settings.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`LibreTranslate 请求失败：${response.status}`);
    const body = await response.json() as { translatedText?: string };
    if (!body.translatedText) throw new Error("LibreTranslate 返回空结果");
    return body.translatedText.trim();
  }
  const query = new URLSearchParams({ client: "gtx", sl: resolvedSourceLanguage, tl: settings.targetLanguage, dt: "t", q: text });
  const response = await fetch(`https://translate.googleapis.com/translate_a/single?${query.toString()}`, {
    headers: { "User-Agent": "Mozilla/5.0 Alexandria-Subtitle-Translation/1.0" },
    signal: AbortSignal.timeout(settings.requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`Google 翻译请求失败：${response.status}`);
  const body = await response.json() as unknown;
  const segments = Array.isArray(body) && Array.isArray(body[0]) ? body[0] as unknown[] : [];
  const translated = segments.map((segment) => Array.isArray(segment) ? String(segment[0] ?? "") : "").join("").trim();
  if (!translated) throw new Error("Google 翻译返回空结果");
  return translated;
}

function parseMarkedTranslations(value: string, count: number): string[] | null {
  const marker = /__AMW_CUE_(\d+)__/g;
  const positions: Array<{ index: number; cue: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(value)) !== null) positions.push({ index: match.index, cue: Number(match[1]), end: marker.lastIndex });
  if (positions.length !== count) return null;
  const result = new Array<string>(count);
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index];
    result[current.cue] = value.slice(current.end, positions[index + 1]?.index ?? value.length).trim();
  }
  return result.every(Boolean) ? result : null;
}

async function translateCueTexts(texts: string[], sourceLanguage: string): Promise<string[]> {
  if (texts.length === 1) return [await translateRemote(texts[0], sourceLanguage)];
  const marked = texts.map((text, index) => `__AMW_CUE_${index}__\n${text}`).join("\n");
  const translated = parseMarkedTranslations(await translateRemote(marked, sourceLanguage), texts.length);
  if (translated) return translated;
  const fallback: string[] = [];
  for (const text of texts) fallback.push(await translateRemote(text, sourceLanguage));
  return fallback;
}

function cueBatches(cues: SubtitleCue[], maximumBatchSize = 12): SubtitleCue[][] {
  const batches: SubtitleCue[][] = [];
  let batch: SubtitleCue[] = [];
  let chars = 0;
  for (const cue of cues) {
    if (batch.length >= maximumBatchSize || chars + cue.text.length > 2400) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(cue);
    chars += cue.text.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function parseJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function translationSceneContext(media: MediaRow): { code: string; title: string; genres: string[] } {
  const metadata = db.prepare(`
    SELECT title, title_zh AS titleZh, genres_json AS genresJson, genres_zh_json AS genresZhJson
    FROM media_metadata
    WHERE normalized_code = ?
  `).get(media.normalized_code) as {
    title: string;
    titleZh: string;
    genresJson: string;
    genresZhJson: string;
  } | undefined;
  return {
    code: media.normalized_code || media.basename,
    title: metadata?.title || metadata?.titleZh || media.basename,
    genres: parseJsonArray(metadata?.genresJson).length > 0
      ? parseJsonArray(metadata?.genresJson)
      : parseJsonArray(metadata?.genresZhJson)
  };
}

async function translateCuesWithContext(
  media: MediaRow,
  source: SubtitleSource,
  cues: SubtitleCue[]
): Promise<SubtitleCue[]> {
  const checkpointFingerprint = translationCheckpointFingerprint(cues);
  const checkpoint = await loadTranslationCheckpoint(media.id, cues, checkpointFingerprint);
  const translatedCues: SubtitleCue[] = checkpoint
    ? checkpoint.translatedCues.map((cue) => ({ ...cue }))
    : [];
  if (checkpoint) {
    checkpoint.correctedSourceCues.forEach((cue, index) => {
      cues[index].text = cue.text;
    });
    const resumedCount = translatedCues.length;
    updateTranslation(media.id, {
      translated_cue_count: resumedCount,
      stage_progress: resumedCount / cues.length * 100,
      progress: Math.min(96, 50 + Math.round(resumedCount / cues.length * 46))
    });
  }
  const batches = cueBatches(
    cues.slice(translatedCues.length),
    config.subtitleTranslation.contextualTranslationBatchSize
  );
  const sceneContext = translationSceneContext(media);
  let cueOffset = translatedCues.length;
  let contextualTranslationAvailable = config.subtitleTranslation.contextualTranslation;
  let dedicatedTranslationAvailable = config.subtitleTranslation.dedicatedTranslation;
  // The contextual Qwen response already carries high-confidence ASR
  // corrections. Avoid a duplicate model request on the normal local path;
  // retain the standalone pass for dedicated/non-contextual fallbacks.
  let asrCorrectionAvailable = shouldUseStandaloneAsrCorrection({
    enabled: config.subtitleTranslation.asrCorrection,
    contextualTranslation: contextualTranslationAvailable,
    dedicatedTranslation: dedicatedTranslationAvailable
  });
  let contextualTranslationUsed = false;
  let dedicatedTranslationUsed = false;
  let asrCorrectionUsed = false;
  const normalizeBatchSources = (batch: SubtitleCue[], cueOffset: number) => {
    batch.forEach((cue, cueIndex) => {
      const previousText = cues[cueOffset + cueIndex - 1]?.text;
      const nextText = cues[cueOffset + cueIndex + 1]?.text;
      const deterministic = normalizeSpeechRecognitionText(cue.text, previousText).text;
      const contextual = correctJapaneseRecognitionWithContext(deterministic, previousText, nextText);
      const repeated = normalizeRepeatedSpeechText(contextual);
      if (repeated !== cue.text) asrCorrectionUsed = true;
      cue.text = repeated;
    });
  };
  const containsExplicitAdultDialogue = (batch: SubtitleCue[]) => batch.some((cue) =>
    /セックス|チン[コポ]|ジンポ|ペニス|膣|マンコ|まんこ|おっぱい|乳首|玉|精液|射精|中出し|挿入|舐め|濡れ|オナニ|手コキ|フェラ|クリトリス|アナル/u.test(cue.text)
  );
  const requireExternalRuntime = async () => {
    if (!config.externalAi.translationExternalized) return;
    const runtime = await inspectExternalAiRuntime([
      config.subtitleTranslation.contextualTranslationModel,
      config.subtitleTranslation.dedicatedTranslationModel
    ], 0);
    if (!runtime.ready) throw externalAiWaitError(runtime.reason ?? "等待外置 AI 存储和翻译模型服务");
  };
  for (let index = 0; index < batches.length; index += 1) {
    assertNotCancelled(media.id);
    await requireExternalRuntime();
    const batch = batches[index];
    let translations: string[];
    normalizeBatchSources(batch, cueOffset);
    if (asrCorrectionAvailable) {
      try {
        const correction = await correctJapaneseCuesWithOllama({
          url: config.subtitleTranslation.contextualTranslationUrl,
          model: config.subtitleTranslation.asrCorrectionModel,
          timeoutMs: config.subtitleTranslation.contextualTranslationTimeoutMs,
          cues: batch.map((cue, cueIndex) => ({ id: cueOffset + cueIndex, text: cue.text })),
          context: {
            ...sceneContext,
            previous: cues.slice(Math.max(0, cueOffset - 3), cueOffset).map((cue) => cue.text),
            next: cues.slice(cueOffset + batch.length, cueOffset + batch.length + 3).map((cue) => cue.text)
          }
        });
        batch.forEach((cue, cueIndex) => { cue.text = correction.correctedSources[cueIndex]; });
        normalizeBatchSources(batch, cueOffset);
        asrCorrectionUsed ||= correction.correctionCount > 0;
      } catch (error) {
        await requireExternalRuntime();
        asrCorrectionAvailable = false;
        console.warn(
          `Japanese ASR correction unavailable for ${media.normalized_code}; continuing with deterministic corrections:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    const explicitAdultBatch = containsExplicitAdultDialogue(batch);
    if (dedicatedTranslationAvailable && !explicitAdultBatch) {
      try {
        const dedicated = await translateWithDedicatedOllama({
          url: config.subtitleTranslation.contextualTranslationUrl,
          model: config.subtitleTranslation.dedicatedTranslationModel,
          timeoutMs: config.subtitleTranslation.dedicatedTranslationTimeoutMs,
          cues: batch.map((cue, cueIndex) => ({ id: cueOffset + cueIndex, text: cue.text }))
        });
        translations = dedicated.translations;
        dedicatedTranslationUsed = true;
        updateTranslation(media.id, {
          provider: `ollama:${config.subtitleTranslation.dedicatedTranslationModel}`,
          model: source.kind === "speech"
            ? `${source.model ?? config.subtitleTranslation.whisperModel} · ASR 纠错 ${config.subtitleTranslation.asrCorrectionModel} · 专用翻译 ${config.subtitleTranslation.dedicatedTranslationModel}`
            : config.subtitleTranslation.dedicatedTranslationModel
        });
      } catch (error) {
        await requireExternalRuntime();
        dedicatedTranslationAvailable = false;
        console.warn(
          `Dedicated subtitle translation unavailable for ${media.normalized_code}; falling back to contextual translation:`,
          error instanceof Error ? error.message : error
        );
        translations = [];
      }
    } else {
      translations = [];
    }
    if (translations.length === 0 && contextualTranslationAvailable) {
      try {
        const contextual = await translateContextualCuesIndividually({
          url: config.subtitleTranslation.contextualTranslationUrl,
          model: config.subtitleTranslation.contextualTranslationModel,
          fallbackModel: config.subtitleTranslation.dedicatedTranslationModel,
          timeoutMs: config.subtitleTranslation.contextualTranslationTimeoutMs,
          batchSize: config.subtitleTranslation.contextualTranslationRequestBatchSize,
          requestConcurrency: config.subtitleTranslation.contextualTranslationRequestConcurrency,
          cues: batch.map((cue, cueIndex) => ({ id: cueOffset + cueIndex, text: cue.text })),
          context: {
            ...sceneContext,
            previous: cues.slice(Math.max(0, cueOffset - 3), cueOffset).map((cue) => cue.text),
            next: cues.slice(cueOffset + batch.length, cueOffset + batch.length + 3).map((cue) => cue.text)
          }
        });
        translations = contextual.translations;
        batch.forEach((cue, cueIndex) => {
          if (contextual.correctedSources[cueIndex] !== cue.text) asrCorrectionUsed = true;
          cue.text = contextual.correctedSources[cueIndex];
        });
        normalizeBatchSources(batch, cueOffset);
        contextualTranslationUsed = true;
        updateTranslation(media.id, {
          provider: `ollama:${config.subtitleTranslation.contextualTranslationModel}`,
          model: source.kind === "speech"
            ? `${source.model ?? config.subtitleTranslation.whisperModel} · 上下文翻译 ${config.subtitleTranslation.contextualTranslationModel}`
            : config.subtitleTranslation.contextualTranslationModel
        });
      } catch (error) {
        await requireExternalRuntime();
        if (config.externalAi.translationExternalized) throw error;
        contextualTranslationAvailable = false;
        if (contextualTranslationUsed) {
          updateTranslation(media.id, {
            provider: `ollama:${config.subtitleTranslation.contextualTranslationModel} + ${config.subtitleTranslation.provider} 降级`
          });
        }
        console.warn(
          `Contextual subtitle translation unavailable for ${media.normalized_code}; falling back to ${config.subtitleTranslation.provider}:`,
          error instanceof Error ? error.message : error
        );
        translations = await translateCueTexts(batch.map((cue) => cue.text), source.language);
      }
    } else if (translations.length === 0) {
      if (config.externalAi.translationExternalized) {
        throw new Error("外置本地翻译模型未能生成有效结果");
      }
      translations = await translateCueTexts(batch.map((cue) => cue.text), source.language);
    }
    translatedCues.push(...batch.map((cue, cueIndex) => ({
      ...cue,
      text: normalizeTranslatedSpeechText(cue.text, translations[cueIndex])
    })));
    cueOffset += batch.length;
    const translatedCount = translatedCues.length;
    await saveTranslationCheckpoint(
      media.id,
      checkpointFingerprint,
      cues.slice(0, translatedCount).map((cue) => ({ ...cue })),
      translatedCues.map((cue) => ({ ...cue }))
    );
    updateTranslation(media.id, {
      translated_cue_count: translatedCount,
      stage_progress: translatedCount / cues.length * 100,
      progress: Math.min(96, 50 + Math.round(translatedCount / cues.length * 46))
    });
    if (index < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, config.subtitleTranslation.requestDelayMs));
    }
  }
  if (dedicatedTranslationUsed && contextualTranslationUsed) {
    updateTranslation(media.id, {
      provider: `ollama:${config.subtitleTranslation.dedicatedTranslationModel} + ${config.subtitleTranslation.contextualTranslationModel} 成人对白分流`,
      model: source.kind === "speech"
        ? `${source.model ?? config.subtitleTranslation.whisperModel} · ASR 纠错 ${config.subtitleTranslation.asrCorrectionModel} · 专用翻译 ${config.subtitleTranslation.dedicatedTranslationModel} · 成人对白 ${config.subtitleTranslation.contextualTranslationModel}`
        : `${config.subtitleTranslation.dedicatedTranslationModel} + ${config.subtitleTranslation.contextualTranslationModel}`
    });
  }
  if (source.kind === "speech" && (contextualTranslationUsed || asrCorrectionUsed)) {
    const sourcePath = translatedSourceOutputPath(media.id);
    const temporarySource = `${sourcePath}.${process.pid}.context.tmp`;
    await fs.promises.writeFile(temporarySource, buildVtt(cues), "utf8");
    await fs.promises.rename(temporarySource, sourcePath);
  }
  return translatedCues;
}

async function processTranslation(media: MediaRow): Promise<void> {
  const workDir = path.join(temporaryDir, `${media.id}-${Date.now()}`);
  const outputPath = path.join(outputDir, `${media.id}.zh-CN.vtt`);
  await fs.promises.mkdir(workDir, { recursive: true });
  await fs.promises.mkdir(outputDir, { recursive: true });
  updateTranslation(media.id, {
    status: "running",
    stage: "source",
    progress: 3,
    stage_progress: 0,
    started_at: nowIso(),
    error: null
  });
  try {
    assertNotCancelled(media.id);
    let source = await findPersistedSpeechSource(media.id);
    if (!source) source = await findSidecarSource(media.id);
    if (!source) source = await findEmbeddedSource(media, workDir);
    if (!source) {
      source = await transcribeSpeech(media, workDir);
    }
    const parsedCues = parseVttCues(source.vtt);
    const speechCleanup = source.kind === "speech" ? sanitizeSpeechCues(parsedCues) : null;
    const cues = speechCleanup?.cues ?? parsedCues;
    if (cues.length === 0) throw new Error("字幕源中没有可翻译的有效时间轴内容");
    if (source.kind === "speech") {
      const sourcePath = translatedSourceOutputPath(media.id);
      const temporarySource = `${sourcePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporarySource, buildVtt(cues), "utf8");
      await fs.promises.rename(temporarySource, sourcePath);
    }
    updateTranslation(media.id, {
      source_kind: source.kind,
      source_sidecar_id: source.sidecarId,
      source_language: source.language,
      cue_count: cues.length,
      provider: source.kind === "existing-chinese" ? "existing" : config.subtitleTranslation.provider,
      model: source.kind === "speech" ? source.model ?? config.subtitleTranslation.whisperModel : "",
      stage: source.kind === "existing-chinese" ? "writing" : "translating",
      stage_progress: 0,
      progress: source.kind === "existing-chinese" ? 98 : 50
    });

    let translatedCues = cues;
    if (source.kind !== "existing-chinese") {
      translatedCues = await translateCuesWithContext(media, source, cues);
    }

    assertNotCancelled(media.id);
    updateTranslation(media.id, { stage: "writing", stage_progress: 0, progress: 98 });
    const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryOutput, buildVtt(translatedCues), "utf8");
    await fs.promises.rename(temporaryOutput, outputPath);
    await removeTranslationCheckpoint(media.id);
    const bytes = (await fs.promises.stat(outputPath)).size;
    updateTranslation(media.id, {
      status: "ready",
      stage: "ready",
      progress: 100,
      stage_progress: 100,
      output_path: outputPath,
      bytes,
      translated_cue_count: translatedCues.length,
      finished_at: nowIso(),
      error: null
    });
  } catch (error) {
    const cancelled = getTranslationRow(media.id)?.status === "cancelled";
    const normalizedError = isMediaSourceWaitError(error) || !fileReadable(media.absolute_path)
      ? mediaSourceWaitError()
      : error;
    if (!cancelled) {
      const waitingExternalAi = normalizedError instanceof Error
        && "code" in normalizedError
        && normalizedError.code === "EXTERNAL_AI_WAIT";
      const waitingMediaSource = isMediaSourceWaitError(normalizedError);
      const waiting = waitingExternalAi || waitingMediaSource;
      updateTranslation(media.id, {
        status: waiting ? "pending" : "failed",
        stage: waiting ? "queued" : "failed",
        error: normalizedError instanceof Error
          ? normalizedError.message.slice(-1600)
          : String(normalizedError).slice(-1600),
        finished_at: waiting ? null : nowIso()
      });
    }
    throw normalizedError;
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}

registerMediaJobHandler("subtitle-translate", async (job, media) => {
  if (!media || media.media_type !== "video") throw new Error("视频文件不存在或不是可翻译的视频");
  const payload = (() => {
    try {
      return JSON.parse(job.payload_json) as { mode?: string; trigger?: string };
    } catch {
      return {};
    }
  })();
  if (payload.mode === "retranslate") {
    await refinePersistedSpeechTranslation(media.id);
    return;
  }
  const reusableSpeechSource = getTranslationRow(media.id)?.source_kind === "speech"
    && fileReadable(translatedSourceOutputPath(media.id));
  if (!reusableSpeechSource && !fileReadable(media.absolute_path)) throw mediaSourceWaitError();
  if (isAutomaticTranslationTrigger(payload.trigger) && hasEmbeddedChineseVariant(media)) {
    markAutomaticTranslationSkipped(media.id);
    return;
  }
  await processTranslation(media);
});

function hasActiveSubtitleTranslation(): boolean {
  const activeRows = db.prepare(
    "SELECT media_id AS mediaId FROM video_subtitle_translations WHERE status IN ('pending', 'running')"
  ).all() as Array<{ mediaId: string }>;
  for (const row of activeRows) getSubtitleTranslation(row.mediaId);
  const row = db.prepare(`
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM video_subtitle_translations WHERE status IN ('pending', 'running')
    ) OR EXISTS (
      SELECT 1 FROM media_jobs
      WHERE job_type = 'subtitle-translate' AND status IN ('pending', 'running')
    )
  `).get();
  return Boolean(row);
}

export function hasEmbeddedChineseVariant(media: Pick<MediaRow, "basename" | "variant_tags">): boolean {
  // `basename` is the extension-free filename. Keep the explicit suffix check
  // here so the automatic path remains safe even when an older database has
  // not rebuilt `media_variant_tags` yet; the tag fallback also covers the
  // compact `...C`/`...CH` forms normalized by mediaName.
  const basename = media.basename.trim();
  if (/(?:^|[-_ ])C(?:H)?$/iu.test(basename) || /[A-Z]{2,10}[-_ ]?\d{3,7}CH$/iu.test(basename)) return true;
  try {
    const tags = JSON.parse(media.variant_tags) as unknown;
    return Array.isArray(tags)
      && tags.some((tag) => ["C", "CH"].includes(String(tag).trim().toUpperCase()));
  } catch {
    return false;
  }
}

function isAutomaticTranslationTrigger(trigger: unknown): boolean {
  return trigger === "favorite-auto" || trigger === "priority-auto";
}

function markAutomaticTranslationSkipped(mediaId: string): SubtitleTranslation {
  const message = "文件名以 -C 结尾，视为已内嵌中文字幕，已跳过自动翻译";
  updateTranslation(mediaId, {
    media_job_id: "",
    status: "cancelled",
    stage: "cancelled",
    progress: 100,
    stage_progress: 100,
    source_kind: "",
    source_sidecar_id: null,
    source_language: "",
    cue_count: 0,
    translated_cue_count: 0,
    output_path: "",
    bytes: 0,
    error: message,
    started_at: null,
    finished_at: nowIso()
  });
  return getSubtitleTranslation(mediaId)!;
}

function preferredTranslationCandidatesSql(): string {
  return `
    WITH favorite_paths(relative_path) AS (
      SELECT value FROM json_each(@favoritesJson)
    ), candidates AS (
      SELECT
        media_files.id,
        media_files.absolute_path,
        media_files.mtime_ms,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM favorite_paths
            WHERE favorite_paths.relative_path = media_files.relative_path
          ) THEN 'media-favorite'
          WHEN EXISTS (
            SELECT 1 FROM media_metadata_facets facets
            JOIN entity_favorites favorites
              ON favorites.facet_type = facets.facet_type
             AND favorites.facet_value = facets.facet_value
            WHERE facets.normalized_code = media_files.normalized_code
              AND favorites.facet_type <> 'actor'
          ) THEN 'topic-favorite'
          WHEN EXISTS (
            SELECT 1 FROM media_metadata_facets facets
            JOIN entity_favorites favorites
              ON favorites.facet_type = facets.facet_type
             AND favorites.facet_value = facets.facet_value
            WHERE facets.normalized_code = media_files.normalized_code
              AND favorites.facet_type = 'actor'
          ) THEN 'actor-favorite'
          ELSE 'library'
        END AS tier,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM favorite_paths
            WHERE favorite_paths.relative_path = media_files.relative_path
          ) THEN 300
          WHEN EXISTS (
            SELECT 1 FROM media_metadata_facets facets
            JOIN entity_favorites favorites
              ON favorites.facet_type = facets.facet_type
             AND favorites.facet_value = facets.facet_value
            WHERE facets.normalized_code = media_files.normalized_code
              AND favorites.facet_type <> 'actor'
          ) THEN 200
          WHEN EXISTS (
            SELECT 1 FROM media_metadata_facets facets
            JOIN entity_favorites favorites
              ON favorites.facet_type = facets.facet_type
             AND favorites.facet_value = facets.facet_value
            WHERE facets.normalized_code = media_files.normalized_code
              AND favorites.facet_type = 'actor'
          ) THEN 100
          ELSE 0
        END AS queue_priority,
        COALESCE((
          SELECT MAX(favorites.created_at)
          FROM media_metadata_facets facets
          JOIN entity_favorites favorites
            ON favorites.facet_type = facets.facet_type
           AND favorites.facet_value = facets.facet_value
          WHERE facets.normalized_code = media_files.normalized_code
        ), '') AS favorite_created_at
      FROM media_files
      WHERE media_files.media_type = 'video'
        -- A trailing -C variant denotes a file with embedded Chinese subtitles.
        -- Keep it out of the automatic translation backlog even if the tag
        -- index is stale; the tag table also covers compact -C/-CH spellings.
        AND UPPER(TRIM(media_files.basename)) NOT GLOB '*[-_ ]C'
        AND UPPER(TRIM(media_files.basename)) NOT GLOB '*[-_ ]CH'
        AND UPPER(TRIM(media_files.basename)) NOT GLOB '*CH'
        AND NOT EXISTS (
          SELECT 1
          FROM media_variant_tags embedded_chinese
          WHERE embedded_chinese.media_id = media_files.id
            AND embedded_chinese.tag IN ('C', 'CH')
        )
        AND NOT EXISTS (
          SELECT 1 FROM video_subtitle_translations translations
          WHERE translations.media_id = media_files.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_jobs jobs
          WHERE jobs.media_id = media_files.id
            AND jobs.job_type = 'subtitle-translate'
            AND jobs.status IN ('pending', 'running')
        )
    )
  `;
}

function preferredTranslationCandidateQuery(select: "count" | "next") {
  const projection = select === "count"
    ? "COUNT(*) AS count"
    : "id, tier, queue_priority AS queuePriority, absolute_path AS absolutePath";
  const suffix = select === "count"
    ? ""
    : "ORDER BY queue_priority DESC, favorite_created_at DESC, mtime_ms DESC, id ASC LIMIT 1";
  return db.prepare(`${preferredTranslationCandidatesSql()}
    SELECT ${projection}
    FROM candidates
    ${suffix}
  `);
}

export function getTranslationPriorityBacklog(): TranslationPriorityBacklog {
  const favorites = [...readFavoriteKeys()];
  const rows = db.prepare(`${preferredTranslationCandidatesSql()}
    SELECT tier, COUNT(*) AS count
    FROM candidates
    GROUP BY tier
  `).all({ favoritesJson: JSON.stringify(favorites) }) as Array<{ tier: TranslationQueueTier; count: number }>;
  const byTier = new Map(rows.map((row) => [row.tier, Number(row.count)]));
  return {
    total: rows.reduce((sum, row) => sum + Number(row.count), 0),
    mediaFavorites: byTier.get("media-favorite") ?? 0,
    topicFavorites: byTier.get("topic-favorite") ?? 0,
    actorFavorites: byTier.get("actor-favorite") ?? 0,
    library: byTier.get("library") ?? 0
  };
}

export function getFavoriteTranslationBacklogCount(): number {
  return getTranslationPriorityBacklog().mediaFavorites;
}

export function getAutoTranslateFavoritesEnabled(): boolean {
  const row = db.prepare("SELECT source_signature AS value FROM app_cache_state WHERE cache_key = ?")
    .get(autoFavoriteTranslationSettingKey) as { value: string } | undefined;
  if (!row) return config.subtitleTranslation.autoTranslateFavorites;
  return row.value === "true";
}

export function setAutoTranslateFavoritesEnabled(enabled: boolean): boolean {
  const now = nowIso();
  db.prepare(`
    INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_signature = excluded.source_signature,
      updated_at = excluded.updated_at
  `).run(autoFavoriteTranslationSettingKey, enabled ? "true" : "false", now);
  return enabled;
}

function findNextPreferredTranslationCandidate(): { id: string; tier: TranslationQueueTier; queuePriority: number } | null {
  const favorites = [...readFavoriteKeys()];
  const row = preferredTranslationCandidateQuery("next").get({
    favoritesJson: JSON.stringify(favorites)
  }) as { id: string; tier: TranslationQueueTier; queuePriority: number; absolutePath: string } | undefined;
  // Automatic translation must not turn an unmounted source into a failed
  // Whisper/ffprobe job. Manual requests remain allowed so the user can
  // intentionally retry after checking the media path.
  if (!row || !fileReadable(row.absolutePath)) return null;
  return { id: row.id, tier: row.tier, queuePriority: row.queuePriority };
}

export function requestSubtitleTranslation(
  mediaId: string,
  options: { priority?: number; trigger?: "manual" | "favorite-auto" | "priority-auto" } = {}
): SubtitleTranslation {
  const media = db.prepare("SELECT * FROM media_files WHERE id = ?").get(mediaId) as MediaRow | undefined;
  if (!media || media.media_type !== "video") throw Object.assign(new Error("视频不存在"), { status: 404 });
  const current = getSubtitleTranslation(mediaId);
  if (current?.status === "pending" || current?.status === "running") return current;
  if (isAutomaticTranslationTrigger(options.trigger) && hasEmbeddedChineseVariant(media)) {
    if (current?.outputPath) fs.rmSync(current.outputPath, { force: true });
    const now = nowIso();
    db.prepare(`
      INSERT INTO video_subtitle_translations (
        media_id, status, stage, progress, stage_progress, stage_started_at,
        target_language, provider, model, created_at, updated_at
      ) VALUES (?, 'cancelled', 'cancelled', 100, 100, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_id) DO UPDATE SET
        media_job_id = '', status = 'cancelled', stage = 'cancelled', progress = 100, stage_progress = 100,
        stage_started_at = excluded.stage_started_at, source_kind = '', source_sidecar_id = NULL,
        source_language = '', target_language = excluded.target_language, output_path = '', bytes = 0,
        cue_count = 0, translated_cue_count = 0, provider = excluded.provider, model = excluded.model,
        error = NULL, started_at = NULL, finished_at = NULL, updated_at = excluded.updated_at
    `).run(
      mediaId,
      now,
      config.subtitleTranslation.targetLanguage,
      config.subtitleTranslation.provider,
      config.subtitleTranslation.whisperModel,
      now,
      now
    );
    return markAutomaticTranslationSkipped(mediaId);
  }
  if (current?.outputPath) fs.rmSync(current.outputPath, { force: true });
  const now = nowIso();
  db.prepare(`
    INSERT INTO video_subtitle_translations (
      media_id, status, stage, progress, stage_progress, stage_started_at,
      target_language, provider, model, created_at, updated_at
    ) VALUES (?, 'pending', 'queued', 0, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      status = 'pending', stage = 'queued', progress = 0, source_kind = '', source_sidecar_id = NULL,
      stage_progress = 0, stage_started_at = excluded.stage_started_at,
      source_language = '', target_language = excluded.target_language, output_path = '', bytes = 0,
      cue_count = 0, translated_cue_count = 0, provider = excluded.provider, model = excluded.model,
      error = NULL, started_at = NULL, finished_at = NULL, updated_at = excluded.updated_at
  `).run(mediaId, now, config.subtitleTranslation.targetLanguage, config.subtitleTranslation.provider, config.subtitleTranslation.whisperModel, now, now);
  const jobId = enqueueMediaJob(mediaId, "subtitle-translate", {
    priority: options.priority ?? 85,
    payload: { trigger: options.trigger ?? "manual" }
  });
  updateTranslation(mediaId, { media_job_id: jobId });
  return getSubtitleTranslation(mediaId)!;
}

export function requestSubtitleRetranslation(mediaId: string): SubtitleTranslation {
  getSubtitleTranslation(mediaId);
  const row = getTranslationRow(mediaId);
  const sourcePath = translatedSourceOutputPath(mediaId);
  if (!row || !["ready", "failed"].includes(row.status) || row.source_kind !== "speech") {
    throw Object.assign(new Error("仅支持再次翻译已有可追溯语音识别稿的字幕"), { status: 409 });
  }
  if (!fileReadable(sourcePath)) throw Object.assign(new Error("缺少可追溯的日语源字幕"), { status: 409 });
  const outputPath = row.output_path || path.join(outputDir, `${mediaId}.zh-CN.vtt`);
  fs.mkdirSync(outputDir, { recursive: true });
  const now = nowIso();
  updateTranslation(mediaId, {
    status: "pending",
    stage: "queued",
    progress: 0,
    stage_progress: 0,
    output_path: outputPath,
    error: null,
    started_at: null,
    updated_at: now
  });
  const jobId = enqueueMediaJob(mediaId, "subtitle-translate", {
    priority: 90,
    payload: { trigger: "manual", mode: "retranslate" }
  });
  updateTranslation(mediaId, { media_job_id: jobId });
  return getSubtitleTranslation(mediaId)!;
}

export function enqueueNextPriorityTranslationIfIdle(): string | null {
  if (!getAutoTranslateFavoritesEnabled()) return null;
  if (getWhisperBackendCapabilities().active === "unavailable") return null;
  if (hasActiveSubtitleTranslation()) return null;
  const candidate = findNextPreferredTranslationCandidate();
  if (!candidate) return null;
  requestSubtitleTranslation(candidate.id, {
    priority: candidate.queuePriority > 0 ? 85 : 15,
    trigger: candidate.tier === "media-favorite" ? "favorite-auto" : "priority-auto"
  });
  return candidate.id;
}

export function enqueueNextFavoriteTranslationIfIdle(): string | null {
  return enqueueNextPriorityTranslationIfIdle();
}

registerMediaJobIdleRefillHandler("priority-subtitle-translation", () => (
  enqueueNextPriorityTranslationIfIdle() ? 1 : 0
));

export function cancelSubtitleTranslation(mediaId: string): void {
  const row = getTranslationRow(mediaId);
  if (!row) throw Object.assign(new Error("翻译任务不存在"), { status: 404 });
  if (row.status === "ready" && row.output_path) fs.rmSync(row.output_path, { force: true });
  if (row.status === "ready") fs.rmSync(translatedSourceOutputPath(mediaId), { force: true });
  if (row.status === "pending" && row.media_job_id) {
    db.prepare(`UPDATE media_jobs SET status = 'failed', error = '用户取消翻译任务', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
      .run(nowIso(), nowIso(), row.media_job_id);
  }
  updateTranslation(mediaId, { status: "cancelled", stage: "cancelled", error: null, finished_at: nowIso() });
}

export function removeSubtitleTranslation(mediaId: string): { action: "cancelled" | "cancelling" | "removed" } {
  const row = getTranslationRow(mediaId);
  if (!row) return { action: "removed" };
  if (row.status === "pending" || row.status === "running") {
    cancelSubtitleTranslation(mediaId);
    return { action: row.status === "running" ? "cancelling" : "cancelled" };
  }
  const job = row.media_job_id
    ? db.prepare("SELECT status FROM media_jobs WHERE id = ?").get(row.media_job_id) as { status: string } | undefined
    : undefined;
  if (job?.status === "running") return { action: "cancelling" };
  if (row.output_path) fs.rmSync(row.output_path, { force: true });
  fs.rmSync(translatedSourceOutputPath(mediaId), { force: true });
  db.prepare("DELETE FROM video_subtitle_translations WHERE media_id = ?").run(mediaId);
  return { action: "removed" };
}

export function getTranslationCapabilities() {
  const whisper = getWhisperBackendCapabilities();
  const externalStorage = inspectExternalAiStorage(config.externalAi);
  const priorityBacklog = getTranslationPriorityBacklog();
  return {
    provider: config.subtitleTranslation.provider,
    contextualTranslation: config.subtitleTranslation.contextualTranslation,
    contextualTranslationModel: config.subtitleTranslation.contextualTranslationModel,
    contextualTranslationBatchSize: config.subtitleTranslation.contextualTranslationBatchSize,
    translationRequestBatchSize: config.subtitleTranslation.contextualTranslationRequestBatchSize,
    translationRequestConcurrency: config.subtitleTranslation.contextualTranslationRequestConcurrency,
    asrCorrection: config.subtitleTranslation.asrCorrection,
    asrCorrectionStrategy: shouldUseStandaloneAsrCorrection({
      enabled: config.subtitleTranslation.asrCorrection,
      contextualTranslation: config.subtitleTranslation.contextualTranslation,
      dedicatedTranslation: config.subtitleTranslation.dedicatedTranslation
    }) ? "standalone" : "integrated",
    asrCorrectionModel: config.subtitleTranslation.asrCorrectionModel,
    dedicatedTranslation: config.subtitleTranslation.dedicatedTranslation,
    dedicatedTranslationModel: config.subtitleTranslation.dedicatedTranslationModel,
    targetLanguage: config.subtitleTranslation.targetLanguage,
    whisperAvailable: whisper.active !== "unavailable",
    whisperCommand: whisper.active === "whisper-cpp"
      ? config.subtitleTranslation.whisperCppCommand
      : config.subtitleTranslation.whisperCommand,
    whisperModel: config.subtitleTranslation.whisperModel,
    whisperBackend: whisper.active,
    preferredWhisperBackend: whisper.preferred,
    whisperThreads: config.subtitleTranslation.whisperThreads,
    whisperCppAvailable: whisper.whisperCppCommandAvailable && whisper.whisperCppModelAvailable,
    whisperCppMetal: config.subtitleTranslation.whisperCppMetal,
    whisperCppVadAvailable: whisper.whisperCppVadAvailable,
    openAiWhisperAvailable: whisper.openAiWhisperAvailable,
    maxConcurrentTranslations: 1,
    pausesForPlayback: true,
    autoTranslateFavorites: getAutoTranslateFavoritesEnabled(),
    favoriteBacklogCount: getFavoriteTranslationBacklogCount(),
    priorityBacklogCount: priorityBacklog.total,
    priorityBacklog,
    externalStorageRequired: config.externalAi.translationExternalized,
    externalStorageReady: !config.externalAi.translationExternalized || externalStorage.ready,
    externalStorageMessage: config.externalAi.translationExternalized ? externalStorage.message : null
  };
}

export function listSubtitleTranslations(options: { status?: string; page?: number; pageSize?: number } = {}) {
  const activeMediaIds = db.prepare(
    "SELECT media_id AS mediaId FROM video_subtitle_translations WHERE status IN ('pending', 'running')"
  ).all() as Array<{ mediaId: string }>;
  for (const row of activeMediaIds) getSubtitleTranslation(row.mediaId);

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(12, options.pageSize ?? 30));
  const status = options.status && options.status !== "ALL" ? options.status : null;
  const where = status ? "WHERE translations.status = @status" : "";
  const params = { status, limit: pageSize, offset: (page - 1) * pageSize };
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM video_subtitle_translations translations ${where}`).get(params) as { count: number }).count;
  const rows = db.prepare(`
    SELECT translations.*, media_files.normalized_code AS normalizedCode, media_files.basename,
      media_files.source_name AS sourceName, media_files.duration_seconds AS durationSeconds
    FROM video_subtitle_translations translations
    JOIN media_files ON media_files.id = translations.media_id
    ${where}
    ORDER BY CASE translations.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
      translations.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params) as Array<TranslationRow & { normalizedCode: string; basename: string; sourceName: string; durationSeconds: number | null }>;
  const counts = Object.fromEntries(
    (db.prepare("SELECT status, COUNT(*) AS count FROM video_subtitle_translations GROUP BY status").all() as Array<{ status: string; count: number }>)
      .map((row) => [row.status, row.count])
  );
  return {
    items: rows.map((row) => ({
      ...mapTranslation(row, row.durationSeconds),
      normalizedCode: row.normalizedCode,
      basename: row.basename,
      sourceName: row.sourceName,
      durationSeconds: row.durationSeconds
    })),
    total,
    page,
    pageSize,
    counts,
    capabilities: getTranslationCapabilities()
  };
}

export function getReadyTranslationSidecar(mediaId: string) {
  const translation = getSubtitleTranslation(mediaId);
  if (!translation || translation.status !== "ready") return null;
  return {
    id: `translation:${mediaId}`,
    kind: "subtitle" as const,
    relativePath: path.basename(translation.outputPath),
    language: translation.targetLanguage,
    label: "AI 汉化字幕",
    format: "vtt",
    size: translation.bytes,
    mtimeMs: Date.parse(translation.updatedAt),
    isTranslated: true,
    trackUrl: `/api/media/${mediaId}/subtitle-translation.vtt`,
    rawUrl: `/api/media/${mediaId}/subtitle-translation.vtt`
  };
}

export async function repairPersistedSpeechTranslation(mediaId: string): Promise<{
  sourceCorrections: number;
  translationCorrections: number;
  invalidTimingPairsRemoved: number;
}> {
  const row = getTranslationRow(mediaId);
  if (!row || row.status !== "ready" || row.source_kind !== "speech" || !row.output_path) {
    throw new Error("仅支持修复已完成的语音识别翻译");
  }
  const sourcePath = translatedSourceOutputPath(mediaId);
  if (!fileReadable(sourcePath) || !fileReadable(row.output_path)) throw new Error("缺少可追溯的源字幕或中文字幕");

  let sourceCues = parseVttCues(await fs.promises.readFile(sourcePath, "utf8"));
  let translatedCues = parseVttCues(await fs.promises.readFile(row.output_path, "utf8"));
  if (sourceCues.length !== translatedCues.length) throw new Error("源字幕与中文字幕的时间轴数量不一致");

  const validCueIndexes = sourceCues
    .map((cue, index) => hasPositiveCueDuration(cue) ? index : -1)
    .filter((index) => index >= 0);
  const invalidTimingPairsRemoved = sourceCues.length - validCueIndexes.length;
  sourceCues = validCueIndexes.map((index) => sourceCues[index]);
  translatedCues = validCueIndexes.map((index) => translatedCues[index]);

  let sourceCorrections = 0;
  let translationCorrections = 0;
  let previousSource = "";
  for (let index = 0; index < sourceCues.length; index += 1) {
    const sourceCue = sourceCues[index];
    const translatedCue = translatedCues[index];
    const normalized = normalizeSpeechRecognitionText(sourceCue.text, previousSource);
    sourceCorrections += normalized.corrections;
    const contextCorrected = correctJapaneseRecognitionWithContext(
      normalized.text,
      previousSource,
      sourceCues[index + 1]?.text
    );
    if (contextCorrected !== normalized.text) sourceCorrections += 1;
    const repetitionNormalized = normalizeRepeatedSpeechText(contextCorrected);
    if (repetitionNormalized !== contextCorrected) sourceCorrections += 1;
    sourceCue.text = repetitionNormalized;
    previousSource = repetitionNormalized;
    const translated = normalizeTranslatedSpeechText(repetitionNormalized, translatedCue.text);
    if (translated !== translatedCue.text) translationCorrections += 1;
    translatedCue.text = translated;
  }

  const sourceTemporary = `${sourcePath}.${process.pid}.repair.tmp`;
  const translatedTemporary = `${row.output_path}.${process.pid}.repair.tmp`;
  await fs.promises.writeFile(sourceTemporary, buildVtt(sourceCues), "utf8");
  await fs.promises.writeFile(translatedTemporary, buildVtt(translatedCues), "utf8");
  await fs.promises.rename(sourceTemporary, sourcePath);
  await fs.promises.rename(translatedTemporary, row.output_path);
  updateTranslation(mediaId, {
    bytes: (await fs.promises.stat(row.output_path)).size,
    cue_count: sourceCues.length,
    translated_cue_count: translatedCues.length,
    updated_at: nowIso()
  });
  return { sourceCorrections, translationCorrections, invalidTimingPairsRemoved };
}

export async function refinePersistedSpeechTranslation(mediaId: string): Promise<SubtitleTranslation> {
  const row = getTranslationRow(mediaId);
  const media = db.prepare("SELECT * FROM media_files WHERE id = ?").get(mediaId) as MediaRow | undefined;
  if (!row || !["pending", "running", "ready"].includes(row.status) || row.source_kind !== "speech" || !row.output_path || !media) {
    throw new Error("仅支持重新润色已完成的语音识别字幕");
  }
  const sourcePath = translatedSourceOutputPath(mediaId);
  if (!fileReadable(sourcePath)) throw new Error("缺少可追溯的日语源字幕");
  const sourceCues = sanitizeSpeechCues(
    parseVttCues(await fs.promises.readFile(sourcePath, "utf8"))
  ).cues;
  if (sourceCues.length === 0) throw new Error("日语源字幕为空");
  const startedAt = nowIso();
  updateTranslation(mediaId, {
    status: "running",
    stage: "translating",
    progress: 50,
    stage_progress: 0,
    translated_cue_count: 0,
    started_at: startedAt,
    finished_at: null,
    error: null
  });
  try {
    const source: SubtitleSource = {
      kind: "speech",
      language: row.source_language || config.subtitleTranslation.sourceLanguage,
      sidecarId: null,
      vtt: buildVtt(sourceCues),
      model: row.model.replace(/ · 上下文翻译.*$/u, "") || config.subtitleTranslation.whisperModel
    };
    const translatedCues = await translateCuesWithContext(media, source, sourceCues);
    const temporaryOutput = `${row.output_path}.${process.pid}.refine.tmp`;
    await fs.promises.writeFile(temporaryOutput, buildVtt(translatedCues), "utf8");
    await fs.promises.rename(temporaryOutput, row.output_path);
    await removeTranslationCheckpoint(mediaId);
    updateTranslation(mediaId, {
      status: "ready",
      stage: "ready",
      progress: 100,
      stage_progress: 100,
      bytes: (await fs.promises.stat(row.output_path)).size,
      cue_count: sourceCues.length,
      translated_cue_count: translatedCues.length,
      finished_at: nowIso(),
      error: null
    });
    return getSubtitleTranslation(mediaId)!;
  } catch (error) {
    updateTranslation(mediaId, {
      status: "failed",
      stage: "failed",
      progress: 100,
      stage_progress: 100,
      translated_cue_count: row.translated_cue_count,
      finished_at: nowIso(),
      error: `上下文润色失败，旧字幕文件仅保留用于恢复：${error instanceof Error ? error.message : String(error)}`
    });
    throw error;
  }
}
