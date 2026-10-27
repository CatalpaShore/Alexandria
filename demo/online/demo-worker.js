import { resolveDemoRequest } from './browser-api.mjs';
const base = new URL(self.registration.scope);
const data = fetch(new URL('demo-data.json', base), { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw Error('Demo data unavailable');
  const snapshot = await response.json();
  if (snapshot.content !== 'non-adult-film-mock' || snapshot.version !== 1) throw Error('Invalid demo snapshot');
  return snapshot;
});
self.addEventListener('install', event => event.waitUntil(data.then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== base.origin) return;
  const pathname = url.pathname.startsWith(base.pathname) ? '/' + url.pathname.slice(base.pathname.length) : url.pathname;
  if (/^\/tour(?:\/|$)/i.test(pathname)) { event.respondWith(new Response('Not found', { status: 404 })); return; }
  if (pathname.startsWith('/api/')) {
    event.respondWith(data.then(async snapshot => {
      const result = resolveDemoRequest(snapshot, pathname + url.search, event.request.method);
      if (result.asset) return fetch(new Request(new URL(result.asset, base), { method: event.request.method, headers: event.request.headers }));
      return new Response(event.request.method === 'HEAD' ? null : JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Alexandria-Demo': 'read-only' } });
    }).catch(() => new Response(JSON.stringify({ error: 'Demo unavailable. Reload to retry.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  if (!url.pathname.startsWith(base.pathname) && /^\/(?:brand-icon\.png|demo\/|showcase\/)/.test(pathname)) event.respondWith(fetch(new Request(new URL(pathname.slice(1) + url.search, base), event.request)));
});
