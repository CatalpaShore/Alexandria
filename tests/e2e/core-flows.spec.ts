import { expect, test } from "@playwright/test";

test("primary workspaces remain reachable", async ({ page }, testInfo) => {
  await page.goto("/");
  const navigationLabel = testInfo.project.name === "mobile" ? "主要内容导航" : "内容工作区";
  await expect(page.getByLabel(navigationLabel)).toBeVisible();

  await page.getByRole("button", { name: "专题", exact: true }).click();
  await expect(page.getByLabel("专题浏览")).toBeVisible();

  await page.getByRole("button", { name: "我的", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的媒体手记" })).toBeVisible();

  await page.getByRole("button", { name: /^(媒体墙|媒体)$/ }).click();
  await expect(page.getByLabel("筛选工具栏")).toBeVisible();
});

test("cursor pages do not repeat media and diagnostics redact paths", async ({ request }) => {
  const firstResponse = await request.get("/api/media?pagination=cursor&pageSize=12&sort=name&direction=asc");
  expect(firstResponse.ok()).toBeTruthy();
  const first = await firstResponse.json() as { items: Array<{ id: string }>; nextCursor?: string | null };
  expect(first.items.length).toBeGreaterThan(0);
  if (first.nextCursor) {
  const secondResponse = await request.get(`/api/media?pagination=cursor&pageSize=12&sort=name&direction=asc&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
  expect(secondResponse.ok()).toBeTruthy();
  const second = await secondResponse.json() as { items: Array<{ id: string }> };
  const firstIds = new Set(first.items.map((item) => item.id));
  expect(second.items.some((item) => firstIds.has(item.id))).toBeFalsy();

  }

  const diagnostics = await request.get("/api/diagnostics");
  expect(diagnostics.ok()).toBeTruthy();
  const text = await diagnostics.text();
  expect(text).not.toContain("/Volumes/");
  expect(text).not.toContain("/Users/");
});

test("manual topic covers stay ahead of automatic cover fallbacks", async ({ request }) => {
  for (let page = 1; page <= 10; page += 1) {
    const response = await request.get(`/api/topics/actor?page=${page}&pageSize=60`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as {
      items: Array<{ mediaId?: string | null; customCoverMediaId?: string | null }>;
      totalPages: number;
    };
    const manuallyCovered = payload.items.filter((item) => item.customCoverMediaId);
    for (const item of manuallyCovered) {
      expect(item.mediaId).toBe(item.customCoverMediaId);
    }
    if (manuallyCovered.length > 0 || page >= payload.totalPages) return;
  }
});

test("topic detail drawers do not overflow narrow viewports", async ({ page, request }, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 390 : 725,
    height: testInfo.project.name === "mobile" ? 844 : 1_000
  });

  const response = await request.get("/api/topics/actor?page=1&pageSize=12");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as {
    items: Array<{ customCoverMediaId?: string | null; label: string }>;
  };
  const topic = payload.items.find((item) => item.customCoverMediaId) ?? payload.items[0];
  expect(topic).toBeTruthy();

  await page.goto("/");
  await page.getByRole("button", { name: "专题", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索演员" }).fill(topic?.label ?? "");
  const topicTile = page.locator(".topic-entity-tile").filter({ hasText: topic?.label ?? "" });
  await expect(topicTile).toHaveCount(1);
  await topicTile.locator(".topic-entity-open").click();

  const drawerBody = page.locator(".entity-drawer .ant-drawer-body");
  await expect(drawerBody).toBeVisible();
  if (topic?.customCoverMediaId) await expect(page.locator(".entity-manual-cover")).toBeVisible();
  const dimensions = await drawerBody.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});

test("player arrow shortcuts keep working when opened from an actor detail", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Physical keyboard shortcut coverage is desktop-only");

  const response = await request.get("/api/topics/actor?page=1&pageSize=12");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { items: Array<{ label: string }> };
  const actor = payload.items[0];
  expect(actor).toBeTruthy();

  await page.goto("/");
  await page.getByRole("button", { name: "专题", exact: true }).click();
  await page.getByLabel("搜索演员", { exact: true }).fill(actor.label);
  const topicTile = page.locator(".topic-entity-tile").filter({ hasText: actor.label });
  await expect(topicTile).toHaveCount(1);
  await topicTile.locator(".topic-entity-open").click();

  const actorDrawer = page.locator(".entity-drawer");
  await expect(actorDrawer).toBeVisible();
  await expect(actorDrawer.getByRole("switch", { name: "仅单体作品" })).not.toBeChecked();
  await actorDrawer.locator(".entity-virtual-play").first().click();

  const player = page.locator(".player-shell");
  const video = player.locator("video");
  await expect(player).toBeVisible();
  await expect.poll(() => video.evaluate((element) => element.duration)).toBeGreaterThan(1);
  const duration = await video.evaluate((element) => element.duration);
  const position = Math.min(60, duration / 4);
  await video.evaluate((element, initialPosition) => {
    element.pause();
    element.currentTime = initialPosition;
  }, position);

  const actorDrawerClose = actorDrawer.locator(".ant-drawer-close");
  await actorDrawerClose.focus();
  await actorDrawerClose.press("ArrowRight");
  const forward = Math.min(duration, position + 15);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThanOrEqual(forward - 0.5);

  await actorDrawerClose.press("ArrowLeft");
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeLessThanOrEqual(Math.max(0, forward - 15) + 0.5);
});

test("task and alert center opens without leaving the current workspace", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("任务与告警").click();
  await expect(page.getByText("任务与告警中心", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("入库通知", { exact: true }).last()).toBeVisible();
});

test("analytics and task-center contracts stay read-only and traceable", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "API contract coverage only needs one browser project");

  const summaryResponse = await request.get("/api/library-analytics/summary");
  expect(summaryResponse.ok()).toBeTruthy();
  const summary = await summaryResponse.json() as {
    contract: { metrics: Array<{ denominator: string; key: string; source: string }>; releaseDateField: string; workIdentity: string };
    scope: { dateField: string; label: string };
    summary: { files: number; works: number };
  };
  expect(summary.scope).toMatchObject({ dateField: "release_date", label: "全部馆藏" });
  expect(summary.contract).toMatchObject({
    releaseDateField: "media_metadata.release_date",
    workIdentity: "normalized_code"
  });
  expect(summary.contract.metrics.every((metric) => metric.denominator && metric.source)).toBe(true);
  expect(summary.summary.files).toBeGreaterThanOrEqual(summary.summary.works);

  const sectionResponse = await request.get("/api/library-analytics/sections/overview");
  expect(sectionResponse.ok()).toBeTruthy();
  expect(sectionResponse.headers()["x-amw-analytics-section"]).toBe("overview");
  const section = await sectionResponse.json() as { contract: { version: string }; crossAnalysis: { matrices: unknown[] }; summary: { works: number } };
  expect(section.contract.version).toBeTruthy();
  expect(section.summary.works).toBe(summary.summary.works);
  expect(section.crossAnalysis.matrices).toEqual([]);

  const previewResponse = await request.post("/api/governance/actions/preview", {
    data: { issueKey: "metadata", limit: 3 }
  });
  expect(previewResponse.ok()).toBeTruthy();
  const preview = await previewResponse.json() as { issueKey: string; samples: unknown[]; selectedCount: number; total: number };
  expect(preview.issueKey).toBe("metadata");
  expect(preview.selectedCount).toBe(preview.samples.length);
  expect(preview.selectedCount).toBeLessThanOrEqual(3);
  expect(preview.total).toBeGreaterThanOrEqual(preview.selectedCount);

  const taskCenterResponse = await request.get("/api/task-center");
  expect(taskCenterResponse.ok()).toBeTruthy();
  expect(taskCenterResponse.headers()["cache-control"]).toContain("no-store");
  const taskCenter = await taskCenterResponse.json() as { governance: unknown[]; runtimes: object; summary: object };
  expect(taskCenter.governance).toBeInstanceOf(Array);
  expect(taskCenter.summary).toMatchObject({
    active: expect.any(Number),
    attention: expect.any(Number),
    completedToday: expect.any(Number),
    unread: expect.any(Number)
  });
  expect(taskCenter.runtimes).toBeTruthy();
});

test("changelog is available from the global tools menu", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("更多工具").click();
  await page.getByRole("menuitem", { name: "更新日志" }).click();

  const drawer = page.locator(".changelog-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("2026-10-27", { exact: false }).first()).toBeVisible();
  await expect(drawer.getByText("local", { exact: true })).toBeVisible();
});
