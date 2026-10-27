import { expect, test } from "@playwright/test";

const demoURL = process.env.PLAYWRIGHT_DEMO_URL ?? "http://127.0.0.1:4312";

test("non-adult introduction loads screenshots, switches them across languages, and excludes the recorded tour", async ({ page, request }) => {
  const tourRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/tour/")) tourRequests.push(request.url()); });
  await page.goto(demoURL);
  await page.getByRole("button", { name: "打开产品介绍", exact: true }).click();
  const showcase = page.locator("#intro-preview");
  await expect(showcase.getByRole("heading", { name: "先看看平台的实际效果" })).toBeVisible();
  await expect(showcase.locator("video")).toHaveCount(0);
  await expect(showcase.getByRole("tab")).toHaveCount(6);
  await page.locator("#showcase-tab-personal-library").click();
  const image = showcase.locator(".intro-showcase-image img");
  await expect(image).toHaveAttribute("src", "/showcase/personal-library.png");
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  await page.locator(".ui-language-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("English", { exact: true }).click();
  await expect(showcase.getByRole("heading", { name: "See Alexandria 18+ in action" })).toBeVisible();
  await expect(page.locator("#showcase-tab-personal-library")).toHaveAttribute("aria-selected", "true");
  expect(tourRequests).toEqual([]);
  expect((await request.get(demoURL + "/tour/product-tour.mp4")).status()).toBe(404);
  expect((await request.head(demoURL + "/tour/subtitles-zh.vtt")).status()).toBe(404);
  for (const lang of ["en", "ja"]) {
    expect((await request.get(`${demoURL}/tour/product-tour-${lang}.mp4`)).status()).toBe(404);
    expect((await request.head(`${demoURL}/tour/subtitles-${lang}.vtt`)).status()).toBe(404);
  }
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});

test("self-hosted introduction plays the final path-redacted tour, preserves position on language changes, and serves Range requests", async ({ page, request }) => {
  const range = await request.get("/tour/product-tour.mp4", { headers: { Range: "bytes=0-99" } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(100);
  expect(range.headers()["content-type"]).toContain("video/mp4");
  const captions = await request.get("/tour/subtitles-zh.vtt");
  expect(captions.ok()).toBe(true);
  expect(await captions.text()).toContain("WEBVTT");
  await page.goto("/");
  await page.getByRole("button", { name: "打开产品介绍", exact: true }).click();
  const video = page.locator("#intro-preview video");
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => { element.muted = true; element.load(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(138);
  await video.evaluate(async (element: HTMLVideoElement) => { element.currentTime = 133; await element.play(); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(133.2);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await page.locator(".ui-language-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("English", { exact: true }).click();
  await expect(video).toHaveAttribute("aria-label", "Alexandria 18+ redacted product tour video");
  await expect(video).toHaveAttribute("data-tour-language", "en");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain("/tour/product-tour-en.mp4");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(133.2);
  expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
  await expect(video.locator("track")).toHaveAttribute("src", "/tour/subtitles-en.vtt");
  await page.locator(".ui-language-select").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option-content").getByText("日本語", { exact: true }).click();
  await expect(video).toHaveAttribute("data-tour-language", "ja");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toContain("/tour/product-tour-ja.mp4");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(133.2);
  await expect(video.locator("track")).toHaveAttribute("src", "/tour/subtitles-ja.vtt");
  expect(await video.evaluate((element: HTMLVideoElement) => element.error)).toBeNull();
  for (const lang of ["en", "ja"]) {
    const localizedRange = await request.get(`/tour/product-tour-${lang}.mp4`, { headers: { Range: "bytes=0-99" } });
    expect(localizedRange.status()).toBe(206);
    expect((await localizedRange.body()).length).toBe(100);
    expect(await (await request.get(`/tour/subtitles-${lang}.vtt`)).text()).toContain("WEBVTT");
  }
});
