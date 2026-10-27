import { config } from "./config.js";

export function withMediaWorkerFfmpegLimits(args: string[]): string[] {
  const threads = String(config.mediaWorkerFfmpegThreads);
  return [
    "-threads", threads,
    "-filter_threads", threads,
    "-filter_complex_threads", threads,
    ...args
  ];
}
