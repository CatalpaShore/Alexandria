import type { AgentCitation, AgentMessage, AgentPresentation } from "../../features/agent/api";

export type AgentFollowUpContext = {
  history?: AgentMessage[];
  previousUserMessage?: string;
};

type RankedValue = { value: string; count: number; firstIndex: number };

const genericSubjects = new Set(["影片", "作品", "片子", "片单", "推荐", "相关", "相似", "好看", "馆藏"]);
const genericGenres = new Set(["高清", "高画质", "单体作品", "独家配信", "样片", "数字马赛克", "4K", "HD"]);

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rankedValues(values: Array<string | undefined>, excluded: string[] = []): RankedValue[] {
  const excludedKeys = new Set(excluded.map((value) => cleanText(value).normalize("NFKC").toLocaleLowerCase("ja")));
  const counts = new Map<string, RankedValue>();
  values.forEach((raw, index) => {
    const value = cleanText(raw ?? "");
    const key = value.normalize("NFKC").toLocaleLowerCase("ja");
    if (!value || excludedKeys.has(key)) return;
    const current = counts.get(key);
    counts.set(key, current ? { ...current, count: current.count + 1 } : { value, count: 1, firstIndex: index });
  });
  return [...counts.values()].sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex);
}

function uniqueQuestions(items: Array<string | undefined>, previousQuestion: string): string[] {
  const previous = cleanText(previousQuestion).normalize("NFKC").replace(/[？?。！!，,；;：:@“”"'`*\s]/g, "").toLocaleLowerCase("zh-CN");
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const value = cleanText(item ?? "");
    if (!value || value.length > 88) return [];
    const key = value.normalize("NFKC").replace(/[？?。！!，,；;：:@“”"'`*\s]/g, "").toLocaleLowerCase("zh-CN");
    if (!key || key === previous || seen.has(key)) return [];
    seen.add(key);
    return [value];
  }).slice(0, 3);
}

function conversationQuestion(context: AgentFollowUpContext): string {
  const userMessages = (context.history ?? [])
    .filter((item) => item.role === "user" && item.content.trim())
    .map((item) => cleanText(item.content));
  const latest = cleanText(context.previousUserMessage ?? userMessages.at(-1) ?? "");
  if (!latest) return "";
  if (!/继续完成上一条|针对馆长的问题|我的选择是/u.test(latest)) return latest;
  const original = [...userMessages].reverse().find((item) => item !== latest && !/继续完成上一条|我的选择是/u.test(item));
  return original ? `${original}\n${latest}` : latest;
}

function userChoice(question: string): string {
  return cleanText(question.match(/我的选择是[“"]([^”"]+)[”"]/u)?.[1] ?? "");
}

function cleanSubject(value: string): string {
  const cleaned = cleanText(value)
    .replace(/^(?:几|一些|一批|多部|几部|找|推荐|看看|关于|围绕|针对|只看)+/u, "")
    .replace(/(?:且|并且)?(?:未观看|没看过|还没看|收藏|最近|近期|相关|相似)$/u, "")
    .replace(/[“”"'《》]/g, "")
    .trim();
  return cleaned.length <= 24 && !genericSubjects.has(cleaned) ? cleaned : "";
}

function inferSubject(question: string, message: AgentMessage, presentations: AgentPresentation[]): string {
  const query = question.replace(/\/(?:找片|推荐|比较|统计|搜索)\s*/gu, "");
  const quoted = [...query.matchAll(/[“"]([^”"\n]{1,24})[”"]/gu)]
    .map((match) => cleanSubject(match[1]))
    .find((value) => value && !/馆长的问题|我的选择/u.test(value));
  if (quoted) return quoted;
  const mentioned = cleanSubject(query.match(/@([^@\s，。！？?\n]{1,24})/u)?.[1] ?? "");
  if (mentioned) return mentioned;
  const requested = cleanSubject(query.match(/(?:推荐|找|筛选)(?:给我)?(?:几|[一二两三四五六七八九十\d]+)?(?:部|个)?\s*([^，。！？?\n]{1,24}?)(?:影片|作品|片子|片单)/u)?.[1] ?? "");
  if (requested) return requested;
  const performerTheme = cleanSubject(
    query.match(/(?:拍|包含|带有|主打)\s*([^，。！？?\n]{1,16}?)(?:的)?(?:女优|女優|演员|演員|素材|题材|題材|内容)/u)?.[1] ?? ""
  );
  if (performerTheme) return performerTheme;
  const stateEntity = message.state?.entities.find((item) => question.includes(item.label))?.label;
  if (stateEntity) return cleanSubject(stateEntity);
  const titled = presentations.map((item) => "title" in item ? cleanSubject(item.title.replace(/推荐影片|近期作品|演员排行|馆藏排行|推荐/u, "")) : "")
    .find(Boolean);
  if (titled) return titled;
  return rankedValues(message.citations.flatMap((item) => item.genres), [...genericGenres])[0]?.value ?? "";
}

function selectedCitations(message: AgentMessage, media?: Extract<AgentPresentation, { kind: "media-cards" }>): AgentCitation[] {
  if (!media) return message.citations.slice(0, 8);
  return media.citationNumbers
    .map((number) => message.citations[number - 1])
    .filter((item): item is AgentCitation => Boolean(item));
}

function nextScope(question: string): string {
  if (!/(没看|未看|还没(?:有)?看|从未看)/u.test(question)) return "只保留还没看过的作品";
  if (!/收藏/u.test(question)) return "优先看收藏中的作品";
  if (!/最近|近期|新作|发行/u.test(question)) return "按发行日期从新到旧排列";
  return "换一批不重复的候选";
}

function requestedMediaCount(question: string, fallback = 4): number {
  const numeric = question.match(/(\d{1,2})\s*部/u)?.[1];
  if (numeric) return Math.min(8, Math.max(1, Number(numeric)));
  const chinese = question.match(/([一二两三四五六七八])\s*部/u)?.[1];
  return chinese ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 } as Record<string, number>)[chinese] : fallback;
}

function alternativeDimension(type?: string): string {
  return ({ actor: "题材", genre: "厂商", maker: "厂牌", label: "演员", series: "演员", director: "系列", prefix: "题材" } as Record<string, string>)[type ?? ""] ?? "厂商";
}

function answerAnchors(message: AgentMessage): string[] {
  return rankedValues([
    ...[...message.content.matchAll(/\*\*([^*\n]{2,30})\*\*/gu)].map((match) => match[1]),
    ...[...message.content.matchAll(/[“"]([^”"\n]{2,30})[”"]/gu)].map((match) => match[1])
  ]).map((item) => item.value).filter((item) => !/推荐影片|本地馆藏|证据/u.test(item));
}

export function buildAgentFollowUps(message: AgentMessage, context: AgentFollowUpContext = {}): string[] {
  if (message.role !== "assistant" || message.status !== "completed") return [];
  const presentations = message.presentations?.length ? message.presentations : message.presentation ? [message.presentation] : [];
  const media = presentations.find((item): item is Extract<AgentPresentation, { kind: "media-cards" }> => item.kind === "media-cards");
  const comparison = presentations.find((item): item is Extract<AgentPresentation, { kind: "comparison-matrix" }> => item.kind === "comparison-matrix");
  const distribution = presentations.find((item): item is Extract<AgentPresentation, { kind: "distribution-summary" }> => item.kind === "distribution-summary");
  const ranking = presentations.find((item): item is Extract<AgentPresentation, { kind: "entity-ranking" }> => item.kind === "entity-ranking");
  const entityCards = presentations.find((item): item is Extract<AgentPresentation, { kind: "entity-cards" }> => item.kind === "entity-cards");
  const entityProfile = presentations.find((item): item is Extract<AgentPresentation, { kind: "entity-profile-card" }> => item.kind === "entity-profile-card");
  const clarification = presentations.find((item) => item.kind === "clarification-question");
  const action = presentations.find((item): item is Extract<AgentPresentation, { kind: "action-confirmation" }> => item.kind === "action-confirmation");
  if (clarification) return [];

  const question = conversationQuestion(context);
  const choice = userChoice(question);
  const subject = inferSubject(question, message, presentations);
  const subjectLabel = subject || choice || "刚才的条件";
  const mediaCount = requestedMediaCount(question);
  const citations = selectedCitations(message, media);
  const codes = citations.map((item) => item.code).filter(Boolean);
  const actors = rankedValues(citations.flatMap((item) => item.actors)).map((item) => item.value);
  const genres = rankedValues(citations.flatMap((item) => item.genres), [...genericGenres, subject]).map((item) => item.value);
  const series = rankedValues(citations.map((item) => item.series)).map((item) => item.value);
  const makers = rankedValues(citations.map((item) => item.maker)).map((item) => item.value);
  const labels = rankedValues(citations.map((item) => item.label)).map((item) => item.value);

  if (action) {
    if (action.status !== "completed") return [];
    return uniqueQuestions([
      "查看刚刚创建的片单",
      codes.length >= 2 ? `比较片单里的 ${codes[0]} 和 ${codes[1]}，哪部更符合“${subjectLabel}”？` : undefined,
      `再补一部符合“${subjectLabel}”且不与片单重复的作品`
    ], question);
  }

  if (entityCards) {
    const [first, second, third] = entityCards.items;
    const sharedTopic = cleanSubject(subject || first?.highlights.find((item) => !genericGenres.has(item)) || subjectLabel);
    return uniqueQuestions([
      first && second ? `比较 @${first.label} 和 @${second.label} 的馆藏量、代表题材与近期作品` : first ? `@${first.label} 为什么最贴近“${subjectLabel}”？` : undefined,
      first ? `推荐${mediaCount}部 @${first.label} 中${sharedTopic ? `“${sharedTopic}”路线、` : ""}还没看过的作品` : undefined,
      third ? `@${third.label} 与“${subjectLabel}”的关联点是什么？` : first ? `查看 @${first.label} 的公开资料和代表作品` : undefined
    ], question);
  }

  if (comparison) {
    const comparisonCodes = comparison.columns.map((item) => item.code);
    const askedFields = ["演员", "题材", "系列", "厂商", "厂牌", "导演", "发行时间", "时长"].filter((field) => question.includes(field));
    const missingFields = ["厂商", "厂牌", "发行时间", "时长", "导演"].filter((field) => !askedFields.includes(field)).slice(0, 3);
    return uniqueQuestions([
      comparisonCodes.length >= 2 && missingFields.length ? `补充比较 ${comparisonCodes[0]} 和 ${comparisonCodes[1]} 的${missingFields.join("、")}` : undefined,
      comparisonCodes.length >= 2 ? `如果只按“${subjectLabel}”和我的近期偏好，${comparisonCodes[0]} 与 ${comparisonCodes[1]} 谁更优先？` : undefined,
      genres[0] ? `再找一部同样包含“${genres[0]}”、但演员不同的作品加入对比` : "再找一部相近作品，扩展成三片对比"
    ], question);
  }

  if (distribution) {
    const [first, second] = distribution.rows;
    const dimension = alternativeDimension(first?.type);
    return uniqueQuestions([
      first ? `推荐${mediaCount}部“${first.label}”中还没看过的代表作品` : undefined,
      first && second ? `“${first.label}”与“${second.label}”的常见演员和厂牌有什么不同？` : undefined,
      `在同一范围内，作品最多的${dimension}前5名是谁？`
    ], question);
  }

  if (ranking) {
    const [first, second] = ranking.rows;
    const profileMetric = /身高|出生|年轻|年长|胸围|罩杯|三围|资料完整度|资料缺口|缺少/u.test(ranking.title);
    const thirdQuestion = /身高|胸围|罩杯|三围/u.test(ranking.title)
      ? "这些演员里，哪些人的生日、图片和简介也比较完整？"
      : /出生|年轻|年长/u.test(ranking.title)
        ? "这些演员中，哪些人的馆藏作品最多？"
        : /母公司/u.test(ranking.title)
          ? "这些机构中，哪些还具备官网、总部和成立时间资料？"
          : /成立|创立|历史/u.test(ranking.title)
            ? "这些机构中，哪些同时具有母公司和官方网站资料？"
            : first?.type === "label" && /旗下|所属/u.test(ranking.title)
              ? "这些厂牌的馆藏量、官网与所属关系完整度如何？"
        : `同一范围改按${alternativeDimension(first?.type)}统计，前5名是谁？`;
    return uniqueQuestions([
      first && second ? `比较 @${first.label} 和 @${second.label} 的${profileMetric ? "公开资料、馆藏量与代表作品" : "馆藏覆盖、常见题材与近期作品"}` : first ? `查看 @${first.label} 的资料和代表作品` : undefined,
      first ? `推荐${mediaCount}部 @${first.label} 中${subject && question.includes(subject) && !/排行|排名|资料/u.test(subject) ? `符合“${subject}”且` : ""}还没看过的作品` : undefined,
      thirdQuestion
    ], question);
  }

  if (entityProfile) {
    const dimension = entityProfile.type === "actor" ? "题材" : entityProfile.type === "maker" ? "厂牌" : "演员";
    return uniqueQuestions([
      `@${entityProfile.label} 的哪些馆藏作品最能代表“${subjectLabel}”？`,
      `推荐${mediaCount}部 @${entityProfile.label} 中还没看过的近期作品`,
      `与 @${entityProfile.label} 关联最多的${dimension}有哪些？`
    ], question);
  }

  if (media || citations.length) {
    if (media && /身高|出生|胸围|胸圍|罩杯|[A-K]{1,2}\s*杯/iu.test(media.title)) {
      const profileConditions = [
        /身高/u.test(question) ? "身高" : "",
        /出生|年龄|年后|年以前/u.test(question) ? "出生年份" : "",
        /胸围|胸圍/u.test(question) ? "胸围" : "",
        /罩杯|[A-K]{1,2}\s*杯/iu.test(question) ? "罩杯" : ""
      ].filter(Boolean);
      return uniqueQuestions([
        actors[0] ? `@${actors[0]} 的哪些公开资料满足刚才的筛选条件？` : "排名靠前的演员分别满足了哪些筛选条件？",
        `保留刚才的${profileConditions.join("、") || "演员资料"}条件，再换${mediaCount}部未观看作品`,
        "这些匹配演员中，哪些人的三围、图片和简介也比较完整？"
      ], question);
    }
    const route = genres[0] || series[0] || subject;
    const entity = actors[0] || makers[0] || labels[0];
    const exploresNew = /探索|新题材|换个方向|不同/u.test(choice);
    return uniqueQuestions([
      codes.length >= 2
        ? `比较 ${codes[0]} 和 ${codes[1]}：哪部更符合“${subjectLabel}”，关键差异是什么？`
        : codes[0] ? `${codes[0]} 与“${subjectLabel}”直接匹配的馆藏依据有哪些？` : undefined,
      exploresNew
        ? `再推荐${mediaCount}部与“${subjectLabel}”相邻、但题材组合不同的未观看作品`
        : `再推荐${mediaCount}部${route ? `“${route}”路线的` : "同类"}作品，${nextScope(question)}，并排除刚才这些番号`,
      entity ? `@${entity} 在“${route || subjectLabel}”方向下还有哪些未观看作品？` : genres[1] ? `刚才结果里，哪部最能代表“${genres[1]}”路线？` : undefined
    ], question);
  }

  const anchors = answerAnchors(message);
  if (/偏好|口味|最近观看|观影记录/u.test(question)) {
    return uniqueQuestions([
      "刚才识别出的偏好里，哪些来自近期观看，哪些来自收藏？",
      `按这些偏好推荐${mediaCount}部还没看过的作品${anchors[0] ? `，优先考虑“${anchors[0]}”` : ""}`,
      `如果想探索新方向，和“${subjectLabel}”最接近的相邻题材是什么？`
    ], question);
  }
  if (/索引|元数据|资料|完整|缺失/u.test(question)) {
    return uniqueQuestions([
      `刚才结论里，影响“${subjectLabel}”判断的关键字段有哪些？`,
      "按演员、厂商和厂牌拆开看，哪一类资料最需要补全？",
      "这些缺失会影响哪些检索、统计或推荐结果？"
    ], question);
  }
  return uniqueQuestions([
    anchors[0] ? `刚才关于“${anchors[0]}”的结论，最关键的馆藏依据是什么？` : `刚才关于“${subjectLabel}”的结论，最关键的馆藏依据是什么？`,
    `把“${subjectLabel}”限定为未观看作品，结果会怎样变化？`,
    `基于刚才的结论，推荐${mediaCount}部具体馆藏作品`
  ], question);
}
