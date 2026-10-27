import { describe, expect, it } from "vitest";
import { buildAgentFollowUps } from "../../client/src/components/agent/buildAgentFollowUps";
import type { AgentMessage } from "../../client/src/features/agent/api";

function assistant(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "已根据馆藏整理结果。",
    citations: [],
    presentation: null,
    presentations: [],
    state: null,
    stateVersion: 1,
    trace: [],
    status: "completed",
    error: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

function user(content: string): AgentMessage {
  return { ...assistant({ id: `user-${content}`, content }), role: "user" };
}

function afterUser(content: string) {
  return { history: [user(content)] };
}

describe("Agent follow-up suggestions", () => {
  it("only suggests follow-ups for completed assistant messages", () => {
    expect(buildAgentFollowUps(assistant({ status: "generating" }))).toEqual([]);
    expect(buildAgentFollowUps({ ...assistant(), role: "user" })).toEqual([]);
  });

  it("uses the user's exact subject and recommendation evidence as distinct next-step anchors", () => {
    const message = assistant({
      citations: [{
        mediaId: "media-1",
        code: "AARM-199",
        title: "AARM-199",
        summary: "",
        actors: ["三上悠亚"],
        genres: ["SM", "拘束"],
        series: "",
        maker: "ATTACKERS",
        favorite: false,
        completed: false,
        lastPlayedAt: "",
        score: 1
      }],
      presentation: { kind: "media-cards", title: "推荐影片", citationNumbers: [1] },
      presentations: [{ kind: "media-cards", title: "推荐影片", citationNumbers: [1] }]
    });

    expect(buildAgentFollowUps(message, afterUser("/找片 推荐几部SM影片"))).toEqual([
      "AARM-199 与“SM”直接匹配的馆藏依据有哪些？",
      "再推荐4部“拘束”路线的作品，只保留还没看过的作品，并排除刚才这些番号",
      "@三上悠亚 在“拘束”方向下还有哪些未观看作品？"
    ]);
  });

  it("changes the suggestions when the previous question changes even if the answer cards are identical", () => {
    const presentation = { kind: "media-cards" as const, title: "推荐影片", citationNumbers: [1, 2] };
    const message = assistant({
      citations: [
        { mediaId: "one", code: "SM-001", title: "SM-001", summary: "", actors: ["演员甲"], genres: ["SM", "拘束"], series: "", favorite: false, completed: false, lastPlayedAt: "", score: 1 },
        { mediaId: "two", code: "SM-002", title: "SM-002", summary: "", actors: ["演员乙"], genres: ["SM", "剧情"], series: "", favorite: false, completed: false, lastPlayedAt: "", score: 0.9 }
      ],
      presentation,
      presentations: [presentation]
    });

    const sm = buildAgentFollowUps(message, afterUser("推荐几部SM影片"));
    const plot = buildAgentFollowUps(message, afterUser("推荐几部剧情影片"));
    expect(sm).not.toEqual(plot);
    expect(sm[0]).toContain("“SM”");
    expect(plot[0]).toContain("“剧情”");
    expect(new Set(sm).size).toBe(3);
  });

  it("turns the leading ranking entity into a selectable follow-up", () => {
    const presentation = {
      kind: "entity-ranking" as const,
      title: "演员排行",
      metricLabel: "部作品",
      rows: [{ rank: 1, type: "actor" as const, value: "三上悠亜", label: "三上悠亚", count: 20 }]
    };
    expect(buildAgentFollowUps(assistant({ presentation, presentations: [presentation] }), afterUser("拥有SM标签最多的演员排行"))).toEqual([
      "查看 @三上悠亚 的资料和代表作品",
      "推荐4部 @三上悠亚 中还没看过的作品",
      "同一范围改按题材统计，前5名是谁？"
    ]);
  });

  it("anchors follow-ups to recommended entity cards", () => {
    const presentation = {
      kind: "entity-cards" as const,
      title: "值得探索的厂牌",
      subtitle: "按本地馆藏覆盖度推荐",
      items: [
        { type: "label" as const, value: "MOODYZ", label: "MOODYZ", mediaCount: 32, reason: "馆藏 32 部", highlights: ["剧情"] },
        { type: "label" as const, value: "S1", label: "S1", mediaCount: 21, reason: "馆藏 21 部", highlights: ["单体作品"] }
      ]
    };
    expect(buildAgentFollowUps(assistant({ presentation, presentations: [presentation] }), afterUser("推荐与“剧情”偏好相关的厂牌"))).toEqual([
      "比较 @MOODYZ 和 @S1 的馆藏量、代表题材与近期作品",
      "推荐4部 @MOODYZ 中“剧情”路线、还没看过的作品",
      "查看 @MOODYZ 的公开资料和代表作品"
    ]);
  });

  it("extracts a natural performer theme instead of falling back to the card title", () => {
    const presentation = {
      kind: "entity-cards" as const,
      title: "值得探索的演员",
      subtitle: "按本地馆藏覆盖度推荐",
      items: [
        { type: "actor" as const, value: "actor-1", label: "演员甲", mediaCount: 20, reason: "馆藏 20 部", highlights: ["中出"] },
        { type: "actor" as const, value: "actor-2", label: "演员乙", mediaCount: 18, reason: "馆藏 18 部", highlights: ["剧情"] },
        { type: "actor" as const, value: "actor-3", label: "演员丙", mediaCount: 12, reason: "馆藏 12 部", highlights: ["企划"] }
      ]
    };
    const followUps = buildAgentFollowUps(
      assistant({ presentation, presentations: [presentation] }),
      afterUser("帮我推荐几个拍深喉的女优")
    );

    expect(followUps[1]).toContain("“深喉”路线");
    expect(followUps[2]).toContain("与“深喉”的关联点");
    expect(followUps.join(" ")).not.toContain("值得探索的演员");
  });

  it("stops an @ entity anchor at whitespace before the rest of the user's sentence", () => {
    const presentation = { kind: "media-cards" as const, title: "自拍实录近期作品", citationNumbers: [1] };
    const message = assistant({
      citations: [{ mediaId: "one", code: "SELF-001", title: "SELF-001", summary: "", actors: ["演员甲"], genres: ["自拍实录", "苗条"], series: "", favorite: false, completed: false, lastPlayedAt: "", score: 1 }],
      presentation,
      presentations: [presentation]
    });
    const followUps = buildAgentFollowUps(message, afterUser("查看 @自拍实录 的演员资料和作品"));

    expect(followUps[0]).toContain("“自拍实录”");
    expect(followUps.join(" ")).not.toContain("自拍实录 的演员资料和作品");
  });

  it("keeps actor profile ranking follow-ups within structured profile capabilities", () => {
    const presentation = {
      kind: "entity-ranking" as const,
      title: "演员身高排行",
      metricLabel: "cm",
      rows: [{ rank: 1, type: "actor" as const, value: "森あやみ", label: "森彩美", count: 28, detail: "172 cm" }]
    };
    expect(buildAgentFollowUps(assistant({ presentation, presentations: [presentation] }), afterUser("身高最高的演员前5名"))).toEqual([
      "查看 @森彩美 的资料和代表作品",
      "推荐4部 @森彩美 中还没看过的作品",
      "这些演员里，哪些人的生日、图片和简介也比较完整？"
    ]);
  });

  it("keeps organization and series ranking follow-ups inside public-profile capabilities", () => {
    const maker = {
      kind: "entity-ranking" as const,
      title: "厂商成立时间从早到晚",
      metricLabel: "成立时间",
      rows: [{ rank: 1, type: "maker" as const, value: "Attackers", label: "ATTACKERS", count: 283 }]
    };
    const makerFollowUps = buildAgentFollowUps(
      assistant({ presentation: maker, presentations: [maker] }),
      afterUser("成立最早的厂商前5名")
    );
    expect(makerFollowUps).toEqual([
      "查看 @ATTACKERS 的资料和代表作品",
      "推荐4部 @ATTACKERS 中还没看过的作品",
      "这些机构中，哪些同时具有母公司和官方网站资料？"
    ]);

    const parentMaker = { ...maker, title: "已有母公司资料的厂商", metricLabel: "母公司" };
    const parentFollowUps = buildAgentFollowUps(
      assistant({ presentation: parentMaker, presentations: [parentMaker] }),
      afterUser("哪些厂商已经有母公司资料？")
    );
    expect(parentFollowUps[2]).toBe("这些机构中，哪些还具备官网、总部和成立时间资料？");
    expect(parentFollowUps).not.toEqual(makerFollowUps);

    const label = {
      kind: "entity-ranking" as const,
      title: "MOODYZ 旗下厂牌",
      metricLabel: "所属厂商",
      rows: [{ rank: 1, type: "label" as const, value: "MOODYZ DIVA", label: "MOODYZ DIVA", count: 12 }]
    };
    expect(buildAgentFollowUps(
      assistant({ presentation: label, presentations: [label] }),
      afterUser("MOODYZ 旗下有哪些厂牌？")
    )[2]).toBe("这些厂牌的馆藏量、官网与所属关系完整度如何？");

    const series = {
      kind: "entity-ranking" as const,
      title: "已有公开资料的系列",
      metricLabel: "馆藏作品",
      rows: [{ rank: 1, type: "series" as const, value: "脅迫スイートルーム", label: "脅迫スイートルーム", count: 106 }]
    };
    const seriesFollowUps = buildAgentFollowUps(
      assistant({ presentation: series, presentations: [series] }),
      afterUser("哪些系列有公开资料？")
    );
    expect(seriesFollowUps[0]).toContain("@脅迫スイートルーム");
    expect(seriesFollowUps[2]).toBe("同一范围改按演员统计，前5名是谁？");
  });

  it("keeps profile-filtered movie follow-ups inside deterministic profile tools", () => {
    const presentation = {
      kind: "media-cards" as const,
      title: "身高 160 cm 以上、2000 年后出生、D 杯以上演员的馆藏作品",
      citationNumbers: [1]
    };
    const message = assistant({
      citations: [{
        mediaId: "media-2", code: "SNOS-324", title: "SNOS-324", summary: "",
        actors: ["瀬戸環奈"], genres: [], series: "", favorite: false, completed: false,
        lastPlayedAt: "", score: 1
      }],
      presentation,
      presentations: [presentation]
    });
    expect(buildAgentFollowUps(message, afterUser("推荐8部身高160cm以上、2000年后出生、D杯以上演员的作品"))).toEqual([
      "@瀬戸環奈 的哪些公开资料满足刚才的筛选条件？",
      "保留刚才的身高、出生年份、罩杯条件，再换8部未观看作品",
      "这些匹配演员中，哪些人的三围、图片和简介也比较完整？"
    ]);
  });

  it("carries a clarification answer forward instead of falling back to a generic template", () => {
    const presentation = { kind: "media-cards" as const, title: "推荐影片", citationNumbers: [1, 2] };
    const message = assistant({
      citations: [
        { mediaId: "one", code: "NEW-001", title: "NEW-001", summary: "", actors: ["演员甲"], genres: ["剧情"], series: "", favorite: false, completed: false, lastPlayedAt: "", score: 1 },
        { mediaId: "two", code: "NEW-002", title: "NEW-002", summary: "", actors: ["演员乙"], genres: ["企划"], series: "", favorite: false, completed: false, lastPlayedAt: "", score: 0.9 }
      ],
      presentation,
      presentations: [presentation]
    });
    const context = {
      history: [
        user("推荐几部适合今晚看的作品"),
        assistant({ id: "question" }),
        user("继续完成上一条请求。针对馆长的问题“更想看熟悉题材还是探索新内容？”，我的选择是“探索新题材”。")
      ]
    };

    const followUps = buildAgentFollowUps(message, context);
    expect(followUps[1]).toContain("题材组合不同");
    expect(followUps[1]).toContain("未观看作品");
  });

  it("does not compete with an active clarification question", () => {
    const presentation = {
      kind: "clarification-question" as const,
      title: "先确认一个偏好",
      question: "这次更想看熟悉题材还是探索新内容？",
      options: [
        { id: "option-1", label: "贴近最近偏好" },
        { id: "option-2", label: "探索新题材" }
      ],
      allowCustom: true
    };
    expect(buildAgentFollowUps(assistant({ presentation, presentations: [presentation] }))).toEqual([]);
  });
});
