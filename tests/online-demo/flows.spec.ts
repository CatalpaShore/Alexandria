import { expect, test } from '@playwright/test';

test('fresh visit, search, credits, player, subtitles and read-only boundaries', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('.media-card')).toHaveCount(12);
  await expect.poll(() => page.locator('.brand-mark').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '素材来源与演示说明', exact: true }).click();
  await expect(page.locator('.demo-film-credits article')).toHaveCount(12);
  await expect.poll(() => page.locator('.demo-film-credits img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('.ant-modal-close').click();
  await page.getByPlaceholder('搜索文件名、番号、演员或标签').fill('Sintel');
  await expect(page.locator('.media-card')).toHaveCount(1);
  await page.locator('.media-card').first().getByRole('button', { name: /^查看 / }).click();
  await expect(page.locator('.detail-title-block')).toContainText('Sintel');
  await page.goto('./');
  await page.locator('.media-card .play-pill').first().click();
  const video = page.locator('.player-shell video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration)).toBe(12);
  const subtitles = page.getByLabel('字幕轨道', { exact: true });
  for (const language of ['简体中文','English','日语']) {
    const value = await subtitles.locator('option').filter({ hasText: language }).getAttribute('value');
    await subtitles.selectOption(value!);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => [...v.textTracks].filter(t => t.mode === 'showing' && (t.cues?.length || 0) > 0).length)).toBe(1);
  }
  await video.evaluate(async (v: HTMLVideoElement) => { v.muted = true; v.currentTime = 2; await v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(2.1);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  const checks = await page.evaluate(async () => {
    const post = await fetch('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const config = await fetch('/api/settings/library-paths');
    const tour = await fetch(new URL('tour/product-tour.mp4', location.href));
    const media = await (await fetch('/api/media?q=Sintel')).json();
    const stream = await fetch(`/api/media/${media.items[0].id}/stream`, { headers: { Range: 'bytes=0-31' } });
    return { post: post.status, config: config.status, tour: tour.status, range: stream.status, bytes: (await stream.arrayBuffer()).byteLength };
  });
  expect(checks).toEqual({ post: 403, config: 403, tour: 404, range: 206, bytes: 32 });
  await page.reload(); await expect(page.locator('.media-card')).toHaveCount(12);
  expect(errors).toEqual([]);
});

test('topics, graph, personal records and mock curator remain browsable', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '专题', exact: true }).click();
  await page.getByRole('button', { name: '知识图谱', exact: true }).click();
  await page.getByRole('region', { name: '专题维度总览' }).getByRole('button', { name: /^演员 / }).click();
  await expect(page.locator('.knowledge-graph-node').first()).toBeVisible();
  await page.goto('./');
  await page.getByRole('button', { name: /^(智能)?馆长$/ }).click();
  await expect(page.locator('.agent-recommendation-main')).toHaveCount(3);
  await page.locator('.agent-recommendation-main').first().click();
  await expect(page.locator('.detail-title-block')).toContainText('Big Buck Bunny');
  await page.goto('./');
  await page.getByRole('button', { name: '我的', exact: true }).first().click();
  await expect(page.getByText('我的媒体手记', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复', exact: true })).toBeDisabled();
  await expect(page.locator('a.ant-btn').filter({ hasText: /^导出$/ })).toHaveAttribute('aria-disabled', 'true');
  const stats = await page.evaluate(async () => (await (await fetch('/api/personal-dashboard')).json()).stats);
  expect(stats).toMatchObject({ played: 8, completed: 3, favoriteCount: 6, playlistCount: 3 });
});

test('language selection persists on the hosted subpath', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.media-card')).toHaveCount(12);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  for (const [label, code] of [['English', 'en'], ['日本語', 'ja']]) {
    await page.locator('.ui-language-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: new RegExp(`^${label}$`) }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', code);
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await expect(page.locator('.media-card')).toHaveCount(12);
});
