export const ENCODINGS = [
  "auto",
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "big5",
  "shift_jis",
  "windows-1252",
] as const;
export function decodeText(buffer: Buffer, encoding = "auto") {
  if (!(ENCODINGS as readonly string[]).includes(encoding))
    throw new Error("Unsupported text encoding");
  if (encoding === "auto") {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
    else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
    else {
      try {
        return new TextDecoder("utf-8", { fatal: true })
          .decode(buffer)
          .replace(/^\uFEFF/, "");
      } catch {
        throw new Error(
          "Subtitle encoding is ambiguous; select GB18030, Big5 or Shift JIS explicitly",
        );
      }
    }
  }
  return new TextDecoder(encoding, { fatal: true })
    .decode(buffer)
    .replace(/^\uFEFF/, "");
}
function timestamp(value: string) {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match || +match[2] > 59 || +match[3] > 59) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${match[4].padEnd(3, "0")}`;
}
function plain(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function timeValue(value: string) {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}
export function subtitleVtt(input: string, format: string) {
  const body = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (format === "vtt" && /^WEBVTT(?:\s|$)/.test(body)) return body;
  if (format === "ass" || format === "ssa") {
    let section = "";
    let fields = [
      "layer",
      "start",
      "end",
      "style",
      "name",
      "marginl",
      "marginr",
      "marginv",
      "effect",
      "text",
    ];
    const cues: string[] = [];
    for (const line of body.split("\n")) {
      if (/^\[/.test(line)) section = line.trim().toLowerCase();
      if (section !== "[events]") continue;
      if (/^format:/i.test(line))
        fields = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((s) => s.trim().toLowerCase());
      if (!/^dialogue:/i.test(line)) continue;
      // Text is the final ASS/SSA field and can itself contain commas.
      if (
        fields.at(-1) !== "text" ||
        !fields.includes("start") ||
        !fields.includes("end")
      )
        continue;
      const parts = line
        .slice(line.indexOf(":") + 1)
        .trim()
        .split(",");
      const values = parts.slice(0, fields.length - 1);
      values.push(parts.slice(fields.length - 1).join(","));
      const start = timestamp(values[fields.indexOf("start")] || "");
      const end = timestamp(values[fields.indexOf("end")] || "");
      const text =
        values
          .at(-1)
          ?.replace(/\{[^}]*\}/g, "")
          .replace(/\\[Nn]/g, "\n")
          .replace(/\\h/g, " ") || "";
      if (start && end && timeValue(end) > timeValue(start) && text.trim())
        cues.push(`${start} --> ${end}\n${plain(text)}`);
    }
    if (!cues.length) throw new Error("No text subtitle cues found");
    return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
  }
  const cues = body.split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) return [];
    const times = lines[index].split("-->");
    const start = timestamp(times[0]),
      end = timestamp(times[1]?.trim().split(/\s/)[0] || "");
    if (!start || !end || timeValue(end) <= timeValue(start)) return [];
    return [`${start} --> ${end}\n${plain(lines.slice(index + 1).join("\n"))}`];
  });
  if (!cues.length) throw new Error("No text subtitle cues found");
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n";
}
