import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyDemoEnvironment } from "./demoEnvironment.js";

try {
  process.loadEnvFile?.();
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code !== "ENOENT") throw error;
}

const demoMode = process.env.AMW_DEMO_MODE === "true";
if (demoMode) applyDemoEnvironment(process.env, process.cwd());

export type MediaSource = {
  category: string;
  name: string;
  root: string;
};

export type LibraryRoots = {
  roots: [string, string];
  updatedAt?: string;
};

const defaultLibraryRoots: [string, string] = [path.resolve("media/Library-1"), path.resolve("media/Library-2")];

const dataDir = path.resolve(process.env.DATA_DIR ?? ".local/data");
const thumbnailDir = path.resolve(process.env.THUMBNAIL_DIR ?? path.join(process.env.DATA_DIR ?? ".local/data", "thumbnails"));
const coverCacheDir = path.resolve(process.env.COVER_CACHE_DIR ?? path.join(process.env.DATA_DIR ?? ".local/data", "covers"));
const derivativeDir = path.resolve(process.env.DERIVATIVE_DIR ?? path.join(dataDir, "derivatives"));
const posterVariantDir = path.join(derivativeDir, "posters");
const streamCacheDir = path.join(derivativeDir, "streams");
const coverSeedDir = path.resolve(process.env.COVER_SEED_DIR ?? "seed/covers");
const libraryConfigPath = path.join(dataDir, "library-config.json");
const favoritesPath = path.join(dataDir, "favorites.txt");
const metadataExportDir = path.resolve(process.env.METADATA_EXPORT_DIR ?? path.join(dataDir, "exports"));
const metadataExcelPath = path.resolve(
  process.env.METADATA_EXCEL_PATH ?? path.join(metadataExportDir, "adult-media-metadata.xlsx")
);
const metadataSeedPath = path.resolve(process.env.METADATA_SEED_PATH ?? "seed/metadata-seed.json.gz");
const metadataServerUrl = (process.env.METADATA_SERVER_URL ?? process.env.METATUBE_URL ?? "").trim().replace(/\/+$/, "");
const metadataFallbackServerUrl = (
  process.env.METADATA_FALLBACK_SERVER_URL ??
  process.env.METATUBE_FALLBACK_URL ??
  ""
)
  .trim()
  .replace(/\/+$/, "");
const metadataFallbackProvider = (process.env.METADATA_FALLBACK_PROVIDER ?? "").trim().toLowerCase();
const mediaWorkerMode = (process.env.MEDIA_WORKER_MODE ?? "embedded").trim().toLowerCase() === "external"
  ? "external"
  : "embedded";
const configuredSubtitleWhisperBackend = (process.env.SUBTITLE_WHISPER_BACKEND ?? "auto").trim().toLowerCase();
const subtitleWhisperBackend: "auto" | "openai" | "whisper-cpp" = configuredSubtitleWhisperBackend === "openai"
  ? "openai"
  : configuredSubtitleWhisperBackend === "whisper-cpp"
    ? "whisper-cpp"
    : "auto";
const subtitleWhisperCppCacheDir = path.join(os.homedir(), ".cache", "whisper.cpp");
const adaptiveSubtitleWhisperModel = ["large-v3-turbo", "small", "base"]
  .find((model) => fs.existsSync(path.join(subtitleWhisperCppCacheDir, `ggml-${model}.bin`)))
  ?? "base";
const subtitleWhisperModel = (process.env.SUBTITLE_WHISPER_MODEL
  ?? adaptiveSubtitleWhisperModel).trim();
const subtitleWhisperModelDir = path.resolve(
  process.env.SUBTITLE_WHISPER_MODEL_DIR ?? path.join(dataDir, "models", "whisper")
);
const subtitleWhisperCppModel = process.env.SUBTITLE_WHISPER_CPP_MODEL?.trim()
  || path.join(subtitleWhisperCppCacheDir, `ggml-${subtitleWhisperModel}.bin`);
const subtitleWhisperCppVadModel = process.env.SUBTITLE_WHISPER_CPP_VAD_MODEL?.trim()
  || path.join(subtitleWhisperCppCacheDir, "ggml-silero-v6.2.0.bin");
const localWhisperCppVadCommand = path.join(
  os.homedir(),
  ".local", "src", "whisper.cpp", "build", "bin", "whisper-vad-speech-segments"
);
const subtitleWhisperCppVadCommand = process.env.SUBTITLE_WHISPER_CPP_VAD_COMMAND?.trim()
  || (fs.existsSync(localWhisperCppVadCommand) ? localWhisperCppVadCommand : "whisper-vad-speech-segments");
const configuredRuntimeMode = (process.env.AMW_RUNTIME_MODE ?? "").trim().toLowerCase();
const runtimeMode: "local-pc" | "nas" = configuredRuntimeMode === "local-pc" || configuredRuntimeMode === "local"
  ? "local-pc"
  : configuredRuntimeMode === "nas" || configuredRuntimeMode === "docker"
    ? "nas"
    : fs.existsSync("/.dockerenv")
      ? "nas"
      : "local-pc";
const externalAiRoot = path.resolve(
  process.env.AMW_EXTERNAL_AI_ROOT ?? path.join(dataDir,"external-ai")
);
const contentPreviewRoot = path.resolve(
  process.env.AMW_CONTENT_PREVIEW_ROOT ?? path.join(externalAiRoot, "media-previews", "v1")
);
const entityProfileImagePolicy = (process.env.AMW_ENTITY_PROFILE_IMAGE_POLICY ?? "strict").trim().toLowerCase() === "strict"
  ? "strict" as const
  : "research" as const;
const lanMode = (process.env.AMW_LAN_MODE ?? "false").trim().toLowerCase() === "true";
const lanAuth = (process.env.AMW_LAN_AUTH ?? "true").trim().toLowerCase() === "true";
const bindHost = lanMode
  ? (process.env.AMW_HOST ?? "0.0.0.0").trim() || "0.0.0.0"
  : "127.0.0.1";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseClampedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function parseSourceLabel(label: string, fallbackName: string): Pick<MediaSource, "category" | "name"> {
  const [maybeCategory, maybeName] = label.split(":");
  if (maybeName) {
    return {
      category: maybeCategory.trim().toUpperCase() || "JAV",
      name: maybeName.trim() || fallbackName
    };
  }

  return {
    category: "JAV",
    name: label.trim() || fallbackName
  };
}

function parseMediaSources(): MediaSource[] {
  const configuredSources = process.env.MEDIA_SOURCES;

  if (configuredSources) {
    return configuredSources
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry, index) => {
        const separator = entry.indexOf("=");
        if (separator === -1) {
          return {
            category: "JAV",
            name: `Source-${index + 1}`,
            root: path.resolve(entry)
          };
        }

        const label = parseSourceLabel(entry.slice(0, separator), `Source-${index + 1}`);
        return {
          category: label.category,
          name: label.name,
          root: path.resolve(entry.slice(separator + 1).trim())
        };
      });
  }

  const configuredRoots = process.env.MEDIA_ROOTS;
  if (configuredRoots) {
    return configuredRoots
      .split(",")
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root, index) => ({
        category: "JAV",
        name: `Source-${index + 1}`,
        root: path.resolve(root)
      }));
  }

  return [{category:"LOCAL",name:"Library",root:path.resolve(process.env.MEDIA_ROOT ?? "media")}];
}

function parseLibraryRootsFromEnv(): [string, string] | null {
  const configuredRoots = process.env.MEDIA_LIBRARY_ROOTS;
  if (!configuredRoots) return null;

  const roots = configuredRoots
    .split(/[;,]/)
    .map((root) => root.trim())
    .filter(Boolean);

  if (roots.length < 2) return null;
  return [path.resolve(roots[0]), path.resolve(roots[1])];
}

function readSavedLibraryRoots(): LibraryRoots | null {
  if (!fs.existsSync(libraryConfigPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(libraryConfigPath, "utf8")) as Partial<LibraryRoots>;
    if (!Array.isArray(parsed.roots) || parsed.roots.length !== 2) return null;
    const roots = parsed.roots.map((root) => String(root).trim()).filter(Boolean);
    if (roots.length !== 2) return null;
    return {
      roots: [path.resolve(roots[0]), path.resolve(roots[1])],
      updatedAt: parsed.updatedAt
    };
  } catch {
    return null;
  }
}

function expandLibraryRoots(roots: [string, string]): MediaSource[] {
  return [
    {
      category: "JAV",
      name: "Japan-1",
      root: path.join(roots[0], "Japan")
    },
    {
      category: "JAV",
      name: "Japan-2",
      root: path.join(roots[1], "Japan")
    },
    {
      category: "FC2",
      name: "FC2-1",
      root: path.join(roots[0], "FC2")
    },
    {
      category: "FC2",
      name: "FC2-2",
      root: path.join(roots[1], "FC2")
    }
  ];
}

export function getLibraryRoots(): LibraryRoots {
  return (
    readSavedLibraryRoots() ?? {
      roots: parseLibraryRootsFromEnv() ?? defaultLibraryRoots
    }
  );
}

export function saveLibraryRoots(roots: [string, string]): LibraryRoots {
  fs.rmSync(path.join(dataDir,"library-sources.json"),{force:true});
  const normalizedRoots = roots.map((root) => path.resolve(root.trim())) as [string, string];
  const payload: LibraryRoots = {
    roots: normalizedRoots,
    updatedAt: new Date().toISOString()
  };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(libraryConfigPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function getMediaSources(): MediaSource[] {
  if (demoMode) return parseMediaSources();
  const publicSources = path.join(dataDir, "library-sources.json");
  if (fs.existsSync(publicSources)) {
    const saved = JSON.parse(fs.readFileSync(publicSources,"utf8")) as {sources:MediaSource[]};
    if (!Array.isArray(saved.sources) || !saved.sources.length) throw new Error("Invalid library-sources.json");
    return saved.sources;
  }
  const savedRoots = readSavedLibraryRoots();
  const envRoots = parseLibraryRootsFromEnv();

  if (savedRoots || envRoots) {
    return expandLibraryRoots((savedRoots?.roots ?? envRoots) as [string, string]);
  }

  if (process.env.MEDIA_SOURCES || process.env.MEDIA_ROOTS) {
    return parseMediaSources();
  }

  return parseMediaSources();
}

const mediaSources = getMediaSources();

export const config = {
  demoMode,
  port: Number.parseInt(process.env.PORT ?? "4310", 10),
  host: bindHost,
  network: {
    lanMode,
    requireAuthentication: lanAuth,
    accessToken: (process.env.AMW_ACCESS_TOKEN ?? "").trim(),
    pairingCode: (process.env.AMW_PAIRING_CODE ?? "").trim(),
    allowedOrigins: (process.env.AMW_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    trustProxy: (process.env.AMW_TRUST_PROXY ?? "false").trim().toLowerCase() === "true"
  },
  runtimeMode,
  mediaSources,
  mediaRoot: mediaSources[0]?.root ?? path.resolve("media"),
  dataDir,
  databasePath: demoMode ? ":memory:" : path.resolve(process.env.AMW_DATABASE_PATH?.trim() || path.join(dataDir, "media-wall.sqlite")),
  thumbnailDir,
  coverCacheDir,
  derivativeDir,
  posterVariantDir,
  streamCacheDir,
  coverSeedDir,
  libraryConfigPath,
  favoritesPath,
  metadataExportDir,
  metadataExcelPath,
  metadataSeedPath,
  scanOnStart: (process.env.SCAN_ON_START ?? "true") !== "false",
  scanStartDelayMs: parseNonNegativeInteger(process.env.SCAN_START_DELAY_MS, 15_000),
  storageRequired: (process.env.AMW_STORAGE_REQUIRED ?? "false").trim().toLowerCase() === "true",
  storageWaitMs: parseNonNegativeInteger(process.env.AMW_STORAGE_WAIT_SECONDS, 20) * 1_000,
  storageRecovery: {
    enabled: (process.env.AMW_STORAGE_RECOVERY_ENABLED ?? "true").trim().toLowerCase() !== "false",
    checkIntervalMs: Math.max(
      10_000,
      parsePositiveInteger(process.env.AMW_STORAGE_RECOVERY_CHECK_SECONDS, 30) * 1_000
    ),
    mountRetryMs: Math.max(
      60_000,
      parsePositiveInteger(process.env.AMW_STORAGE_RECOVERY_MOUNT_RETRY_SECONDS, 300) * 1_000
    ),
    maxMountAttempts: Math.min(
      parsePositiveInteger(process.env.AMW_STORAGE_RECOVERY_MAX_MOUNT_ATTEMPTS, 5),
      20
    ),
    mountWaitMs: Math.max(
      1_000,
      parsePositiveInteger(process.env.AMW_STORAGE_RECOVERY_WAIT_SECONDS, 20) * 1_000
    )
  },
  mediaWorkerConcurrency: parsePositiveInteger(process.env.MEDIA_WORKER_CONCURRENCY, 1),
  mediaWorkerFfmpegThreads: Math.min(parsePositiveInteger(process.env.MEDIA_WORKER_FFMPEG_THREADS, 1), 4),
  mediaWorkerProcessNiceness: parseClampedInteger(process.env.MEDIA_WORKER_PROCESS_NICENESS, 10, 0, 19),
  mediaWorkerForegroundPriority: parseClampedInteger(process.env.MEDIA_WORKER_FOREGROUND_PRIORITY, 90, 1, 1_000),
  mediaWorkerSchedule: {
    timeZone: (process.env.MEDIA_WORKER_TIMEZONE ?? process.env.TZ ?? "Asia/Shanghai").trim() || "Asia/Shanghai",
    nightStartHour: parseClampedInteger(process.env.MEDIA_WORKER_NIGHT_START_HOUR, 1, 0, 23),
    nightEndHour: parseClampedInteger(process.env.MEDIA_WORKER_NIGHT_END_HOUR, 7, 0, 23),
    daytimeCooldownMs: parseNonNegativeInteger(process.env.MEDIA_WORKER_DAYTIME_COOLDOWN_SECONDS, 0) * 1_000
  },
  mediaWorkerMode,
  mediaProbeStartupBatch: parsePositiveInteger(process.env.MEDIA_PROBE_STARTUP_BATCH, 240),
  externalAi: {
    enabled: (process.env.AMW_AGENT_ENABLED ?? "false").trim().toLowerCase() !== "false",
    root: externalAiRoot,
    markerFile: (process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json").trim(),
    expectedStorageId: (process.env.AMW_EXTERNAL_AI_STORAGE_ID ?? "").trim(),
    allowInternalFallback: false,
    ollamaUrl: (process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435").trim().replace(/\/+$/, ""),
    chatModel: (process.env.AMW_AGENT_CHAT_MODEL ?? "qwen3.5:9b").trim(),
    embeddingModel: (process.env.AMW_AGENT_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b").trim(),
    translationModel: (process.env.AMW_AGENT_TRANSLATION_MODEL ?? "qwen3.8-ridge:27b").trim(),
    translationExternalized: (process.env.AMW_TRANSLATION_EXTERNALIZED ?? "false").trim().toLowerCase() === "true",
    entityProfileImagePolicy,
    entityProfileImageCacheDir: path.join(externalAiRoot, "agent", "cache", "entity-profile-images", "v1")
  },
  contentPreview: {
    enabled: (process.env.AMW_CONTENT_PREVIEW_ENABLED ?? "true").trim().toLowerCase() !== "false",
    storageRoot: externalAiRoot,
    root: contentPreviewRoot,
    markerFile: (process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json").trim(),
    expectedStorageId: (process.env.AMW_EXTERNAL_AI_STORAGE_ID ?? "").trim(),
    profileVersion: 1,
    photoWidth: Math.min(parsePositiveInteger(process.env.AMW_CONTENT_PREVIEW_PHOTO_WIDTH, 960), 1920),
    gifWidth: Math.min(parsePositiveInteger(process.env.AMW_CONTENT_PREVIEW_GIF_WIDTH, 480), 960),
    gifDurationSeconds: Math.min(parsePositiveInteger(process.env.AMW_CONTENT_PREVIEW_GIF_SECONDS, 4), 12),
    gifFps: Math.min(parsePositiveInteger(process.env.AMW_CONTENT_PREVIEW_GIF_FPS, 6), 12),
    gifMaxBytes: parsePositiveInteger(process.env.AMW_CONTENT_PREVIEW_GIF_MAX_MB, 6) * 1024 * 1024,
    fastSeek: (process.env.AMW_CONTENT_PREVIEW_FAST_SEEK ?? "true").trim().toLowerCase() !== "false",
    sourceConcurrency: Math.min(
      parseNonNegativeInteger(process.env.AMW_CONTENT_PREVIEW_SOURCE_CONCURRENCY, 0),
      32
    )
  },
  subtitleTranslation: {
    autoTranslateFavorites: (process.env.SUBTITLE_AUTO_TRANSLATE_FAVORITES ?? "false").trim().toLowerCase() !== "false",
    provider: (process.env.SUBTITLE_TRANSLATION_PROVIDER ?? process.env.TRANSLATE_PROVIDER ?? "google").trim().toLowerCase(),
    targetLanguage: (process.env.SUBTITLE_TRANSLATION_TARGET_LANG ?? "zh-CN").trim(),
    sourceLanguage: (process.env.SUBTITLE_TRANSLATION_SOURCE_LANG ?? "ja").trim(),
    requestDelayMs: parsePositiveInteger(process.env.SUBTITLE_TRANSLATION_DELAY_MS, 350),
    requestTimeoutMs: parsePositiveInteger(process.env.SUBTITLE_TRANSLATION_TIMEOUT_MS, 30_000),
    contextualTranslation: (process.env.SUBTITLE_CONTEXTUAL_TRANSLATION ?? "true").trim().toLowerCase() !== "false",
    contextualTranslationUrl: (process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_URL ?? "http://127.0.0.1:11434").trim().replace(/\/+$/, ""),
    contextualTranslationModel: (process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_MODEL ?? "qwen3.8-ridge:27b").trim(),
    contextualTranslationTimeoutMs: parsePositiveInteger(process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_TIMEOUT_MS, 120_000),
    // A larger ASR-correction window reduces model round-trips on the M2 Pro.
    // Translation requests may use up to 24 cues; the contextual translator
    // recursively splits a window if structured output is incomplete.
    contextualTranslationBatchSize: Math.min(parsePositiveInteger(process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_BATCH_SIZE, 48), 48),
    contextualTranslationRequestBatchSize: Math.min(
      parsePositiveInteger(process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_REQUEST_BATCH_SIZE, 16),
      24
    ),
    contextualTranslationRequestConcurrency: Math.min(
      parsePositiveInteger(process.env.SUBTITLE_CONTEXTUAL_TRANSLATION_REQUEST_CONCURRENCY, 1),
      2
    ),
    asrCorrection: (process.env.SUBTITLE_ASR_CORRECTION ?? "true").trim().toLowerCase() !== "false",
    asrCorrectionModel: (process.env.SUBTITLE_ASR_CORRECTION_MODEL ?? "qwen3.8-ridge:27b").trim(),
    dedicatedTranslation: (process.env.SUBTITLE_DEDICATED_TRANSLATION ?? "false").trim().toLowerCase() !== "false",
    dedicatedTranslationModel: (process.env.SUBTITLE_DEDICATED_TRANSLATION_MODEL ?? "hy-mt1.5:7b-q4").trim(),
    dedicatedTranslationTimeoutMs: parsePositiveInteger(process.env.SUBTITLE_DEDICATED_TRANSLATION_TIMEOUT_MS, 180_000),
    libreTranslateUrl: (process.env.LIBRETRANSLATE_URL ?? "http://localhost:5000").trim().replace(/\/+$/, ""),
    libreTranslateApiKey: (process.env.LIBRETRANSLATE_API_KEY ?? "").trim(),
    whisperBackend: subtitleWhisperBackend,
    whisperCommand: (process.env.SUBTITLE_WHISPER_COMMAND ?? "whisper").trim(),
    whisperModel: subtitleWhisperModel,
    whisperModelDir: subtitleWhisperModelDir,
    whisperThreads: Math.min(parsePositiveInteger(process.env.SUBTITLE_WHISPER_THREADS, 6), 12),
    whisperCppCommand: (process.env.SUBTITLE_WHISPER_CPP_COMMAND ?? "whisper-cli").trim(),
    whisperCppModel: path.resolve(subtitleWhisperCppModel),
    whisperCppMetal: (process.env.SUBTITLE_WHISPER_CPP_METAL ?? "true").trim().toLowerCase() !== "false",
    whisperCppVad: (process.env.SUBTITLE_WHISPER_CPP_VAD ?? "true").trim().toLowerCase() !== "false",
    whisperCppVadCommand: subtitleWhisperCppVadCommand,
    whisperCppVadModel: path.resolve(subtitleWhisperCppVadModel)
  },
  derivativeCacheMaxBytes: parsePositiveInteger(process.env.DERIVATIVE_CACHE_MAX_GB, 20) * 1024 * 1024 * 1024,
  coverCacheMaxBytes: parsePositiveInteger(process.env.COVER_CACHE_MAX_GB, 8) * 1024 * 1024 * 1024,
  metadata: {
    provider: (process.env.METADATA_PROVIDER ?? "metatube").trim().toLowerCase(),
    serverUrl: metadataServerUrl,
    token: (process.env.METADATA_TOKEN ?? process.env.METATUBE_TOKEN ?? "").trim(),
    fallbackProvider: metadataFallbackProvider,
    fallbackServerUrl: metadataFallbackServerUrl,
    fallbackToken: (process.env.METADATA_FALLBACK_TOKEN ?? process.env.METATUBE_FALLBACK_TOKEN ?? "").trim(),
    metatubeCommand: process.env.METADATA_METATUBE_COMMAND?.trim() || "",
    metatubeDatabasePath: path.resolve(
      process.env.METADATA_METATUBE_DB
        ?? path.join(dataDir, "metatube.db")
    ),
    manageMetatube: (process.env.METADATA_MANAGE_METATUBE ?? "false").trim().toLowerCase() === "true",
    autoEnrich: (process.env.METADATA_AUTO_ENRICH ?? "false") !== "false",
    categoryFilter: (process.env.METADATA_CATEGORY_FILTER ?? "").trim().toUpperCase(),
    batchSize: parsePositiveInteger(process.env.METADATA_BATCH_SIZE, 80),
    concurrency: parsePositiveInteger(process.env.METADATA_CONCURRENCY, 1),
    requestDelayMs: parsePositiveInteger(process.env.METADATA_REQUEST_DELAY_MS, 850),
    requestTimeoutMs: parsePositiveInteger(process.env.METADATA_REQUEST_TIMEOUT_MS, 180000),
    maxAttempts: parsePositiveInteger(process.env.METADATA_MAX_ATTEMPTS, 2)
  }
};

export const supportedExtensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".avi",
  ".mpg",
  ".mpeg",
  ".webm",
  ".wmv",
  ".flv",
  ".ts",
  ".m2ts",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif"
]);

export function getMediaType(extension: string): "video" | "image" {
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)
    ? "image"
    : "video";
}

export function getMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };

  return mimeTypes[extension] ?? "application/octet-stream";
}
