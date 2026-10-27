import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentEntityRanking } from "../../client/src/components/agent/AgentEntityRanking";
import {
  parseActorProfileMediaQuery,
  parseActorProfileRankingQuery,
  parseEntityRankingQuery
} from "../../server/src/agentTools";

// Pure parsing/rendering checks retained; private-catalog assertions are local only.
describe("Agent query compatibility without private data",()=>{
it("routes height rankings and ranges to structured profile data", () => {
    expect(parseActorProfileRankingQuery("身高最高的前5位演员是谁")?.metric).toBe("height");
    expect(parseActorProfileRankingQuery("身高最高的前5位演员是谁")?.limit).toBe(5);
    expect(parseActorProfileRankingQuery("哪些女优身高170厘米以上")).toMatchObject({
      metric: "height", order: "desc", minHeightCm: 170
    });
    expect(parseActorProfileRankingQuery("最矮的演员")).toMatchObject({ metric: "height", order: "asc" });
    expect(parseActorProfileRankingQuery("哪些女优身高170厘米及以上")).toMatchObject({
      metric: "height", order: "desc", minHeightCm: 170
    });
    expect(parseActorProfileRankingQuery("哪些女优身高160公分以下")).toMatchObject({
      metric: "height", order: "desc", maxHeightCm: 160
    });
  });
it("understands age, measurement, cup and completeness questions", () => {
    expect(parseActorProfileRankingQuery("最年轻的10位演员")?.metric).toBe("birth_date");
    expect(parseActorProfileRankingQuery("2000年后出生的女优")).toMatchObject({
      metric: "birth_date", birthYearFrom: 2001
    });
    expect(parseActorProfileRankingQuery("2000年及以后出生的女优")).toMatchObject({
      metric: "birth_date", birthYearFrom: 2000
    });
    expect(parseActorProfileRankingQuery("1990年及以前出生的演员")).toMatchObject({
      metric: "birth_date", birthYearTo: 1990
    });
    expect(parseActorProfileRankingQuery("哪些演员有完整三围资料")?.metric).toBe("measurements");
    expect(parseActorProfileRankingQuery("罩杯最大的演员排行")?.metric).toBe("cup");
    expect(parseActorProfileRankingQuery("公开资料最完整的演员")?.metric).toBe("completeness");
  });
it("does not intercept unrelated actor aggregation questions", () => {
    expect(parseActorProfileRankingQuery("哪些演员拥有最多的深喉标签")).toBeNull();
    expect(parseActorProfileRankingQuery("推荐几部最近的影片")).toBeNull();
  });
it("parses profile attributes as deterministic movie filters", () => {
    expect(parseActorProfileMediaQuery("推荐6部身高160cm以上演员的影片")).toMatchObject({
      rankingInput: { metric: "height", order: "desc", minHeightCm: 160 },
      mediaLimit: 6
    });
    expect(parseActorProfileMediaQuery("找2000年后出生演员的作品")).toMatchObject({
      rankingInput: { metric: "birth_date", order: "desc", birthYearFrom: 2001 }
    });
    expect(parseActorProfileMediaQuery("推荐D杯以上演员的作品")).toMatchObject({
      rankingInput: { metric: "cup", order: "desc", minCupRank: 4 }
    });
    expect(parseActorProfileMediaQuery("推荐8部身高160cm以上、2000年后出生、D杯以上演员的作品")).toMatchObject({
      rankingInput: {
        metric: "height", order: "desc", minHeightCm: 160, birthYearFrom: 2001, minCupRank: 4
      },
      mediaLimit: 8
    });
    expect(parseActorProfileMediaQuery("身高最高的前5位演员是谁")).toBeNull();
  });
it("clamps explicit top-N requests to the supported result window", () => {
    expect(parseActorProfileRankingQuery("身高最高的top 0位演员")?.limit).toBe(1);
    expect(parseActorProfileRankingQuery("身高最高的top 99位演员")?.limit).toBe(20);
  });
it("leaves tag-scoped actor rankings to the dedicated tag analytics path", () => {
    expect(parseEntityRankingQuery("哪些演员拥有最多的深喉标签")).toBeNull();
  });
it("renders structured metric details and keeps rows actionable", () => {
    const markup = renderToStaticMarkup(createElement(AgentEntityRanking, {
      onOpenEntity: () => undefined,
      presentation: {
        kind: "entity-ranking",
        title: "演员身高排行",
        metricLabel: "cm",
        rows: [
          { rank: 1, type: "actor", value: "森あやみ", label: "森彩美", count: 28, detail: "172 cm" },
          { rank: 2, type: "actor", value: "example", label: "示例演员", count: 12 }
        ]
      }
    }));

    expect(markup).toContain('aria-label="演员身高排行"');
    expect(markup).toContain("森彩美");
    expect(markup).toContain("172 cm");
    expect(markup).toContain("示例演员");
    expect(markup).toContain("12 cm");
    expect(markup.match(/<button/g)).toHaveLength(2);
  });
});
