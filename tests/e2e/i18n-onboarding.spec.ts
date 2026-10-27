import { expect, test, type Page } from "@playwright/test";

async function chooseLanguage(page: Page, label: string) {
  await page.locator(".ui-language-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: new RegExp(`^${label}$`) }).click();
}

test("late search suggestions do not cover the language menu after focus leaves search", async ({ page }) => {
  let releaseSuggestions!: () => void;
  let markRequested!: () => void;
  const release = new Promise<void>(resolve => { releaseSuggestions = resolve; });
  const requested = new Promise<void>(resolve => { markRequested = resolve; });
  await page.route("**/api/search/suggestions?**", async route => {
    markRequested();
    await release;
    await route.fulfill({ json: {
      codes: [{ type: "code", value: "DEMO-001", label: "DEMO-001", subtitle: "", count: 1, mediaId: null }],
      actors: [], makers: [], genres: []
    } });
  });
  await page.goto("/");
  await page.getByPlaceholder("搜索文件名、番号、演员或标签").fill("DEMO");
  await requested;
  await page.locator(".ui-language-select").click();
  const received = page.waitForResponse(response => response.url().includes("/api/search/suggestions?"));
  releaseSuggestions();
  await received;
  await expect(page.locator(".search-suggestion-group:visible")).toHaveCount(0);
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").filter({ hasText: /^日本語$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  const search = page.getByPlaceholder("ファイル名・品番・出演者・タグを検索");
  await expect(search).toHaveValue("DEMO");
  await search.click();
  await expect(page.locator(".search-suggestion-group:visible").first()).toBeVisible();
  await search.press("Escape");
  await expect(page.locator(".search-suggestion-group:visible")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
});

test("an unconfigured Curator shows examples without requesting its disabled conversation store", async ({ page }) => {
  const conversationRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/agent/threads")) conversationRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^(智能)?馆长$/ }).click();
  await expect(page.getByText("固定示例 · 非 AI 回答", { exact: true })).toBeVisible();
  // Cover both the startup delay and the bounded idle-prefetch timer.
  await page.waitForTimeout(4_200);
  expect(conversationRequests).toEqual([]);
});

test("Chinese defaults, language persists, and switching preserves filters and metadata language", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByPlaceholder("搜索文件名、番号、演员或标签")).toBeVisible();
  await chooseLanguage(page, "English");
  await expect(page.getByLabel("Filter toolbar")).toBeVisible();
  const search = page.getByPlaceholder("Search filenames, codes, performers, or tags");
  await search.fill("DEMO");
  await chooseLanguage(page, "日本語");
  await expect(page.getByPlaceholder("ファイル名・品番・出演者・タグを検索")).toHaveValue("DEMO");
  expect(await page.evaluate(() => localStorage.getItem("adult-media-wall:metadata-language"))).toBe("zh");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByLabel("絞り込みツールバー")).toBeVisible();
});

test("topic navigation and fixed Curator examples follow the selected language", async ({ page }) => {
  await page.goto("/");
  await chooseLanguage(page, "English");
  await page.getByRole("button", { name: "Topics", exact: true }).click();
  await expect(page.getByLabel("Browse topics")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Performers 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Curator", exact: true }).click();
  await expect(page.getByText("Fixed examples · not AI responses", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unwind tonight", exact: true })).toBeVisible();
  await chooseLanguage(page, "日本語");
  await expect(page.getByText("固定サンプル · AI の回答ではありません", { exact: true })).toBeVisible();
});

test("cross-tab language changes keep the open player and its position", async ({ page, context }) => {
  await page.goto("/");
  await page.locator(".media-card .play-pill").first().click();
  const video = page.locator(".player-shell video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = 3; });
  const source = await video.getAttribute("src");
  const settings = await context.newPage();
  await settings.goto("/");
  await chooseLanguage(settings, "English");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTitle("Close player", { exact: true })).toBeVisible();
  expect(await video.getAttribute("src")).toBe(source);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(2.9);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await settings.close();
});

test("media-source form requires a current preview and explicit empty-folder confirmation", async ({ page }) => {
  const saves: Array<Record<string, unknown>> = [];
  await page.route("**/api/demo/status", route => route.fulfill({ json: { demo: false, readOnly: false } }));
  await page.route("**/api/media/facets*", async route => {
    const response = await route.fetch();
    const facets = await response.json();
    await route.fulfill({ json: { ...facets, scanning: false, latestScan: null, totals: { ...facets.totals, count: 0, totalSize: 0 } } });
  });
  await page.route("**/api/settings/library-sources", async route => {
    if (route.request().method() === "PUT") {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ json: { scanning: true, backupCreated: true } });
    }
    return route.fulfill({ json: { sources: [{ category: "LOCAL", name: "Library", root: "/media/first" }] } });
  });
  await page.route("**/api/settings/library-sources/preview", route => {
    const { sources } = route.request().postDataJSON();
    return route.fulfill({ json: { previewId: "fixture-preview", sources, retainedRecords: 12, targets: sources.map((source: object) => ({ ...source, readable: true, empty: true })) } });
  });
  await page.goto("/");
  await chooseLanguage(page, "English");
  await expect(page.getByRole("heading", { name: "Bring your collection together", exact: true })).toBeVisible();
  await page.locator(".library-welcome").getByRole("button", { name: "Connect library", exact: true }).click();
  await page.getByRole("textbox", { name: "Folder path 1", exact: true }).fill("/media/second");
  await page.getByRole("button", { name: /Preview import and relocation$/ }).click();
  const save = page.getByRole("button", { name: "Back up and start scanning", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "Use empty folders and retain offline records" }).check();
  await expect(save).toBeEnabled();
  await page.getByRole("textbox", { name: "Folder path 1", exact: true }).fill("/media/third");
  await expect(save).toHaveCount(0);
  await page.getByRole("button", { name: /Preview import and relocation$/ }).click();
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "Use empty folders and retain offline records" }).check();
  await save.click();
  await expect(page.getByText("Sources saved. Scanning has started.", { exact: true })).toBeVisible();
  expect(saves).toEqual([{ previewId: "fixture-preview", allowEmpty: true, sources: [{ category: "LOCAL", name: "Library", root: "/media/third" }] }]);
});
