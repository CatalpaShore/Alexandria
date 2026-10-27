import { describe, expect, it, vi } from "vitest";

vi.mock("../../server/src/agentCapabilities.js", () => ({
  getAgentRuntimeStatus: vi.fn(async () => ({
    agentAvailable: true,
    loadedModels: ["test-chat-model"],
    storage: { ready: true },
    unavailableReason: null
  }))
}));

vi.mock("../../server/src/backupManager.js", () => ({
  listBackupJobs: vi.fn(() => [])
}));

import { db } from "../../server/src/db.js";
import {
  buildTaskCenter,
  issueDefinitions,
  previewGovernanceAction
} from "../../server/src/governanceActionRoutes.js";

function totalChanges(): number {
  return Number((db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
}

describe("governance action loop", () => {
  it("initializes a durable task table with preview and lifecycle fields", () => {
    const columns = db.prepare("PRAGMA table_info(governance_action_tasks)").all() as Array<{
      dflt_value: string | null;
      name: string;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));

    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      "id",
      "user_id",
      "issue_key",
      "action_type",
      "grain",
      "status",
      "target_count",
      "target_ids_json",
      "preview_json",
      "result_json",
      "error",
      "confirmed_at",
      "started_at",
      "completed_at",
      "updated_at"
    ]));
    expect(byName.get("status")?.dflt_value).toBe("'draft'");
    expect(byName.get("preview_json")?.dflt_value).toBe("'[]'");
  });

  it("previews every supported issue without mutating the database", () => {
    const before = totalChanges();
    const issueKeys = Object.keys(issueDefinitions) as Array<keyof typeof issueDefinitions>;

    for (const issueKey of issueKeys) {
      const preview = previewGovernanceAction(issueKey, 3);
      const definition = issueDefinitions[issueKey];
      expect(preview).toMatchObject({
        actionLabel: definition.actionLabel,
        actionType: definition.actionType,
        grain: definition.grain,
        issueKey,
        issueLabel: definition.label
      });
      expect(preview.selectedCount).toBe(preview.samples.length);
      expect(preview.selectedCount).toBeLessThanOrEqual(3);
      expect(preview.total).toBeGreaterThanOrEqual(preview.selectedCount);
      expect(preview.truncated).toBe(preview.total > preview.selectedCount);
      expect(new Set(preview.samples.map((sample) => sample.targetId)).size).toBe(preview.samples.length);
    }

    expect(totalChanges()).toBe(before);
  });

  it("aggregates task-center state without starting AI services or writing tasks", async () => {
    const before = totalChanges();
    const taskCenter = await buildTaskCenter("user-1");

    expect(taskCenter.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(taskCenter.summary).toMatchObject({
      attention: expect.any(Number),
      active: expect.any(Number),
      completedToday: expect.any(Number),
      unread: expect.any(Number)
    });
    expect(taskCenter.governance).toBeInstanceOf(Array);
    expect(taskCenter.mediaJobs).toBeInstanceOf(Array);
    expect(taskCenter.ingestionRuns).toBeInstanceOf(Array);
    expect(taskCenter.runtimes).toEqual({
      agent: {
        available: true,
        loadedModels: ["test-chat-model"],
        reason: null,
        storageReady: true
      },
    });
    expect(totalChanges()).toBe(before);
  });
});
