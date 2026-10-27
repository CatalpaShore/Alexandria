// Pure, read-only adapter for the verified public demo snapshot. No remote API.
const normalize = value => String(value ?? '').toLocaleLowerCase();
const list = value => String(value || '').split(',').filter(v => v && v !== 'ALL');
const integer = (value, fallback, max = 120) => Math.max(1, Math.min(max, Number.parseInt(value, 10) || fallback));
const keyFor = (type, value) => `/api/entities/${type}/${encodeURIComponent(value)}`;
const paged = (items, params, defaults = {}) => {
  const pageSize = integer(params.get('pageSize'), defaults.pageSize || 48);
  const page = integer(params.get('page'), 1, 100000);
  return { ...defaults, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, totalPages: Math.ceil(items.length / pageSize), nextCursor: null };
};
function values(item, field) {
  const fields = { actor: 'actors', genre: 'genres', metadataSeries: 'series' };
  const value = item.metadata?.[fields[field] || field];
  return Array.isArray(value) ? value : value ? [value] : [];
}
export function filterMedia(items, params) {
  let result = items.filter(item => {
    const q = normalize(params.get('q')).trim();
    if (q && !normalize([item.name, item.normalizedCode, ...Object.values(item.metadata || {}).flat()].join(' ')).includes(q)) return false;
    for (const [query, field] of Object.entries({ category: 'libraryCategory', source: 'sourceName', bucket: 'collectionBucket', extension: 'extension', prefix: 'codePrefix', letter: 'firstLetter', mediaType: 'mediaType' })) {
      const value = params.get(query); if (value && value !== 'ALL' && normalize(item[field]) !== normalize(value)) return false;
    }
    if (params.get('tag') && !JSON.parse(item.variantTags || '[]').includes(params.get('tag'))) return false;
    for (const field of ['actor', 'genre', 'director', 'maker', 'label', 'metadataSeries']) {
      const selected = params.getAll(field).flatMap(list);
      if (selected.length && !selected.some(v => values(item, field).includes(v))) return false;
    }
    if (['true', '1'].includes(params.get('favoriteOnly')) && !item.isFavorite) return false;
    const state = params.get('playbackState');
    if (state === 'history' && !item.playback) return false;
    if (state === 'completed' && !item.playback?.completed) return false;
    if (state === 'inProgress' && (!item.playback || item.playback.completed || item.playback.positionSeconds <= 0)) return false;
    if (params.get('soloOnly') === 'true' && values(item, 'actor').length !== 1) return false;
    const year = Number.parseInt(item.metadata?.releaseDate, 10);
    if (params.get('yearFrom') && !(year >= Number(params.get('yearFrom')))) return false;
    if (params.get('yearTo') && !(year <= Number(params.get('yearTo')))) return false;
    return true;
  });
  const hash = id => [...id + (params.get('randomSeed') || '0')].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 0);
  const sortValue = item => ({ mtime: item.mtimeMs, size: item.size, recentPlayed: item.playback?.lastPlayedAt || '', progress: (item.playback?.positionSeconds || 0) / (item.durationSeconds || 1), random: hash(item.id) })[params.get('sort')] ?? item.name;
  result = result.sort((a, b) => {
    const x = sortValue(a), y = sortValue(b);
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * (params.get('direction') === 'desc' ? -1 : 1);
  });
  return result;
}
function graphResponse(snapshot, pathname, p, media) {
  const original = snapshot.responses['/api/knowledge-graph'];
  const eligible = new Set(filterMedia(media, p).map(m => m.id));
  const membership = node => new Set((snapshot.responses[keyFor(node.type, node.value)]?.items || []).map(m => m.id).filter(id => eligible.has(id)));
  let nodes = original.nodes.filter(n => membership(n).size > 0).map(n => ({ ...n, mediaCount: membership(n).size }));
  const ids = new Set(nodes.map(n => n.id));
  let edges = original.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => {
    const a = membership(nodes.find(n => n.id === e.source)), b = membership(nodes.find(n => n.id === e.target));
    const sharedCount = [...a].filter(id => b.has(id)).length;
    return { ...e, sharedCount, weight: sharedCount };
  }).filter(e => e.sharedCount >= integer(p.get('minShared'), 1));
  const source = nodes.find(n => n.type === p.get('sourceType') && n.value === p.get('sourceValue'));
  const target = nodes.find(n => n.type === p.get('targetType') && n.value === p.get('targetValue'));
  if (pathname.endsWith('/connection')) {
    const a = source ? membership(source) : new Set(), b = target ? membership(target) : new Set();
    const items = media.filter(m => a.has(m.id) && b.has(m.id));
    return { items, total: items.length, pageInfo: { nextCursor: null, hasMore: false, total: items.length } };
  }
  if (pathname.endsWith('/path')) {
    const queue = source ? [[source.id]] : [], visited = new Set(); let route = [];
    while (queue.length) {
      const current = queue.shift(), last = current.at(-1);
      if (last === target?.id) { route = current; break; }
      if (visited.has(last) || current.length > integer(p.get('maxDepth'), 6, 12)) continue;
      visited.add(last);
      for (const e of edges) { const next = e.source === last ? e.target : e.target === last ? e.source : null; if (next && !current.includes(next)) queue.push([...current, next]); }
    }
    return { found: route.length > 0, path: route, nodes: route.map(id => nodes.find(n => n.id === id)), edges: edges.filter(e => route.some((id, i) => i > 0 && ((e.source === id && e.target === route[i - 1]) || (e.target === id && e.source === route[i - 1])))), summary: { hopCount: route.length ? route.length - 1 : null, visitedNodeCount: visited.size } };
  }
  if (pathname.endsWith('/neighbors')) {
    const types = list(p.get('targetTypes'));
    edges = edges.filter(e => e.source === source?.id || e.target === source?.id);
    nodes = nodes.filter(n => n.id !== source?.id && (!types.length || types.includes(n.type)) && edges.some(e => e.source === n.id || e.target === n.id));
    const keep = new Set([source?.id, ...nodes.map(n => n.id)]);
    return { source, nodes, edges: edges.filter(e => keep.has(e.source) && keep.has(e.target)), pageInfo: { nextCursor: null, hasMore: false, total: nodes.length } };
  }
  const types = list(p.get('types')), q = normalize(p.get('q'));
  nodes = nodes.filter(n => (!types.length || types.includes(n.type)) && (!q || normalize([n.label, n.value, ...n.aliases].join(' ')).includes(q)));
  if (p.get('hideGeneric') === 'true') nodes = nodes.filter(n => n.mediaCount < media.length || n.type !== 'genre');
  nodes = nodes.slice(0, integer(p.get('limit'), 100, 100));
  const keep = new Set(nodes.map(n => n.id)); edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
  return { ...original, nodes, edges, summary: { nodeCount: nodes.length, edgeCount: edges.length, mediaConnections: edges.reduce((n, e) => n + e.sharedCount, 0), types: [...new Set(nodes.map(n => n.type))].map(type => ({ type, count: nodes.filter(n => n.type === type).length })) } };
}
export function resolveDemoRequest(snapshot, input, method = 'GET') {
  const url = new URL(input, 'https://demo.invalid'), p = url.searchParams, pathname = url.pathname;
  const json = body => ({ status: 200, body });
  const error = (status, code, message) => ({ status, body: { code, error: message } });
  if (!['GET', 'HEAD'].includes(method)) return error(403, 'DEMO_READ_ONLY', '公开 Demo 为只读展示。Read-only demo: changes are not saved. 読み取り専用デモです。');
  if (snapshot.assets[pathname]) return { status: 200, asset: snapshot.assets[pathname] };
  const thumb = pathname.match(/^(\/api\/media\/[^/]+)\/thumbnail$/);
  if (thumb && snapshot.assets[thumb[1] + '/poster']) return { status: 200, asset: snapshot.assets[thumb[1] + '/poster'] };
  const responses = snapshot.responses;
  const media = responses['/api/media'].items.map(item => ({ ...item, metadata: responses[`/api/media/${item.id}/detail`]?.item.metadata || item.metadata }));
  // No ingestion service is exposed; the demo has no import-history events.
  if (pathname === '/api/ingestion/recent-media') return json({ ...paged([], p), startedAt: '' });
  if (pathname === '/api/demo/status') return json({ ...responses[pathname], staticDemo: true });
  if (pathname === '/api/media') return json(paged(filterMedia(media, p), p));
  if (pathname === '/api/media/facets') {
    const filtered = filterMedia(media, p);
    const fields = { letters: 'firstLetter', extensions: 'extension', mediaTypes: 'mediaType', categories: 'libraryCategory', sources: 'sourceName', prefixes: 'codePrefix', buckets: 'collectionBucket', quality: 'qualityTag' };
    return json(Object.fromEntries(Object.entries(responses[pathname]).map(([key, facets]) => [key, !Array.isArray(facets) ? (key === 'totals' ? { count: filtered.length, totalSize: filtered.reduce((n, m) => n + m.size, 0) } : facets) : facets.map(f => ({ ...f, count: filtered.filter(m => fields[key] ? m[fields[key]] === f.value : key === 'tags' ? JSON.parse(m.variantTags || '[]').includes(f.value) : values(m, { actors: 'actor', genres: 'genre', directors: 'director', makers: 'maker', labels: 'label', series: 'series' }[key] || key).includes(f.value)).length })).filter(f => f.count > 0)])));
  }
  if (pathname === '/api/search/suggestions') {
    const q = normalize(p.get('q')), limit = integer(p.get('limit'), 8, 16);
    const result = { codes: media.filter(m => normalize(m.normalizedCode + ' ' + m.metadata.title).includes(q)).slice(0, limit).map(m => ({ type: 'code', value: m.normalizedCode, label: m.normalizedCode, subtitle: m.metadata.title, count: 1, mediaId: m.id })) };
    for (const [field, type] of [['actors','actor'],['makers','maker'],['genres','genre']]) result[field] = (responses[`/api/topics/${type}`]?.items || []).filter(n => normalize(n.value + ' ' + n.label).includes(q)).slice(0, limit).map(n => ({ type, value: n.value, label: n.label, count: n.mediaCount, mediaId: n.mediaId }));
    return json(result);
  }
  if (/^\/api\/knowledge-graph(?:\/(?:neighbors|path|connection))?$/.test(pathname)) return json(graphResponse(snapshot, pathname, p, media));
  if (/^\/api\/topics\/[^/]+$/.test(pathname) && responses[pathname]) {
    let items = responses[pathname].items.filter(n => normalize([n.value, n.label, ...n.aliases].join(' ')).includes(normalize(p.get('q'))) && (p.get('favoriteOnly') !== 'true' || n.isFavorite));
    const sort = p.get('sort');
    items = [...items].sort((a, b) => sort === 'name' ? a.label.localeCompare(b.label) : sort === 'latest' ? String(b.latestReleaseDate).localeCompare(String(a.latestReleaseDate)) : sort === 'count-asc' ? a.mediaCount - b.mediaCount : b.mediaCount - a.mediaCount);
    return json(paged(items, p, responses[pathname]));
  }
  if (pathname === '/api/entities/actor-cards') return json({ items: [] });
  if (/^\/api\/entities\/[^/]+\/[^/]+$/.test(pathname)) {
    const parts = pathname.split('/'); let key;
    try { key = keyFor(parts[3], decodeURIComponent(parts[4])); } catch { return error(400, 'BAD_PATH', 'Invalid path'); }
    if (responses[key]) return json(paged(filterMedia(responses[key].items, p), p, responses[key]));
  }
  if (Object.hasOwn(responses, pathname)) return json(responses[pathname]);
  return error(403, 'DEMO_ADMIN_DISABLED', '在线 Demo 不提供此服务器功能，请自行部署。This feature requires self-hosting. この機能はセルフホスト環境で利用できます。');
}
