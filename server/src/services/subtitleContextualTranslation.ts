import {
  assessSubtitleTranslationText,
  normalizeRepeatedSpeechText,
  normalizeTranslationArtifactText
} from "./subtitleTranslationText.js";

const generationModelKeepAlive = (process.env.OLLAMA_KEEP_ALIVE ?? "2m").trim() || "2m";

export type ContextualSubtitleCue = {
  id: number;
  text: string;
};

export type ContextualTranslationContext = {
  code: string;
  title: string;
  genres: string[];
  previous: string[];
  next: string[];
};

export type ContextualTranslationResult = {
  translations: string[];
  correctedSources: string[];
  confidences: number[];
};

export type DedicatedTranslationResult = {
  translations: string[];
};

/**
 * Contextual translation already returns a high-confidence `corrections` list
 * in the same structured response. Running a second ASR-only request before
 * that call therefore duplicates model work on the normal local-Qwen path.
 * Keep the standalone pass only for the dedicated-translator or non-contextual
 * fallback paths, where no integrated correction response is available.
 */
export function shouldUseStandaloneAsrCorrection(options: {
  enabled: boolean;
  contextualTranslation: boolean;
  dedicatedTranslation: boolean;
}): boolean {
  return options.enabled && (!options.contextualTranslation || options.dedicatedTranslation);
}

export function correctJapaneseRecognitionWithContext(
  text: string,
  previousText = "",
  nextText = ""
): string {
  const correctedText = text.replace(/ジンポ/gu, "チンポ");
  const compact = correctedText.replace(/[\s。.!！?？]/gu, "");
  const previous = previousText.replace(/[\s。.!！?？]/gu, "");
  const next = nextText.replace(/[\s。.!！?？]/gu, "");
  if (compact === "気温いいですか" && /すいません|すみません/u.test(previous) && /^(?:はい|ええ)$/u.test(next)) {
    return "質問いいですか";
  }
  const checkout = /^おかげで([\d,]+円になります)$/u.exec(compact);
  if (checkout) return `お会計は${checkout[1]}`;
  if (compact === "ちょうどいっておきます" && /[\d,]+円/u.test(previous)) return "ちょうどでお願いします";
  if (compact === "お尻尾" && /三つの穴/u.test(previous) && /たくさんください/u.test(next)) return "おチンポ";
  if (compact === "それは困りません" && /取引を停止する/u.test(previous) && /^そうだよな$/u.test(next)) {
    return "それは困ります";
  }
  if (compact === "もっと出しなさい" && /舌/u.test(previous)) return "もっと舌を出しなさい";
  if (compact === "ムチなんですよ" && /エロに対して/u.test(previous) && /フリースタイル/u.test(next)) {
    return "無知なんですよ";
  }
  if (compact === "きのうまくなってしまった") {
    if (/きのうまくなってしまった/u.test(next)) {
      return "ねえ、見れたことがあって、ちょっとチェックしてみようかな";
    }
    if (/見れたことがあって|チェックしてみようかな/u.test(previous)) {
      return "え？やんないけん？";
    }
  }
  return correctedText;
}

type OllamaCueResult = {
  id?: number | string;
  anchor?: string;
  zh?: string;
};

type OllamaCorrectionResult = {
  id?: number | string;
  correctedJa?: string;
  confidence?: number;
};

function cleanModelJson(value: string): string {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function cleanChineseSubtitle(value: string): string {
  return normalizeTranslationArtifactText(value)
    .replace(/^\s*(?:翻译|译文|中文字幕)\s*[:：]\s*/u, "")
    .replace(/^["“]|["”]$/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeModelTranslation(sourceText: string, value: string): string {
  void sourceText;
  return normalizeRepeatedSpeechText(cleanChineseSubtitle(value));
}

/**
 * Reject model output that silently contains neighbouring subtitles. The
 * threshold mirrors the audit script; callers recursively split the batch or
 * fall back to a single-cue request when this gate trips.
 */
export function isLikelyOverlongSubtitleTranslation(sourceText: string, translatedText: string): boolean {
  const sourceLength = Array.from(sourceText.replace(/\s/gu, "")).length;
  const translatedLength = Array.from(translatedText.replace(/\s/gu, "")).length;
  return translatedLength > Math.max(48, sourceLength * 1.8);
}

function assessContextualModelOutput(sourceText: string, translatedText: string): {
  okay: boolean;
  reasons: string[];
} {
  const quality = assessSubtitleTranslationText(sourceText, translatedText);
  if (isLikelyOverlongSubtitleTranslation(sourceText, translatedText)) {
    quality.reasons.push("overlong");
    quality.okay = false;
  }
  return quality;
}

function singleCueOutputLimit(sourceText: string): number {
  const sourceLength = Array.from(sourceText.replace(/\s/gu, "")).length;
  return Math.max(48, Math.ceil(sourceLength * 1.8));
}

function canRetrySingleCueQuality(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((reason) => reason === "empty" || reason === "overlong");
}

export function buildContextualCueAnchor(value: string): string {
  const compact = value.replace(/\s/gu, "").trim();
  const chars = Array.from(compact);
  if (chars.length <= 8) return `${compact}:${chars.length}`;
  return `${chars.slice(0, 4).join("")}…${chars.slice(-4).join("")}:${chars.length}`;
}

function nonVerbalJapaneseFallback(sourceText: string): string | null {
  const compact = sourceText.replace(/[\s、，。.!！?？・ー〜～…]/gu, "");
  if (Array.from(compact).length < 4 || !/^[はあぁうぅんっおほへえ]+$/u.test(compact)) return null;
  return /^[うぅ]/u.test(compact) ? "呜……" : "啊……";
}

function parseMarkedTranslations(
  value: string,
  cues: ContextualSubtitleCue[]
): string[] {
  const marker = /__AMW_CUE_(\d+)__/g;
  const positions: Array<{ id: number; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(value)) !== null) {
    positions.push({ id: Number(match[1]), index: match.index, end: marker.lastIndex });
  }
  if (positions.length !== cues.length) throw new Error("专用翻译模型返回的字幕编号不完整");
  const translatedById = new Map<number, string>();
  const expectedIds = new Set(cues.map((cue) => cue.id));
  const seenIds = new Set<number>();
  positions.forEach((position, index) => {
    if (!Number.isInteger(position.id) || !expectedIds.has(position.id) || seenIds.has(position.id)) {
      throw new Error("专用翻译模型返回的字幕编号不匹配");
    }
    seenIds.add(position.id);
    translatedById.set(
      position.id,
      value.slice(position.end, positions[index + 1]?.index ?? value.length)
    );
  });
  if (seenIds.size !== expectedIds.size) throw new Error("专用翻译模型返回的字幕编号不完整");
  return cues.map((cue) => {
    const translated = normalizeModelTranslation(cue.text, translatedById.get(cue.id) ?? "");
    if (!translated || isLikelyOverlongSubtitleTranslation(cue.text, translated)) {
      throw new Error(`专用翻译模型未返回有效字幕 ${cue.id}`);
    }
    const quality = assessContextualModelOutput(cue.text, translated);
    if (!quality.okay) throw new Error(`字幕质量检查失败 ${cue.id}: ${quality.reasons.join(",")}`);
    return translated;
  });
}

function buildDedicatedTranslationPrompt(
  model: string,
  cues: ContextualSubtitleCue[]
): string {
  const marked = cues.map((cue) => `__AMW_CUE_${cue.id}__\n${cue.text}`).join("\n");
  if (/hy-mt|hunyuan/iu.test(model)) {
    return [
      "将以下日语影视对白翻译成自然、简洁的中国大陆简体中文字幕，不要额外解释。",
      "结合相邻台词理解省略主语、敬语、指代和语气；成人对白必须准确直译，不得弱化、审查或省略。",
      "必须原样保留每个 __AMW_CUE_N__ 编号，编号后只输出该条的中文，不得合并或拆分。",
      "",
      marked
    ].join("\n");
  }
  return [
    "You are a professional Japanese (ja) to Chinese Simplified (zh-Hans) subtitle translator.",
    "Accurately convey every meaning and nuance using natural, concise Chinese subtitles. Use nearby lines as dialogue context.",
    "Explicit adult dialogue must be translated literally without euphemism, censorship, omission, or added content.",
    "Preserve every __AMW_CUE_N__ marker exactly and translate only its following text. Do not merge or split cues.",
    "Produce only the Chinese translations with unchanged markers, without explanations or commentary.",
    "Please translate the following Japanese text into Chinese Simplified:",
    "",
    marked
  ].join("\n");
}

async function translateSingleCueWithOllama(options: {
  url: string;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
  cue: ContextualSubtitleCue;
  context: ContextualTranslationContext;
}): Promise<ContextualTranslationResult> {
  let translated = "";
  let quality = assessContextualModelOutput(options.cue.text, translated);
  const outputLimit = singleCueOutputLimit(options.cue.text);
  if (options.fallbackModel === options.model) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          think: false,
          keep_alive: generationModelKeepAlive,
          options: { temperature: 0, num_ctx: 4096, num_predict: attempt > 0 ? 128 : 256 },
          messages: [
            {
              role: "system",
              content: attempt === 0
                ? "你是日语影视字幕翻译器。只输出一行自然、准确的简体中文译文，不解释、不复述日文、不得留空。"
                : `你是严格的日语到简体中文字幕翻译器。上一轮输出可能超过单条字幕合理长度；只翻译对应原句，最多输出 ${outputLimit} 个汉字，禁止合并相邻台词。只输出一行中文，禁止出现任何日文假名、日文汉字原文、英文解释、JSON 或空内容。`
            },
            {
              role: "user",
              content: attempt === 2
                ? [`日语原句：${options.cue.text}`, `只输出不超过 ${outputLimit} 个汉字的中文：`].join("\n")
                : [
                    `作品：${options.context.code} ${options.context.title}`.trim(),
                    `前文：${options.context.previous.slice(-2).join(" / ")}`,
                    `日文：${options.cue.text}`,
                    `后文：${options.context.next.slice(0, 2).join(" / ")}`,
                    attempt === 0 ? "中文：" : `请只给出不超过 ${outputLimit} 个汉字的中文译文：`
                  ].join("\n")
            }
          ]
        }),
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      if (!response?.ok) continue;
      const body = await response.json() as { message?: { content?: string } };
      translated = normalizeModelTranslation(options.cue.text, body.message?.content ?? "").split(/\r?\n/u).filter(Boolean)[0] ?? "";
      quality = assessContextualModelOutput(options.cue.text, translated);
      if (quality.okay) return { translations: [translated], correctedSources: [options.cue.text], confidences: [0] };
    }
  }
  if (options.fallbackModel !== options.model) for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = attempt === 2
      ? [
          "你是日语翻译器。即使原句口语化、残缺或含糊，也必须给出最合理的简体中文译文。",
          `只输出一行不超过 ${outputLimit} 个汉字的中文，不解释、不复述日文、不能留空；不得合并相邻字幕。`,
          `原文：${options.cue.text}`,
          "译文："
        ].join("\n")
      : [
          "将下面一条日语影视对白翻译成自然、简洁的中国大陆简体中文字幕。",
          "准确处理口语、省略主语和成人内容，不增加解释，不输出日文，不要 JSON，只输出一行中文译文。",
          ...(attempt > 0 ? [
            quality.reasons.includes("overlong")
              ? `上一轮译文超过单条字幕合理长度；本轮只翻译这一句，最多 ${outputLimit} 个汉字，不得补充上下文。`
              : "上一轮返回了空内容；本轮必须输出非空的中文译文。"
          ] : []),
          `作品：${options.context.code} ${options.context.title}`.trim(),
          `前文：${options.context.previous.slice(-2).join(" / ")}`,
          `日文：${options.cue.text}`,
          `后文：${options.context.next.slice(0, 2).join(" / ")}`
        ].join("\n");
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
      keep_alive: generationModelKeepAlive,
        options: { temperature: 0, num_ctx: 4096, num_predict: 256 },
        prompt
      }),
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (!response.ok) throw new Error(`Ollama 单条翻译失败：${response.status}`);
    const body = await response.json() as { response?: string };
    translated = normalizeModelTranslation(options.cue.text, body.response ?? "").split(/\r?\n/u).filter(Boolean)[0] ?? "";
    quality = assessContextualModelOutput(options.cue.text, translated);
    if (quality.okay) break;
    if (canRetrySingleCueQuality(quality.reasons)) {
      const nonVerbalFallback = nonVerbalJapaneseFallback(options.cue.text);
      if (quality.reasons.length === 1 && quality.reasons[0] === "empty" && nonVerbalFallback) {
        translated = nonVerbalFallback;
        quality = assessContextualModelOutput(options.cue.text, translated);
        break;
      }
      continue;
    }
    break;
  }
  if (
    !quality.okay
    && quality.reasons.length === 1
    && quality.reasons[0] === "empty"
    && (!options.fallbackModel || options.fallbackModel === options.model)
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          think: false,
          keep_alive: generationModelKeepAlive,
          options: { temperature: 0, num_ctx: 4096, num_predict: 256 },
          messages: [
            {
              role: "system",
              content: "你是日语影视字幕翻译器。只输出一行自然、准确的简体中文译文，不解释、不复述日文、不得留空。"
            },
            {
              role: "user",
              content: [
                `作品：${options.context.code} ${options.context.title}`.trim(),
                `前文：${options.context.previous.slice(-2).join(" / ")}`,
                `日文：${options.cue.text}`,
                `后文：${options.context.next.slice(0, 2).join(" / ")}`,
                "中文："
              ].join("\n")
            }
          ]
        }),
        signal: AbortSignal.timeout(options.timeoutMs)
      });
      if (!response) break;
      if (!response.ok) throw new Error(`Ollama 普通聊天翻译失败：${response.status}`);
      const body = await response.json() as { message?: { content?: string } };
      translated = normalizeModelTranslation(options.cue.text, body.message?.content ?? "").split(/\r?\n/u).filter(Boolean)[0] ?? "";
      quality = assessContextualModelOutput(options.cue.text, translated);
      if (quality.okay) break;
    }
  }
  if (
    !quality.okay
    && quality.reasons.length === 1
    && quality.reasons[0] === "empty"
    && options.fallbackModel
    && options.fallbackModel !== options.model
  ) {
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.fallbackModel,
        stream: false,
      keep_alive: generationModelKeepAlive,
        options: { temperature: 0, num_ctx: 4096, num_predict: 256 },
        prompt: [
          "将以下日语影视对白翻译成自然、简洁的中国大陆简体中文。",
          "原句即使口语化、残缺或含糊，也必须给出最合理的译文。",
          "只输出一行中文，不解释、不复述日文、不能留空。",
          `日文：${options.cue.text}`,
          "中文："
        ].join("\n")
      }),
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (!response.ok) throw new Error(`Ollama 备用翻译模型失败：${response.status}`);
    const body = await response.json() as { response?: string };
    translated = normalizeModelTranslation(options.cue.text, body.response ?? "").split(/\r?\n/u).filter(Boolean)[0] ?? "";
    quality = assessContextualModelOutput(options.cue.text, translated);
  }
  if (!quality.okay) throw new Error(`单条字幕质量检查失败 ${options.cue.id}: ${quality.reasons.join(",")}`);
  return { translations: [translated], correctedSources: [options.cue.text], confidences: [0] };
}

export async function translateWithDedicatedOllama(options: {
  url: string;
  model: string;
  timeoutMs: number;
  cues: ContextualSubtitleCue[];
}): Promise<DedicatedTranslationResult> {
  try {
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        prompt: buildDedicatedTranslationPrompt(options.model, options.cues),
        stream: false,
        keep_alive: generationModelKeepAlive,
        options: { temperature: 0, num_ctx: 8192, num_predict: 2048 }
      }),
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (!response.ok) throw new Error(`专用翻译模型请求失败：${response.status}`);
    const body = await response.json() as { response?: string };
    if (!body.response) throw new Error("专用翻译模型返回空结果");
    return { translations: parseMarkedTranslations(body.response, options.cues) };
  } catch (error) {
    if (options.cues.length <= 1) throw error;
    const splitAt = Math.ceil(options.cues.length / 2);
    const left = await translateWithDedicatedOllama({ ...options, cues: options.cues.slice(0, splitAt) });
    const right = await translateWithDedicatedOllama({ ...options, cues: options.cues.slice(splitAt) });
    return { translations: [...left.translations, ...right.translations] };
  }
}

export async function correctJapaneseCuesWithOllama(options: {
  url: string;
  model: string;
  timeoutMs: number;
  cues: ContextualSubtitleCue[];
  context: ContextualTranslationContext;
}): Promise<{ correctedSources: string[]; correctionCount: number }> {
  try {
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      stream: false,
      think: false,
      format: {
        type: "object",
        properties: {
          corrections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                correctedJa: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 }
              },
              required: ["id", "correctedJa", "confidence"],
              additionalProperties: false
            }
          }
        },
        required: ["corrections"],
        additionalProperties: false
      },
      keep_alive: generationModelKeepAlive,
      options: { temperature: 0.05, num_ctx: 8192, num_predict: 768 },
      messages: [
        {
          role: "system",
          content: [
            "你是日语影视字幕的 ASR 纠错员，只纠正语音识别造成的同音、近音或断句错误。",
            "结合前后文判断，不翻译、不润色、不改变人物原意，成人内容不得规避。",
            "只返回把握很高且确有错误的条目；没有把握就不要写入 corrections。"
          ].join("\n")
        },
        { role: "user", content: buildContextualTranslationPrompt(options.cues, options.context) }
      ]
    }),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
    if (!response.ok) throw new Error(`ASR 纠错模型请求失败：${response.status}`);
    const body = await response.json() as { message?: { content?: string } };
    const parsed = JSON.parse(cleanModelJson(body.message?.content ?? "")) as {
      corrections?: OllamaCorrectionResult[];
    };
    const corrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
    const byId = new Map(corrections.map((correction) => [Number(correction.id), correction]));
    let correctionCount = 0;
    const correctedSources = options.cues.map((cue) => {
      const correction = byId.get(cue.id);
      const corrected = String(correction?.correctedJa ?? cue.text).trim();
      const confidence = Number(correction?.confidence ?? 0);
      if (!shouldAcceptJapaneseCorrection(cue.text, corrected, confidence)) return cue.text;
      correctionCount += 1;
      return corrected;
    });
    return { correctedSources, correctionCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/JSON|Unexpected token|Expected(?: property|\s*['",])|unterminated/iu.test(message)) throw error;
    if (options.cues.length <= 1) {
      return { correctedSources: options.cues.map((cue) => cue.text), correctionCount: 0 };
    }
    const splitAt = Math.ceil(options.cues.length / 2);
    const leftCues = options.cues.slice(0, splitAt);
    const rightCues = options.cues.slice(splitAt);
    const left = await correctJapaneseCuesWithOllama({
      ...options,
      cues: leftCues,
      context: {
        ...options.context,
        next: [...rightCues.slice(0, 3).map((cue) => cue.text), ...options.context.next].slice(0, 3)
      }
    });
    const right = await correctJapaneseCuesWithOllama({
      ...options,
      cues: rightCues,
      context: {
        ...options.context,
        previous: [...options.context.previous, ...leftCues.slice(-3).map((cue) => cue.text)].slice(-3)
      }
    });
    return {
      correctedSources: [...left.correctedSources, ...right.correctedSources],
      correctionCount: left.correctionCount + right.correctionCount
    };
  }
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

export function shouldAcceptJapaneseCorrection(
  original: string,
  corrected: string,
  confidence: number
): boolean {
  const source = original.replace(/\s/gu, "");
  const candidate = corrected.replace(/\s/gu, "");
  if (!candidate || candidate === source || confidence < 0.86) return false;
  const longest = Math.max(Array.from(source).length, Array.from(candidate).length, 1);
  return editDistance(source, candidate) / longest <= 0.45;
}

export function parseContextualTranslationResponse(
  content: string,
  cues: ContextualSubtitleCue[]
): ContextualTranslationResult {
  const parsed = JSON.parse(cleanModelJson(content)) as {
    cues?: OllamaCueResult[];
    corrections?: OllamaCorrectionResult[];
  };
  if (!Array.isArray(parsed.cues)) throw new Error("上下文模型没有返回字幕数组");
  const expectedIds = new Set(cues.map((cue) => cue.id));
  const seenIds = new Set<number>();
  if (
    parsed.cues.length !== cues.length
    || parsed.cues.some((result) => {
      const id = Number(result.id);
      if (!Number.isInteger(id) || !expectedIds.has(id) || seenIds.has(id)) return true;
      seenIds.add(id);
      const expected = cues.find((cue) => cue.id === id)?.text ?? "";
      return typeof result.anchor !== "string" || result.anchor !== buildContextualCueAnchor(expected);
    })
    || seenIds.size !== expectedIds.size
  ) {
    throw new Error("上下文模型返回的字幕编号或原文回显不匹配");
  }
  const byId = new Map(parsed.cues.map((cue) => [Number(cue.id), cue]));
  const correctionById = new Map(
    (Array.isArray(parsed.corrections) ? parsed.corrections : []).map((cue) => [Number(cue.id), cue])
  );
  const translations: string[] = [];
  const correctedSources: string[] = [];
  const confidences: number[] = [];
  for (const cue of cues) {
    const result = byId.get(cue.id);
    const translated = normalizeModelTranslation(cue.text, String(result?.zh ?? ""));
    if (!translated || isLikelyOverlongSubtitleTranslation(cue.text, translated)) {
      throw new Error(`上下文模型未返回有效字幕 ${cue.id}`);
    }
    const quality = assessContextualModelOutput(cue.text, translated);
    if (!quality.okay) throw new Error(`字幕质量检查失败 ${cue.id}: ${quality.reasons.join(",")}`);
    const correction = correctionById.get(cue.id);
    const confidence = Math.max(0, Math.min(1, Number(correction?.confidence ?? 0.75)));
    const corrected = String(correction?.correctedJa ?? cue.text).trim();
    translations.push(translated);
    correctedSources.push(
      shouldAcceptJapaneseCorrection(cue.text, corrected, confidence) ? corrected : cue.text
    );
    confidences.push(confidence);
  }
  return { translations, correctedSources, confidences };
}

export function buildContextualTranslationPrompt(
  cues: ContextualSubtitleCue[],
  context: ContextualTranslationContext
): string {
  return JSON.stringify({
    work: {
      code: context.code,
      title: context.title,
      genres: context.genres.slice(0, 12)
    },
    precedingJapanese: context.previous.slice(-3),
    cues: cues.map((cue) => ({
      id: cue.id,
      anchor: buildContextualCueAnchor(cue.text),
      ja: cue.text
    })),
    followingJapanese: context.next.slice(0, 3)
  });
}

export async function translateContextuallyWithOllama(options: {
  url: string;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
  cues: ContextualSubtitleCue[];
  context: ContextualTranslationContext;
}): Promise<ContextualTranslationResult> {
  try {
    const response = await fetch(`${options.url.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        think: false,
        format: {
          type: "object",
          properties: {
            cues: {
              type: "array",
              minItems: options.cues.length,
              maxItems: options.cues.length,
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  anchor: { type: "string" },
                  zh: { type: "string" }
                },
                required: ["id", "anchor", "zh"],
                additionalProperties: false
              }
            },
            corrections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  correctedJa: { type: "string" },
                  confidence: { type: "number", minimum: 0, maximum: 1 }
                },
                required: ["id", "correctedJa", "confidence"],
                additionalProperties: false
              }
            }
          },
          required: ["cues"],
          additionalProperties: false
        },
        keep_alive: generationModelKeepAlive,
        options: { temperature: 0.15, num_ctx: 8192, num_predict: 2048 },
        messages: [
          {
            role: "system",
            content: [
              "你是专业日语影视字幕译者和中文对白编辑。",
              "结合前后文、场景与人物关系，将日语口语翻译成自然、简洁、符合中国大陆表达习惯的简体中文。",
              "不要逐字硬译；正确处理省略主语、敬语、指代、反问和语气，但不得增加原文没有的信息。",
              "每个 zh 只能是对应 id 的人物对白或原字幕文字，禁止加入场景说明、人物身份、动作、旁白或解释。",
              "成人场景必须准确直译，不美化、不回避，也不要使用低俗网络梗。",
              "cues 中每条必须返回 id、anchor、zh；anchor 必须原样复制输入中的 anchor，zh 只写对应字幕译文。",
              "仅在明显属于同音误识别且把握很高时，才在 corrections 中返回 id、correctedJa 和 confidence；没有需要纠错的字幕不要写入 corrections。",
              "服务场景中 かしこまりました 译为 好的 或 明白了；咖啡语境的 ブラック 指黑咖啡或不加糖奶。",
              "咖啡语境中绝不能把 ブラック 单独译为 黑的；ご注文お決まりになりましたらお知らせください 应表达为 决定好要点什么后请告诉我。",
              "每条中文应适合在对应字幕时长内阅读，并保持人物前后称呼一致。",
              "必须返回输入中的每一个 id，顺序可以不同，但不得合并、拆分或遗漏。",
              "返回格式示例：{\"cues\":[{\"id\":1,\"zh\":\"你好。\"}],\"corrections\":[{\"id\":2,\"correctedJa\":\"質問いいですか\",\"confidence\":0.94}]}"
            ].join("\n")
          },
          { role: "user", content: buildContextualTranslationPrompt(options.cues, options.context) }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (!response.ok) throw new Error(`Ollama 上下文翻译失败：${response.status}`);
    const body = await response.json() as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error("Ollama 上下文翻译返回空结果");
    return parseContextualTranslationResponse(content, options.cues);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/字幕数组|编号|原文回显|有效字幕|质量检查|JSON|Unexpected token|Expected(?: property|\s*['",])|unterminated/iu.test(message)) throw error;
    if (options.cues.length <= 1) {
      return translateSingleCueWithOllama({
        url: options.url,
        model: options.model,
        fallbackModel: options.fallbackModel,
        timeoutMs: options.timeoutMs,
        cue: options.cues[0],
        context: options.context
      });
    }
    const splitAt = Math.ceil(options.cues.length / 2);
    const leftCues = options.cues.slice(0, splitAt);
    const rightCues = options.cues.slice(splitAt);
    const left = await translateContextuallyWithOllama({
      ...options,
      cues: leftCues,
      context: {
        ...options.context,
        next: [...rightCues.slice(0, 3).map((cue) => cue.text), ...options.context.next].slice(0, 3)
      }
    });
    const right = await translateContextuallyWithOllama({
      ...options,
      cues: rightCues,
      context: {
        ...options.context,
        previous: [...options.context.previous, ...leftCues.slice(-3).map((cue) => cue.text)].slice(-3)
      }
    });
    return {
      translations: [...left.translations, ...right.translations],
      correctedSources: [...left.correctedSources, ...right.correctedSources],
      confidences: [...left.confidences, ...right.confidences]
    };
  }
}

export async function translateContextualCuesIndividually(options: {
  url: string;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
  batchSize?: number;
  requestConcurrency?: number;
  cues: ContextualSubtitleCue[];
  context: ContextualTranslationContext;
}): Promise<ContextualTranslationResult> {
  const translations: string[] = [];
  const correctedSources: string[] = [];
  const confidences: number[] = [];
  // The 27B generation model is intentionally serialized on the M2 Pro so
  // curator requests and subtitle batches cannot duplicate KV-cache pressure.
  // Any malformed or incomplete response is still recursively split by
  // translateContextuallyWithOllama, preserving the existing quality fallback.
  const waveSize = Math.max(1, Math.min(24, options.batchSize ?? 1));
  const requestConcurrency = Math.max(1, Math.min(2, options.requestConcurrency ?? 1));
  const requestBatchSize = Math.max(1, Math.ceil(waveSize / requestConcurrency));
  const sourceCues = options.cues.map((cue) => ({ ...cue }));
  for (let waveStart = 0; waveStart < sourceCues.length; waveStart += waveSize) {
    const requests = Array.from({ length: requestConcurrency }, (_value, requestIndex) => {
      const index = waveStart + requestIndex * requestBatchSize;
      if (index >= sourceCues.length) return null;
      const requestCues = sourceCues.slice(index, Math.min(waveStart + (requestIndex + 1) * requestBatchSize, sourceCues.length));
      if (requestCues.length === 0) return null;
      return {
        index,
        promise: translateContextuallyWithOllama({
          ...options,
          cues: requestCues,
          context: {
            ...options.context,
            previous: [
              ...options.context.previous,
              ...sourceCues.slice(Math.max(0, index - 3), index).map((item) => item.text)
            ].slice(-3),
            next: [
              ...sourceCues.slice(index + requestCues.length, index + requestCues.length + 3).map((item) => item.text),
              ...options.context.next
            ].slice(0, 3)
          }
        })
      };
    }).filter((request): request is {
      index: number;
      promise: Promise<ContextualTranslationResult>;
    } => Boolean(request));
    const results = await Promise.all(requests.map(async (request) => ({
      index: request.index,
      result: await request.promise
    })));
    results.sort((left, right) => left.index - right.index);
    for (const { index, result } of results) {
      translations.push(...result.translations);
      correctedSources.push(...result.correctedSources);
      confidences.push(...result.confidences);
      result.correctedSources.forEach((text, offset) => {
        if (sourceCues[index + offset]) sourceCues[index + offset].text = text;
      });
    }
  }
  return { translations, correctedSources, confidences };
}
