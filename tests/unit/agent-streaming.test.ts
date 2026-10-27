import { describe, expect, it, vi } from "vitest";
import {
  consumeAgentNdjsonStream,
  consumeAgentNdjsonText,
  getAgentRegenerationMentions,
  normalizeAgentRegenerationMessageId as normalizeClientRegenerationMessageId,
  sendAgentMessageStream,
  type AgentStreamEvent
} from "../../client/src/features/agent/api";
import { createClientUuid } from "../../client/src/lib/clientId";
import {
  buildAgentPresentation,
  agentAnswersEquivalent,
  candidateMatchesAgentContextEntities,
  compactAgentHistoryForModel,
  consumeAgentModelStream,
  describeAgentIntent,
  describeAgentReasoning,
  ensureAgentAnswerVariation,
  extractAgentSearchTerms,
  finalizeAgentAnswer,
  normalizeAgentAnswerReferences,
  parseAgentClarificationResponse,
  queryMayNeedAgentClarification,
  queryRequestsLibraryAnalytics,
  queryRequestsRecommendation,
  queryUsesPriorRecommendationContext,
  queryRequestsUnwatched,
  rankAgentCandidatesByUserModel,
  sampleAgentRecommendationCandidates,
  selectBoundedPreferenceSignals,
  streamAgentAnswer
} from "../../server/src/agentRag.js";
import { extractAgentQueryPreferenceSignals } from "../../server/src/agentFeatures.js";
import { expandAgentGenreConcepts } from "../../server/src/agentTaxonomy.js";
import type { AgentCitation } from "../../server/src/agentRag.js";
import {
  getAgentRegenerationContext,
  hydrateAgentThreadPresentations,
  normalizeAgentRegenerationMessageId as normalizeServerRegenerationMessageId
} from "../../server/src/agentRoutes.js";
import { createTurnState, extractMentionedCodes } from "../../server/src/agentTools.js";

function citation(overrides: Partial<AgentCitation> & Pick<AgentCitation, "mediaId" | "code">): AgentCitation {
  return {
    title: overrides.code,
    summary: "",
    actors: [],
    genres: [],
    series: "",
    favorite: false,
    completed: false,
    lastPlayedAt: "",
    score: 1,
    ...overrides
  };
}

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
}

describe("Agent streaming protocol", () => {
  it("creates request IDs when randomUUID is unavailable in an HTTP Android WebView", () => {
    const values = Array.from({ length: 16 }, (_, index) => index);
    const id = createClientUuid({
      getRandomValues: (target) => {
        target.set(values);
        return target;
      }
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("retries a pre-acceptance optimistic message without sending it as a regeneration UUID", () => {
    const persistedId = "123e4567-e89b-42d3-a456-426614174000";
    const optimisticId = `optimistic-assistant-${persistedId}`;

    expect(normalizeClientRegenerationMessageId(persistedId)).toBe(persistedId);
    expect(normalizeClientRegenerationMessageId(optimisticId)).toBeUndefined();
    expect(normalizeServerRegenerationMessageId(optimisticId)).toBeUndefined();
    expect(normalizeServerRegenerationMessageId("not-a-message-id")).toBe("not-a-message-id");
  });

  it("omits a client-only optimistic regeneration id at the streaming request boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await sendAgentMessageStream("thread-id", "重试上一条问题", {
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        regenerateFromMessageId: "optimistic-assistant-123e4567-e89b-42d3-a456-426614174000",
        onEvent: vi.fn()
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).not.toHaveProperty("regenerateFromMessageId");
  });

  it("extracts concrete media codes for deterministic tool routing", () => {
    expect(extractMentionedCodes("比较 aarm 199、AARM-222 和 OFJE_201")).toEqual(["AARM-199", "AARM-222", "OFJE-201"]);
  });

  it("preserves media slots across action follow-ups", () => {
    const previous = createTurnState({
      intent: "recommend",
      citations: [citation({ mediaId: "one", code: "AARM-199" }), citation({ mediaId: "two", code: "AARM-222" })]
    });
    const next = createTurnState({ intent: "action", previous });
    expect(next.mediaSlots.map((item) => item.mediaId)).toEqual(["one", "two"]);
    expect(next.intent).toBe("action");
  });

  it("recognizes common Chinese expressions for unwatched media", () => {
    expect(queryRequestsUnwatched("推荐我收藏但还没有观看的作品")).toBe(true);
    expect(queryRequestsUnwatched("找几部还没看的片")).toBe(true);
    expect(queryRequestsUnwatched("最近观看过什么")).toBe(false);
  });

  it("expands high-level heavy-content language into concrete local genre evidence", () => {
    const expanded = expandAgentGenreConcepts("推荐6部 R-18G 重口作品");
    expect(expanded).toEqual(expect.arrayContaining(["SM", "BDSM", "拘束", "凌辱", "肛交", "灌肠"]));
    expect(new Set(expanded).size).toBe(expanded.length);
  });

  it("learns interest-bearing query topics without treating informational questions as preferences", () => {
    expect(extractAgentQueryPreferenceSignals("/找片 推荐几部SM影片", [{type:"genre",value:"SM",label:"SM"}])).toEqual([
      { dimension: "genre", value: "SM", weight: 0.36 }
    ]);
    expect(extractAgentQueryPreferenceSignals("挑几部他们的重口作品给我")).toContainEqual(
      { dimension: "genre", value: "重口", weight: 0.36 }
    );
    expect(extractAgentQueryPreferenceSignals("SM 标签一共有多少部")).toEqual([]);
  });

  it("matches prior-turn entities with OR semantics inside the same dimension", () => {
    const item = citation({ mediaId: "one", code: "SM-001", actors: ["演员乙"], genres: ["SM"] });
    expect(candidateMatchesAgentContextEntities(item, [
      { type: "actor", value: "演员甲" },
      { type: "actor", value: "演员乙" }
    ])).toBe(true);
    expect(candidateMatchesAgentContextEntities(item, [
      { type: "actor", value: "actor-b", label: "演员乙" }
    ])).toBe(true);
    expect(candidateMatchesAgentContextEntities(item, [
      { type: "actor", value: "演员甲" },
      { type: "genre", value: "拘束" }
    ])).toBe(false);
  });

  it("recognizes natural pick-some wording as a recommendation request", () => {
    expect(queryRequestsRecommendation("挑几部他们的重口作品给我")).toBe(true);
    expect(queryRequestsRecommendation("挑幾部未觀看作品")).toBe(true);
    expect(queryRequestsRecommendation("不要推荐，只做统计")).toBe(false);
  });

  it("extracts recommendation subjects without command and composer boilerplate", () => {
    expect(extractAgentSearchTerms("/找片 推荐几部SM影片\n\n用户已通过命令明确指定任务：找片")).toEqual(["SM"]);
    expect(extractAgentSearchTerms("推荐一些深喉影片")).toEqual(["深喉"]);
    expect(queryUsesPriorRecommendationContext("再推荐几部相似作品")).toBe(true);
    expect(queryUsesPriorRecommendationContext("推荐几部SM影片")).toBe(false);
  });

  it("excludes every prior recommendation citation even when the old answer has no cards", () => {
    const previousCitations = [
      citation({ mediaId: "old-one", code: "OLD-001" }),
      citation({ mediaId: "old-two", code: "OLD-002" })
    ];
    const regeneration = getAgentRegenerationContext([
      { id: "user", role: "user", content: "推荐两部SM影片" },
      {
        id: "assistant",
        role: "assistant",
        content: "## 推荐影片\n\n- **OLD-001 [1]**\n- **OLD-002 [2]**",
        citations: previousCitations,
        presentations: []
      },
      { id: "later", role: "user", content: "另一条消息" }
    ], "assistant");

    expect(regeneration.excludeMediaIds).toEqual(["old-one", "old-two"]);
    expect(regeneration.previousAnswer).toContain("OLD-001");
    expect(regeneration.history.map((item) => item.id)).toEqual(["later"]);
    expect(regeneration.variationSeed).toBeTypeOf("number");
  });

  it("accumulates prior batches for the same query so regeneration cannot cycle straight back", () => {
    const first = citation({ mediaId: "first-media", code: "FIRST-001" });
    const second = citation({ mediaId: "second-media", code: "SECOND-002" });
    const regeneration = getAgentRegenerationContext([
      { id: "user-1", role: "user", content: "推荐两部SM影片" },
      {
        id: "assistant-1", role: "assistant", content: "## 推荐影片\n\n**FIRST-001 [1]**",
        citations: [first],
        presentations: [
          { kind: "media-cards", title: "第一批", citationNumbers: [1] },
          { kind: "entity-cards", title: "演员", subtitle: "第一批", items: [{
            type: "actor", value: "actor-one", label: "演员一", mediaCount: 3, reason: "第一批", highlights: []
          }] }
        ]
      },
      { id: "user-2", role: "user", content: "推荐两部SM影片" },
      {
        id: "assistant-2", role: "assistant", content: "## 推荐影片\n\n**SECOND-002 [1]**",
        citations: [second],
        presentations: [
          { kind: "media-cards", title: "第二批", citationNumbers: [1] },
          { kind: "entity-cards", title: "演员", subtitle: "第二批", items: [{
            type: "actor", value: "actor-two", label: "演员二", mediaCount: 4, reason: "第二批", highlights: []
          }] }
        ]
      }
    ], "assistant-2");

    expect(new Set(regeneration.excludeMediaIds)).toEqual(new Set(["first-media", "second-media"]));
    expect(new Set(regeneration.excludeEntityValues)).toEqual(new Set(["actor-one", "actor-two"]));
  });

  it("preserves structured entity context when retrying an answer", () => {
    expect(getAgentRegenerationMentions({
      id: "assistant",
      role: "assistant",
      content: "",
      citations: [],
      presentation: null,
      presentations: [],
      state: {
        version: 1,
        intent: "recommend",
        constraints: { include: {}, exclude: {} },
        mediaSlots: [],
        entities: [
          { type: "maker", value: "SOD Create", label: "SOD Create" },
          { type: "maker", value: "SOD Create", label: "重复值" },
          { type: "unsupported", value: "ignored", label: "忽略" }
        ],
        sort: null,
        sourceContext: null,
        lastToolResultId: null
      },
      stateVersion: 1,
      trace: [],
      status: "completed",
      error: null,
      createdAt: "2026-08-21T00:00:00.000Z"
    })).toEqual([{ type: "maker", value: "SOD Create", label: "SOD Create" }]);
  });

  it("treats formatting-only copies as the same regenerated answer", () => {
    expect(agentAnswersEquivalent("第一段\r\n\r\n第二段", "第一段\n\n\n第二段")).toBe(true);
    expect(agentAnswersEquivalent("第一版", "第二版")).toBe(false);
  });

  it("guarantees a visibly distinct fallback when two model attempts are still identical", () => {
    const answer = ensureAgentAnswerVariation("完全相同的回答", "完全相同的回答", 123);
    expect(agentAnswersEquivalent("完全相同的回答", answer)).toBe(false);
    expect(answer).toContain("重新生成");
    expect(ensureAgentAnswerVariation("第一版", "第二版", 123)).toBe("第二版");
  });

  it("uses seeded weighted sampling inside a bounded relevance pool", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => citation({
      mediaId: `media-${index}`,
      code: `TEST-${String(index).padStart(3, "0")}`,
      score: 1 - index * 0.015
    }));
    const first = sampleAgentRecommendationCandidates(candidates, 6, 101).map((item) => item.mediaId);
    const repeatedSeed = sampleAgentRecommendationCandidates(candidates, 6, 101).map((item) => item.mediaId);
    const second = sampleAgentRecommendationCandidates(candidates, 6, 202).map((item) => item.mediaId);

    expect(repeatedSeed).toEqual(first);
    expect(second).not.toEqual(first);
    expect(new Set(first).size).toBe(6);
    expect(first.every((mediaId) => Number(mediaId.split("-")[1]) < 24)).toBe(true);
  });

  it("builds a readable intent and decision summary without raw model thinking", () => {
    const query = "比较 AARM-199 和 AARM-222，重点说明演员、题材和系列差异";
    expect(describeAgentIntent(query)).toBe("识别为“作品比较”；目标作品：AARM-199、AARM-222");
    expect(describeAgentReasoning(query, [])).toContain("逐项核对演员、题材、系列");
    expect(describeAgentReasoning("从收藏里推荐三部还没看的作品", [])).toContain("先应用收藏、未观看条件");
    expect(describeAgentReasoning("比较厂商、厂牌、导演、发行年份和时长", [])).toContain("厂商、厂牌、导演、发行日期、时长");
  });

  it("limits model clarification review to explicit or genuinely vague requests", () => {
    expect(queryMayNeedAgentClarification("先问我一个问题，再帮我推荐")).toBe(true);
    expect(queryMayNeedAgentClarification("帮我推荐点好看的")).toBe(true);
    expect(queryMayNeedAgentClarification("推荐四部收藏且未观看的作品")).toBe(false);
    expect(queryMayNeedAgentClarification("继续完成上一条请求。我的选择是探索新题材。")).toBe(false);
  });

  it("parses a bounded clarification card and rejects malformed model output", () => {
    expect(parseAgentClarificationResponse(JSON.stringify({
      ask: true,
      title: "先确认观看方向",
      question: "今晚更想看熟悉题材还是探索新内容？",
      why: "这个选择会改变候选排序。",
      options: [
        { label: "贴近最近偏好", description: "优先相似演员与题材" },
        { label: "探索新题材", description: "降低与近期记录的重复度" }
      ],
      allowCustom: true
    }))).toMatchObject({
      kind: "clarification-question",
      question: "今晚更想看熟悉题材还是探索新内容？",
      options: [{ id: "option-1", label: "贴近最近偏好" }, { id: "option-2", label: "探索新题材" }]
    });
    expect(parseAgentClarificationResponse('{"ask":true,"question":"缺少选项","options":[]}')).toBeNull();
    expect(parseAgentClarificationResponse('{"ask":false}')).toBeNull();
  });

  it("routes ranking questions to full-library analytics and builds an entity ranking", () => {
    const query = "哪些演员拥有最多的“深喉标签”";
    expect(queryRequestsLibraryAnalytics(query)).toBe(true);
    expect(describeAgentIntent(query)).toBe("识别为“全库统计”");
    expect(describeAgentReasoning(query, [])).toContain("数据库按作品去重后聚合统计");
    expect(buildAgentPresentation(query, "月野江翠最多。", [], [], {
      kind: "actor-genre-ranking",
      subject: "深喉",
      totalTaggedWorks: 1452,
      worksWithActors: 1150,
      distinctActors: 770,
      rows: [
        { rank: 1, value: "月乃ルナ", label: "月野江翠", count: 27 },
        { rank: 2, value: "日泉舞香", label: "日泉舞香", count: 22 }
      ]
    })).toEqual({
      kind: "entity-ranking",
      title: "“深喉”演员排行",
      metricLabel: "部作品",
      rows: [
        { rank: 1, type: "actor", value: "月乃ルナ", label: "月野江翠", count: 27 },
        { rank: 2, type: "actor", value: "日泉舞香", label: "日泉舞香", count: 22 }
      ]
    });
  });

  it("builds recommendation cards only from valid, selected, fresh citations", () => {
    const citations = [
      citation({ mediaId: "history", code: "OLD-001", lastPlayedAt: "2026-07-27" }),
      citation({ mediaId: "fresh-1", code: "NEW-001" }),
      citation({ mediaId: "fresh-2", code: "NEW-002", favorite: true }),
      citation({ mediaId: "fresh-extra", code: "NEW-003" })
    ];
    expect(buildAgentPresentation(
      "根据我最近的观影记录推荐影片",
      "近期偏好来自 [1]，另有候选 [4]。\n\n## 推荐影片\n- NEW-002 [3]\n- NEW-001 [2]\n- 仍然推荐 [3]\n- 忽略 [99]。",
      citations,
      [1, 2, 3, 4]
    )).toEqual({
      kind: "media-cards",
      title: "根据近期观影推荐",
      citationNumbers: [3, 2],
      layout: "gallery",
      showMotionPreview: true
    });
  });

  it("recovers cards from cited recommendations whose heading is not the canonical title", () => {
    const citations = Array.from({ length: 8 }, (_, index) => citation({
      mediaId: `media-${index + 1}`,
      code: `HEAVY-00${index + 1}`
    }));
    const thread = hydrateAgentThreadPresentations({
      id: "thread",
      messages: [
        { id: "user", role: "user", content: "挑几部他们的重口作品给我" },
        {
          id: "assistant",
          role: "assistant",
          status: "completed",
          content: "### 馆藏重口/硬核向精选推荐\n\n- HEAVY-001 [1]\n- HEAVY-002 [2]\n- HEAVY-003 [3]\n- HEAVY-005 [5]\n- HEAVY-007 [7]\n- HEAVY-008 [8]",
          citations,
          presentation: null,
          presentations: []
        }
      ]
    });

    expect(thread.messages?.[1]?.presentations).toEqual([{
      kind: "media-cards",
      title: "推荐影片",
      citationNumbers: [1, 2, 3, 5, 7, 8],
      layout: "compact",
      showMotionPreview: true
    }]);
  });

  it("selects a scene-specific movie card layout while keeping GIF previews optional", () => {
    const citations = Array.from({ length: 6 }, (_, index) => citation({
      mediaId: `media-${index + 1}`,
      code: `NEW-00${index + 1}`
    }));
    expect(buildAgentPresentation(
      "推荐一部影片",
      "## 推荐影片\n- NEW-001 [1]",
      citations,
      [1]
    )).toMatchObject({ layout: "spotlight", showMotionPreview: true });
    expect(buildAgentPresentation(
      "推荐六部影片",
      `## 推荐影片\n${citations.map((item, index) => `- ${item.code} [${index + 1}]`).join("\n")}`,
      citations,
      [1, 2, 3, 4, 5, 6]
    )).toMatchObject({ layout: "compact", citationNumbers: [1, 2, 3, 4, 5, 6] });
  });

  it("does not invent recommendation cards without explicit selected citations", () => {
    const citations = [citation({ mediaId: "fresh", code: "NEW-001" })];
    expect(buildAgentPresentation("推荐一部影片", "暂时没有足够依据。", citations, [1])).toBeNull();
    expect(buildAgentPresentation("比较这两部影片", "对比 [1]", citations, [1])).toBeNull();
  });

  it("normalizes vague citation placeholders to concrete media codes", () => {
    const citations = [
      citation({ mediaId: "one", code: "AARM-199" }),
      citation({ mediaId: "two", code: "OFJE-201" })
    ];
    expect(normalizeAgentAnswerReferences(
      "## 推荐影片\n- **番号 [2]** — 理由\n近期偏好来自 [1]\n- OFJE-201 [2]\n```\n作品 [1]\n```",
      citations
    )).toBe(
      "## 推荐影片\n- **OFJE-201 [2]** — 理由\n近期偏好来自 AARM-199 [1]\n- OFJE-201 [2]\n```\n作品 [1]\n```"
    );
  });

  it("uses bounded preference signals as soft candidate ranking", () => {
    const candidates = [
      citation({ mediaId: "plain", code: "PLAIN-001", score: 1, genres: ["剧情"] }),
      citation({ mediaId: "preferred", code: "PREF-001", score: 0.98, genres: ["SM", "拘束"] })
    ];
    const ranked = rankAgentCandidatesByUserModel(candidates, {
      signals: [{ dimension: "genre", value: "SM", weight: 0.9, confidence: 0.8, source: "feedback" }]
    });
    expect(ranked.map((item) => item.code)).toEqual(["PREF-001", "PLAIN-001"]);
    expect(candidates[1].score).toBe(0.98);
  });

  it("can personalize with maker, label and director metadata", () => {
    const candidates = [
      citation({ mediaId: "plain", code: "PLAIN-001", score: 1, maker: "Studio A" }),
      citation({ mediaId: "rich", code: "RICH-001", score: 0.96, maker: "SOD Create", label: "SODSTAR", director: "小松十七" })
    ];
    const ranked = rankAgentCandidatesByUserModel(candidates, {
      signals: [
        { dimension: "maker", value: "SOD Create", weight: 0.8, confidence: 0.8, source: "watch_history" },
        { dimension: "label", value: "SODSTAR", weight: 0.7, confidence: 0.8, source: "favorite" },
        { dimension: "director", value: "小松十七", weight: 0.6, confidence: 0.8, source: "feedback" }
      ]
    });
    expect(ranked.map((item) => item.code)).toEqual(["RICH-001", "PLAIN-001"]);
  });

  it("compacts conversation history to six bounded recent messages", () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: (index % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `${index}:${"很长的内容".repeat(500)}`
    }));
    const compacted = compactAgentHistoryForModel(history);
    expect(compacted).toHaveLength(6);
    expect(compacted[0].content.startsWith("2:")).toBe(true);
    expect(compacted.every((item) => item.content.length < 1_550)).toBe(true);
    expect(compacted.some((item) => item.content.includes("中间内容已压缩"))).toBe(true);
  });

  it("rebuilds a complete recommendation when the model refuses despite eligible evidence", () => {
    const citations = [
      citation({ mediaId: "one", code: "SM-001", genres: ["SM", "拘束"] }),
      citation({ mediaId: "two", code: "SM-002", genres: ["SM", "羞辱"] }),
      citation({ mediaId: "three", code: "SM-003", genres: ["SM"] }),
      citation({ mediaId: "four", code: "SM-004", genres: ["SM", "调教"] })
    ];
    const answer = finalizeAgentAnswer(
      "推荐四部SM影片",
      "当前可用证据不足，无法推荐。",
      citations,
      [1, 2, 3, 4],
      { signals: [{ dimension: "genre", value: "拘束", weight: 0.7, confidence: 0.8, source: "favorite" }] }
    );
    expect(answer).toContain("## 推荐影片");
    expect(answer).toContain("SM-001 [1]");
    expect(answer).toContain("SM-004 [4]");
    expect(answer).not.toContain("证据不足");
    expect(buildAgentPresentation("推荐四部SM影片", answer, citations, [1, 2, 3, 4])).toMatchObject({
      kind: "media-cards",
      title: "推荐影片",
      citationNumbers: [1, 2, 3, 4]
    });
  });

  it("labels profile fallback candidates instead of refusing or claiming an exact match", () => {
    const citations = [citation({
      mediaId: "adjacent",
      code: "ADJ-001",
      genres: ["拘束"],
      selectionBasis: "profile-fallback"
    })];
    const answer = finalizeAgentAnswer("推荐一部冷门题材影片", "当前证据不足，无法推荐。", citations, [1], {
      signals: [{ dimension: "genre", value: "重口", weight: 0.6, confidence: 0.7, source: "query_history" }]
    });

    expect(answer).toContain("用户画像相邻候选");
    expect(answer).toContain("ADJ-001 [1]");
    expect(answer).not.toContain("无法推荐");
    expect(answer).not.toContain("精确命中“冷门题材”");
  });

  it("reserves bounded profile space for recent query-derived interests", () => {
    const selected = selectBoundedPreferenceSignals([
      { dimension: "genre", value: "剧情", weight: 0.9, confidence: 0.9, source: "feedback" },
      { dimension: "genre", value: "制服", weight: 0.85, confidence: 0.9, source: "favorite" },
      { dimension: "actor", value: "演员甲", weight: 0.8, confidence: 0.9, source: "feedback" },
      { dimension: "maker", value: "厂商甲", weight: 0.75, confidence: 0.9, source: "watch_history" },
      { dimension: "genre", value: "SM", weight: 0.36, confidence: 0.42, source: "query_history" }
    ], 4);

    expect(selected).toHaveLength(4);
    expect(selected.some((signal) => signal.source === "query_history" && signal.value === "SM")).toBe(true);
  });

  it("returns a useful relaxation path when every local fallback is genuinely empty", () => {
    const answer = finalizeAgentAnswer("推荐6部不存在题材的未观看影片", "本地馆藏作品证据为 0 条，无法推荐。", [], []);
    expect(answer).toContain("精确标签、上位题材标签组、当前对话实体和用户画像候选");
    expect(answer).toContain("放宽一个条件");
    expect(answer).not.toContain("请补充具体的影片列表");
  });

  it("uses rich metadata in deterministic recommendation reasons", () => {
    const citations = [citation({
      mediaId: "rich",
      code: "RICH-001",
      maker: "SOD Create",
      label: "SODSTAR",
      director: "小松十七"
    })];
    const answer = finalizeAgentAnswer("推荐一部影片", "无法推荐。", citations, [1]);
    expect(answer).toContain("由“SOD Create”制作");
    expect(answer).toContain("来自“SODSTAR”厂牌");
  });

  it("rebuilds self-correcting or absence-based recommendation prose", () => {
    const citations = [
      citation({ mediaId: "one", code: "SM-001", genres: ["SM"] }),
      citation({ mediaId: "two", code: "SM-002", genres: ["SM"] }),
      citation({ mediaId: "three", code: "SM-003", genres: ["SM"] }),
      citation({ mediaId: "four", code: "SM-004", genres: ["SM"] }),
      citation({ mediaId: "five", code: "SM-005", genres: ["SM"] })
    ];
    const answer = finalizeAgentAnswer(
      "推荐四部SM影片",
      "## 推荐影片\nSM-001 [1]\nSM-002 [2]\nSM-003 [3]\nSM-004 [4] 虽未标记中出标签。\n\n修正：替换为 SM-005 [5]。",
      citations,
      [1, 2, 3, 4, 5]
    );
    expect(answer).not.toContain("修正");
    expect(answer).not.toContain("未标记");
    expect(buildAgentPresentation("推荐四部SM影片", answer, citations, [1, 2, 3, 4, 5])).toMatchObject({
      citationNumbers: [1, 2, 3, 4]
    });
  });

  it("rebuilds recommendations when a code is paired with another citation number", () => {
    const citations = [
      citation({ mediaId: "one", code: "SM-001", genres: ["SM"] }),
      citation({ mediaId: "two", code: "SM-002", genres: ["SM"] })
    ];
    const answer = finalizeAgentAnswer("推荐1部SM影片", "## 推荐影片\n- **SM-002 [1]** — 很合适", citations, [1, 2]);
    const doubleCodeAnswer = finalizeAgentAnswer(
      "推荐1部SM影片",
      "## 推荐影片\n- **SM-002 SM-001 [1]** — 很合适",
      citations,
      [1, 2]
    );

    expect(answer).toContain("**SM-001 [1]**");
    expect(answer).not.toContain("SM-002 SM-001 [1]");
    expect(doubleCodeAnswer).toContain("**SM-001 [1]**");
    expect(doubleCodeAnswer).not.toContain("SM-002 SM-001 [1]");
  });

  it("rebuilds recommendations when the same selected citation is repeated", () => {
    const citations = [citation({ mediaId: "one", code: "SM-001", genres: ["SM"] })];
    const answer = finalizeAgentAnswer(
      "推荐1部SM影片",
      "## 推荐影片\n\n**SM-001 [1]** — 命中题材，详情再次参见 SM-001 [1]。",
      citations,
      [1]
    );

    expect(answer.match(/SM-001 \[1]/g)).toHaveLength(1);
  });

  it("parses client NDJSON events across arbitrary chunk boundaries", async () => {
    const events: AgentStreamEvent[] = [];
    await consumeAgentNdjsonStream(byteStream([
      '{"type":"delta","del',
      'ta":"第一段"}\n{"type":"delta","delta":"第二段"',
      '}\n'
    ]), (event) => events.push(event));

    expect(events).toEqual([
      { type: "delta", delta: "第一段" },
      { type: "delta", delta: "第二段" }
    ]);
  });

  it("parses a buffered NDJSON response for older Android WebViews", () => {
    const events: AgentStreamEvent[] = [];
    consumeAgentNdjsonText(
      '{"type":"accepted"}\n{"type":"delta","delta":"已收到"}\n',
      (event) => events.push(event)
    );

    expect(events).toEqual([
      { type: "accepted" },
      { type: "delta", delta: "已收到" }
    ]);
  });

  it("collects answer tokens while keeping internal model thinking private", async () => {
    const deltas: string[] = [];
    let thinkingStarted = 0;
    const answer = await consumeAgentModelStream(byteStream([
      '{"message":{"thinking":"先核对证据"}}\n{"message":{"content":"**推荐**"',
      '}}\n{"message":{"content":" AARM-199 [1]"},"done":false}\n{"done":true}\n'
    ]), {
      onContent: (delta) => deltas.push(delta),
      onThinkingStarted: () => { thinkingStarted += 1; }
    });

    expect(answer).toBe("**推荐** AARM-199 [1]");
    expect(deltas).toEqual(["**推荐**", " AARM-199 [1]"]);
    expect(thinkingStarted).toBe(1);
    expect(answer).not.toContain("先核对证据");
  });

  it("buffers regeneration and guarantees a distinct answer even when both model attempts repeat", async () => {
    const responseFor = (content: string) => new Response(byteStream([
      `${JSON.stringify({ message: { content }, done: true })}\n`
    ]), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(responseFor("完全相同的回答"))
      .mockResolvedValueOnce(responseFor("完全相同的回答"));
    const deltas: string[] = [];

    try {
      const answer = await streamAgentAnswer("重新回答", [], [], {
        onContent: (delta) => deltas.push(delta),
        variationSeed: 123,
        previousAnswer: "完全相同的回答",
        model: "test-model"
      });

      expect(agentAnswersEquivalent("完全相同的回答", answer)).toBe(false);
      expect(answer).toContain("重新生成");
      expect(deltas).toEqual([answer]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as {
        options: { seed: number };
        messages: Array<{ role: string; content: string }>;
      });
      expect(requests[0].options.seed).toBe(123);
      expect(requests[1].options.seed).not.toBe(123);
      expect(requests[0].messages.at(-1)?.content).not.toBe(requests[1].messages.at(-1)?.content);
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Cache-Control")).toBe("no-store");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("surfaces an Ollama error embedded inside the response stream", async () => {
    await expect(consumeAgentModelStream(byteStream([
      '{"message":{"content":"部分回答"}}\n',
      '{"error":"model runner stopped"}\n'
    ]), { onContent: () => undefined })).rejects.toThrow("model runner stopped");
  });
});
