import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Always use the verified, isolated, in-memory non-adult demo. No server URL or
// library path is accepted from the caller.
process.env.AMW_DEMO_MODE = 'true';
const [{ createApp }, { startScan }, { seedDemoExperience, verifyDemoAssets }, jobs, { db }] = await Promise.all([
  import('../dist/server/app/createApp.js'), import('../dist/server/routes.js'),
  import('../dist/server/demoSeed.js'), import('../dist/server/mediaJobs.js'), import('../dist/server/db.js')
]);
verifyDemoAssets();
const app = createApp();
await startScan();
seedDemoExperience();
jobs.startMediaJobWorker({ concurrency: 2, idleDelayMs: 20 });
jobs.enqueuePendingProbeJobs(100);
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const origin = `http://127.0.0.1:${server.address().port}`;
const output = path.resolve('.local/online-demo/site');
await fs.mkdir(path.join(output, 'demo-assets'), { recursive: true });
const snapshot = { version: 1, content: 'non-adult-film-mock', responses: {}, entities: {}, assets: {} };
async function json(url, key = url.split('?')[0]) {
  const r = await fetch(origin + url); if (!r.ok) throw Error(`Demo export ${url}: ${r.status} ${await r.text()}`);
  const value = await r.json(); snapshot.responses[key] = value; return value;
}
async function asset(url, filename) {
  const r = await fetch(origin + url); if (!r.ok) throw Error(`Demo asset ${url}: ${r.status}`);
  await fs.writeFile(path.join(output, 'demo-assets', filename), Buffer.from(await r.arrayBuffer()));
  snapshot.assets[url] = `demo-assets/${filename}`;
}
try {
  const deadline = Date.now() + 60000;
  while (db.prepare("SELECT COUNT(*) n FROM media_files WHERE probe_status='ready'").get().n < 12) {
    if (Date.now() > deadline) throw Error('Demo probes did not finish');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = await json('/api/demo/status'); assert.equal(status.demo, true);
  const catalog = await json('/api/demo/catalog'); assert.equal(catalog.films.length, 12);
  assert.ok(catalog.films.every(f => f.mediaId));
  const media = await json('/api/media?pageSize=100'); assert.equal(media.items.length, 12);
  await json('/api/media/facets');
  for (const endpoint of ['/api/access/status','/api/agent/capabilities','/api/metadata/status','/api/runtime-capabilities','/api/users','/api/favorites','/api/saved-filters','/api/personal-dashboard','/api/playlists','/api/highlights','/api/notifications/unread-count','/api/viewing-desk/session','/api/viewing-desk/sessions','/api/library-analytics/summary']) await json(endpoint);
  const topics = await json('/api/topics');
  for (const dim of topics.dimensions) {
    const list = await json(`/api/topics/${dim.type}?pageSize=100`);
    await json(`/api/favorites/topics/${dim.type}`);
    for (const entity of list.items) {
      const url = `/api/entities/${dim.type}/${encodeURIComponent(entity.value)}`;
      await json(url + '?pageSize=60', url);
    }
  }
  await json('/api/knowledge-graph?types=actor,director,genre,maker,label,series&minShared=1&limit=100');
  for (const film of catalog.films) {
    const prefix = `/api/media/${film.mediaId}`;
    const detail = await json(prefix + '/detail'); assert.equal(detail.item.durationSeconds, 12);
    for (const suffix of ['/versions','/playback-source','/progress','/readiness','/subtitles/embedded','/recommendations']) await json(prefix + suffix);
    await asset(prefix + '/poster', film.slug + '.png');
    await asset(prefix + '/stream', film.slug + '.mp4');
    for (const subtitle of detail.sidecars.filter(s => s.kind === 'subtitle')) await asset(`/api/sidecars/${subtitle.id}/track.vtt`, film.slug + '.' + subtitle.language + '.vtt');
  }
  for (const list of snapshot.responses['/api/playlists'].items) await json(`/api/playlists/${list.id}/items`);
  for (const session of snapshot.responses['/api/viewing-desk/sessions'].sessions) await json(`/api/viewing-desk/session/${session.id}`);
  const text = JSON.stringify(snapshot);
  assert.ok(!/\/(?:Users|home)\//.test(text), 'Personal path in demo export');
  // No OS/database/runtime configuration is needed in a static browser demo.
  snapshot.responses['/api/health'] = { ok: true, demo: true };
  snapshot.responses['/api/health/summary'] = { ok: true, demo: true, library: { availability: { mode: 'connected', connectedSourceNames: ['Demo'] } } };
  await fs.writeFile(path.join(output, 'demo-data.json'), JSON.stringify(snapshot));
  console.log(`Exported ${media.items.length} verified films, ${Object.keys(snapshot.responses).length} read-only responses, ${Object.keys(snapshot.assets).length} media assets.`);
} finally {
  jobs.stopMediaJobWorker();
  await new Promise(resolve => server.close(resolve));
}
// This isolated export process owns an in-memory DB; stop remaining warmup timers.
process.exit(0);
