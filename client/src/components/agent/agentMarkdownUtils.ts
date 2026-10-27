type CitationReference = {
  code?: string;
};

const vagueReferencePattern = /(?:证据中的实际作品番号|实际作品番号|作品番号|影片番号|番号|影片|作品|证据|条目)\s*(\[(\d{1,2})\])/gu;

function citationCode(citations: CitationReference[], referenceNumber: number): string {
  return citations[referenceNumber - 1]?.code?.trim() ?? "";
}

function resolveCitationLine(line: string, citations: CitationReference[]): string {
  const explicit = line.replace(
    vagueReferencePattern,
    (original, reference: string, number: string, offset: number, source: string) => {
      const code = citationCode(citations, Number(number));
      if (!code) return original;
      const separator = offset > 0 && !/[\s([{“"'`*_—–-]/u.test(source[offset - 1]) ? " " : "";
      return `${separator}${code} ${reference}`;
    }
  );

  return explicit.replace(/\[(\d{1,2})]/g, (reference, number: string, offset: number, source: string) => {
    const code = citationCode(citations, Number(number));
    if (!code) return reference;
    const nearbyPrefix = source.slice(Math.max(0, offset - code.length - 24), offset);
    return nearbyPrefix.includes(code) ? reference : `${code} ${reference}`;
  });
}

export function resolveAgentCitationReferences(
  content: string,
  citations: CitationReference[]
): string {
  if (citations.length === 0 || !/\[\d{1,2}]/.test(content)) return content;
  let insideCodeFence = false;
  return content.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      insideCodeFence = !insideCodeFence;
      return line;
    }
    return insideCodeFence ? line : resolveCitationLine(line, citations);
  }).join("\n");
}

export function normalizeAgentMarkdown(content: string): string {
  let insideCodeFence = false;
  return content.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      insideCodeFence = !insideCodeFence;
      return line;
    }
    if (insideCodeFence || !/<br\s*\/?>/i.test(line)) return line;
    const replacement = line.includes("|") ? " · " : "  \n";
    return line.replace(/\s*<br\s*\/?>\s*/gi, replacement);
  }).join("\n");
}
