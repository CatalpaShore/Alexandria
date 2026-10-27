import { spawn } from "node:child_process";
import type { MediaRow } from "./db.js";

export type MediaProbeResult = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  containerFormat: string;
  videoCodec: string;
  audioCodec: string;
  compatibilityStatus: MediaRow["compatibility_status"];
};

type FfprobePayload = {
  format?: {
    duration?: string;
    format_name?: string;
  };
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    width?: number;
    height?: number;
  }>;
};

export function classifyCompatibility(
  extension: string,
  containerFormat: string,
  videoCodec: string,
  audioCodec: string
): MediaRow["compatibility_status"] {
  const normalizedExtension = extension.toLowerCase();
  const normalizedContainer = containerFormat.toLowerCase();
  const normalizedVideo = videoCodec.toLowerCase();
  const normalizedAudio = audioCodec.toLowerCase();
  // Keep the server-side baseline portable across Chrome, Android WebView and NAS browsers.
  // HEVC support is device-dependent and can otherwise produce audio-only playback.
  const browserVideoCodecs = new Set(["h264", "av1", "vp8", "vp9"]);
  const browserAudioCodecs = new Set(["", "aac", "mp3", "opus", "vorbis", "ac3", "eac3"]);
  const browserContainers = new Set(["mp4", "m4v", "mov", "webm"]);

  if (
    browserContainers.has(normalizedExtension) &&
    browserVideoCodecs.has(normalizedVideo) &&
    browserAudioCodecs.has(normalizedAudio)
  ) {
    return "native";
  }

  const canRemux =
    browserVideoCodecs.has(normalizedVideo) &&
    browserAudioCodecs.has(normalizedAudio) &&
    (normalizedContainer.includes("matroska") || ["mkv", "avi", "mpeg", "wmv", "flv"].includes(normalizedExtension));

  return canRemux ? "remux" : normalizedVideo ? "transcode" : "unsupported";
}

export async function probeMediaFile(row: MediaRow, timeoutMs = 30_000): Promise<MediaProbeResult> {
  const payload = await new Promise<FfprobePayload>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        row.absolute_path
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffprobe timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `ffprobe exited with ${code ?? "unknown"}`));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as FfprobePayload);
      } catch {
        reject(new Error("ffprobe returned invalid JSON"));
      }
    });
  });

  const videoStream = payload.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = payload.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number.parseFloat(payload.format?.duration ?? "");
  const containerFormat = payload.format?.format_name?.split(",")[0]?.trim() ?? "";
  const videoCodec = videoStream?.codec_name?.trim() ?? "";
  const audioCodec = audioStream?.codec_name?.trim() ?? "";

  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    containerFormat,
    videoCodec,
    audioCodec,
    compatibilityStatus: classifyCompatibility(row.extension, containerFormat, videoCodec, audioCodec)
  };
}
