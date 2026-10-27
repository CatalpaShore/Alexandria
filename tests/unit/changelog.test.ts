import { describe, expect, it } from "vitest";
import changelogData from "../../client/src/changelog-data.json";

describe("更新日志", () => {
  it("所有展示标题和变更说明均包含中文", () => {
    for (const entry of changelogData) {
      expect(entry.title, entry.commit).toMatch(/[\u3400-\u9fff]/);
      for (const change of entry.changes) {
        expect(change.text, `${entry.commit}:${change.type}`).toMatch(/[\u3400-\u9fff]/);
      }
    }
  });

  it("每条提交都包含一致的行数统计", () => {
    for (const entry of changelogData) {
      expect(entry.stats.files, entry.commit).toBeGreaterThanOrEqual(0);
      expect(entry.stats.additions, entry.commit).toBeGreaterThanOrEqual(0);
      expect(entry.stats.deletions, entry.commit).toBeGreaterThanOrEqual(0);
      expect(entry.stats.total, entry.commit).toBe(entry.stats.additions + entry.stats.deletions);
    }
  });
});
