import fs from "node:fs/promises";
import path from "node:path";
import { getMediaType, supportedExtensions } from "./config.js";

export type LibrarySourceSample = { checked: number; videos: number; subtitles: number; metadata: number; limited: boolean; unreadableDirectories: number };

// A bounded, read-only hint, not an inventory. Do not follow directory symlinks
// or read any file contents, and never return private sample filenames.
export async function sampleLibrarySource(root: string, limit = 300): Promise<LibrarySourceSample> {
  const result: LibrarySourceSample = { checked: 0, videos: 0, subtitles: 0, metadata: 0, limited: false, unreadableDirectories: 0 };
  const queue = [root];
  while (queue.length && result.checked < limit) {
    const directory = queue.shift()!;
    let entries;
    try { entries = await fs.opendir(directory); }
    catch { result.unreadableDirectories++; continue; }
    for await (const entry of entries) {
      if (result.checked >= limit) { result.limited = true; break; }
      result.checked++;
      if (entry.isDirectory()) { queue.push(path.join(directory, entry.name)); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (supportedExtensions.has(extension) && getMediaType(extension) === "video") result.videos++;
      if ([".srt", ".ass", ".ssa", ".vtt"].includes(extension)) result.subtitles++;
      if (extension === ".nfo" || /\.media\.json$/i.test(entry.name)) result.metadata++;
    }
  }
  if (queue.length) result.limited = true;
  return result;
}
