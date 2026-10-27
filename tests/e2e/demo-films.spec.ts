import { expect, test } from "@playwright/test";

const demoURL = process.env.PLAYWRIGHT_DEMO_URL ?? "http://127.0.0.1:4312";

test("real film facts, licensed artwork, subtitles and mock activity stay consistent", async ({ request }) => {
  const catalog = await (await request.get(demoURL + "/api/demo/catalog")).json();
  expect(catalog.films).toHaveLength(12);
  expect(catalog.films.every((film: { mediaId: string | null }) => film.mediaId)).toBe(true);
  const sintel = catalog.films.find((film: { slug: string }) => film.slug === "sintel");
  // Media probes run in the background after the initial catalogue scan.
  await expect.poll(async () => (await (await request.get(`${demoURL}/api/media/${sintel.mediaId}/detail`)).json()).item.durationSeconds, { timeout: 15_000 }).toBe(12);
  const detail = await (await request.get(`${demoURL}/api/media/${sintel.mediaId}/detail`)).json();
  expect(detail.item.metadata).toMatchObject({ director: "Colin Levy", releaseDate: "2010", actors: ["Halina Reijn", "Thom Hoffman"], score: null });
  expect(detail.item.metadata.summary).toContain("并非电影正片");
  expect(detail.item.durationSeconds).toBe(12);
  const image = await request.get(`${demoURL}/api/media/${sintel.mediaId}/poster`);
  expect(image.ok()).toBe(true);
  expect((await image.body()).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(detail.sidecars.map((item: { language: string }) => item.language).sort()).toEqual(["en", "ja", "zh-CN"]);
  const subtitle = await request.get(`${demoURL}/api/sidecars/${detail.sidecars[0].id}/track.vtt`);
  expect(await subtitle.text()).toContain("WEBVTT");
  const graph = await (await request.get(demoURL + "/api/knowledge-graph?types=actor,director,genre&minShared=1")).json();
  expect(graph.nodes.length).toBeGreaterThan(12);
  expect(graph.edges.length).toBeGreaterThan(0);
  expect(graph.yearDistribution.some((bucket: { year: number }) => bucket.year === 2010)).toBe(true);
  const genres = await (await request.get(demoURL + "/api/topics/genre?page=1&pageSize=12")).json();
  expect(genres.total).toBeGreaterThan(5);
  const dashboard = await (await request.get(demoURL + "/api/personal-dashboard")).json();
  expect(dashboard.stats).toMatchObject({ played: 8, completed: 3, favoriteCount: 6, playlistCount: 3 });
  expect((await request.post(`${demoURL}/api/media/${sintel.mediaId}/progress`, { data: { positionSeconds: 9 } })).status()).toBe(403);
});

test("film artwork, source credits, search and fixed Curator cards are usable", async ({ page }) => {
  await page.goto(demoURL);
  await expect(page.getByText("真实开放电影资料 · 播放为测试片 · 收藏与观看记录为模拟数据 · 只读体验", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "素材来源与演示说明", exact: true }).click();
  const credits = page.locator(".demo-film-credits");
  await expect(credits.locator("article")).toHaveCount(12);
  await expect(credits.getByText("Big Buck Bunny · 大雄兔 · 2008", { exact: true })).toBeVisible();
  expect(await credits.locator("a").first().getAttribute("href")).toContain("creativecommons.org/licenses/by/");
  await page.locator(".ant-modal-close").click();
  await page.getByPlaceholder("搜索文件名、番号、演员或标签").fill("Sintel");
  await expect(page.locator(".media-card")).toHaveCount(1);
  await page.locator(".media-card").first().getByRole("button", { name: /^查看 / }).click();
  await expect(page.locator(".detail-title-block")).toContainText("Sintel");
  await page.goto(demoURL);
  await page.getByRole("button", { name: /^(智能)?馆长$/ }).click();
  await expect(page.locator(".agent-recommendation-main")).toHaveCount(3);
  await expect(page.locator(".agent-recommendations")).toContainText("Big Buck Bunny");
  await page.getByRole("button", { name: "查看推荐依据", exact: true }).click();
  await expect(page.locator(".agent-recommendations")).toContainText("Coffee Run");
  const poster = page.locator(".agent-recommendation-poster img").first();
  await expect.poll(() => poster.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.locator(".agent-recommendation-main").first().click();
  await expect(page.locator(".detail-title-block")).toContainText("Coffee Run");
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});

test("small demo graph exposes real cast connections and sample playback works", async ({ page }) => {
  await page.goto(demoURL);
  await page.getByRole("button", { name: "专题", exact: true }).click();
  await page.getByRole("button", { name: "知识图谱", exact: true }).click();
  await page.getByRole("region", { name: "专题维度总览" }).getByRole("button", { name: /^演员 / }).click();
  await expect(page.locator(".knowledge-graph-node").first()).toBeVisible();
  await expect(page.locator(".knowledge-graph-min-shared [role=slider]")).toHaveAttribute("aria-valuenow", "1");
  await page.goto(demoURL);
  await page.locator(".media-card .play-pill").first().click();
  const video = page.locator(".player-shell video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getBoundingClientRect().bottom - element.parentElement!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);
  await video.evaluate((element: HTMLVideoElement) => { element.muted = true; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBe(12);
  const subtitles = page.getByLabel("字幕轨道", { exact: true });
  const chinese = await subtitles.locator("option").filter({ hasText: "简体中文" }).getAttribute("value");
  const japanese = await subtitles.locator("option").filter({ hasText: "日语" }).getAttribute("value");
  const showing = () => video.evaluate((element: HTMLVideoElement) => [...element.textTracks].filter(track => track.mode === "showing").map(track => track.language));
  await subtitles.selectOption(chinese!);
  await expect.poll(showing).toEqual(["zh-CN"]);
  await subtitles.selectOption(japanese!);
  await expect.poll(showing).toEqual(["ja"]);
  await page.getByLabel("字幕编码", { exact: true }).selectOption("utf-8");
  await expect.poll(showing).toEqual(["ja"]);
  await subtitles.selectOption("off");
  await expect.poll(showing).toEqual([]);
  await video.evaluate(async (element: HTMLVideoElement) => { element.currentTime = 2; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(2.1);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
});
