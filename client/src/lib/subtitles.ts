export type PlayerSubtitleCue = {
  start: number;
  end: number;
  text: string;
};

type SubtitleSourceDescriptor = {
  language: string;
  label: string;
};

export function hasNativeChineseSubtitle(
  sidecars: SubtitleSourceDescriptor[],
  translationSourceKind?: string | null
): boolean {
  if (translationSourceKind === "existing-chinese") return true;
  return sidecars.some((sidecar) => (
    /^(zh|zho|chi|chs|cht)(-|$)/i.test(sidecar.language)
    || /中文|简体|繁体|chinese/i.test(sidecar.label)
  ));
}

function parseTimestamp(value: string): number | null {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3_600
    + Number(match[2]) * 60
    + Number(match[3])
    + Number(match[4]) / 1_000;
}

export function parseWebVtt(content: string): PlayerSubtitleCue[] {
  const blocks = content.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  const cues: PlayerSubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 0 || /^WEBVTT/i.test(lines[0]) || /^NOTE(?:\s|$)/i.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex].trim());
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((left, right) => left.start - right.start);
}

export function findActiveSubtitleText(cues: PlayerSubtitleCue[], currentTime: number): string {
  if (!Number.isFinite(currentTime) || cues.length === 0) return "";
  return cues
    .filter((cue) => cue.start <= currentTime && currentTime < cue.end)
    .map((cue) => cue.text)
    .join("\n");
}
