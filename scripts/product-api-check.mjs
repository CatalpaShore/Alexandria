import assert from "node:assert/strict";

const baseUrl = (process.env.APP_URL || "http://127.0.0.1:4310").replace(/\/$/, "");
const timeoutMs = Number(process.env.API_CHECK_TIMEOUT_MS || 15_000);

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...options, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    assert.ok(
      response.status === 204 || contentType.includes("application/json"),
      `${options.method || "GET"} ${path} should return JSON, received ${contentType || "no content type"}`
    );
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      throw new Error(`${options.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const health = await request("/api/health");
assert.equal(health.ok, true);

const grouped = await request("/api/media?page=1&pageSize=12&groupVersions=true");
const ungrouped = await request("/api/media?page=1&pageSize=12&groupVersions=false");
assert.ok(grouped.items.length > 0, "media list should not be empty");
assert.ok(grouped.total <= ungrouped.total, "grouped total must not exceed physical file total");

const item = grouped.items[0];
assert.ok(item.id);
assert.ok(Number.isInteger(item.versionCount) && item.versionCount >= 1);
if (item.metadata) {
  assert.equal("summary" in item.metadata, false, "list endpoint should keep metadata compact");
}

const detail = await request(`/api/media/${encodeURIComponent(item.id)}/detail`);
assert.equal(detail.item.id, item.id);
assert.ok(detail.versions.length >= 1);
assert.ok(Array.isArray(detail.sidecars));
assert.ok(Array.isArray(detail.derivatives));
const visibleGenres = [
  ...(detail.item.metadata?.genres || []),
  ...(detail.item.metadata?.genresZh || [])
].map((value) => value.trim().toLocaleLowerCase());
for (const hidden of ["样片", "樣片", "サンプル動画", "sample video"]) {
  assert.equal(visibleGenres.includes(hidden), false, `hidden genre leaked into detail: ${hidden}`);
}

const versions = await request(`/api/media/${encodeURIComponent(item.id)}/versions`);
assert.equal(versions.items.length, detail.versions.length);

const playback = await request(`/api/media/${encodeURIComponent(item.id)}/playback-source`);
assert.ok(["source", "remux", "hls"].includes(playback.preferred));

const sidecars = await request(`/api/media/${encodeURIComponent(item.id)}/sidecars`);
assert.ok(Array.isArray(sidecars.items));

const quality = await request("/api/metadata/quality?issue=missing-probe&page=1&pageSize=12");
assert.ok(quality.counts && Number.isInteger(quality.total));

const compatibility = await request("/api/compatibility?status=ALL&page=1&pageSize=12");
assert.ok(Array.isArray(compatibility.items));
assert.equal(typeof compatibility.jobs.probeToolAvailable, "boolean");
assert.equal(typeof compatibility.jobs.ffmpegToolAvailable, "boolean");

const topics = await request("/api/topics");
assert.deepEqual(
  topics.dimensions.map((dimension) => dimension.type),
  ["actor", "series", "genre", "prefix", "director", "maker", "label"]
);
const actorTopics = await request("/api/topics/actor?page=1&pageSize=12&sort=count");
assert.ok(Array.isArray(actorTopics.items));
assert.equal(actorTopics.pageSize, 12);
const actorTopicsAscending = await request("/api/topics/actor?page=1&pageSize=60&sort=count-asc");
for (let index = 1; index < actorTopicsAscending.items.length; index += 1) {
  const previous = actorTopicsAscending.items[index - 1];
  const current = actorTopicsAscending.items[index];
  if (previous.isFavorite === current.isFavorite) {
    assert.ok(previous.mediaCount <= current.mediaCount, "count-asc topics should increase within each favorite group");
  }
}
const randomActorTopics = await request("/api/topics/actor?page=1&pageSize=12&sort=random&randomSeed=17");
assert.equal(randomActorTopics.items.length, 12);
const prefixTopics = await request("/api/topics/prefix?page=1&pageSize=12&sort=count");
assert.ok(prefixTopics.items.length > 0);
assert.equal(prefixTopics.pageSize, 12);
const prefixEntity = await request(
  `/api/entities/prefix/${encodeURIComponent(prefixTopics.items[0].value)}?page=1&pageSize=12`
);
assert.equal(prefixEntity.entity.type, "prefix");
assert.equal(prefixEntity.entity.value, prefixTopics.items[0].value);
assert.ok(prefixEntity.entity.mediaCount >= prefixEntity.items.length);

const graph = await request("/api/knowledge-graph?types=actor,series,genre,director,maker,label&limit=24&minShared=2");
assert.equal(graph.nodes.length, 24);
assert.ok(graph.edges.length > 0);
assert.ok(Array.isArray(graph.yearDistribution) && graph.yearDistribution.length > 0);
assert.ok(graph.availableYearRange?.min <= graph.availableYearRange?.max);
assert.ok(graph.edges.every((edge) => edge.relationType && edge.relationLabel));

const historicalYearTo = graph.availableYearRange.max - 1;
const historicalGraph = await request(
  `/api/knowledge-graph?types=actor,series,genre,director,maker,label&limit=24&minShared=2&yearFrom=${graph.availableYearRange.min}&yearTo=${historicalYearTo}`
);
assert.ok(historicalGraph.nodes.length > 0);
assert.ok(historicalGraph.nodes.every((node) =>
  !node.latestReleaseDate || Number(node.latestReleaseDate.slice(0, 4)) <= historicalYearTo
));

const graphSource = graph.nodes.find((node) => node.type === "actor") || graph.nodes[0];
const neighborParams = new URLSearchParams({
  sourceType: graphSource.type,
  sourceValue: graphSource.value,
  targetTypes: "actor,series,genre,director,maker,label",
  category: "ALL",
  minShared: "1",
  limit: "12"
});
const graphNeighbors = await request(`/api/knowledge-graph/neighbors?${neighborParams}`);
assert.equal(graphNeighbors.source.id, graphSource.id);
assert.ok(graphNeighbors.nodes.length > 1);
assert.ok(graphNeighbors.edges.length > 0);
assert.ok(graphNeighbors.edges.every((edge) => edge.relationType && edge.relationLabel));
assert.equal(typeof graphNeighbors.pageInfo.hasMore, "boolean");

const graphTarget = graphNeighbors.nodes.find((node) => node.id !== graphSource.id);
assert.ok(graphTarget, "neighbor drill-down should return a target node");
const pathParams = new URLSearchParams({
  sourceType: graphSource.type,
  sourceValue: graphSource.value,
  targetType: graphTarget.type,
  targetValue: graphTarget.value,
  category: "ALL",
  minShared: "1",
  maxDepth: "4"
});
const graphPath = await request(`/api/knowledge-graph/path?${pathParams}`);
assert.equal(graphPath.found, true, "a returned direct neighbor must also be reachable by the path endpoint");
assert.equal(graphPath.path[0], graphSource.id);
assert.equal(graphPath.path.at(-1), graphTarget.id);
assert.equal(graphPath.edges.length, graphPath.path.length - 1);

const connectionParams = new URLSearchParams({
  sourceType: graphSource.type,
  sourceValue: graphSource.value,
  targetType: graphTarget.type,
  targetValue: graphTarget.value,
  category: "ALL",
  limit: "6"
});
const graphConnection = await request(`/api/knowledge-graph/connection?${connectionParams}`);
assert.ok(graphConnection.total >= graphConnection.items.length);
assert.ok(graphConnection.relationType && graphConnection.relationLabel);
assert.equal(typeof graphConnection.pageInfo.hasMore, "boolean");

const actor = detail.item.metadata?.actors?.[0];
if (actor) {
  const entity = await request(`/api/entities/actor/${encodeURIComponent(actor)}?page=1&pageSize=12`);
  assert.equal(entity.entity.value, actor);
  assert.ok(entity.entity.mediaCount >= entity.items.length);
  assert.ok(entity.entity.description.length > 0);
  assert.ok(entity.entity.related && Array.isArray(entity.entity.related.genre));
}

const series = detail.item.metadata?.series;
if (series) {
  const entity = await request(`/api/entities/series/${encodeURIComponent(series)}?page=1&pageSize=12`);
  assert.equal(entity.entity.value, series);
  assert.ok(entity.entity.mediaCount >= entity.items.length);
}

const genre = detail.item.metadata?.genres?.[0];
if (genre) {
  const entity = await request(`/api/entities/genre/${encodeURIComponent(genre)}?page=1&pageSize=12`);
  assert.equal(entity.entity.value, genre);
  assert.ok(entity.entity.mediaCount >= entity.items.length);
}

const smokeName = `__codex_api_smoke_${Date.now()}__`;
let savedFilterId = "";
try {
  const created = await request("/api/saved-filters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: smokeName, query: { category: "JAV", groupVersions: true } })
  });
  savedFilterId = created.id;
  assert.ok(savedFilterId);

  const updated = await request(`/api/saved-filters/${encodeURIComponent(savedFilterId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `${smokeName}-updated`, query: { category: "FC2", groupVersions: true } })
  });
  assert.equal(updated.query.category, "FC2");

  const filters = await request("/api/saved-filters");
  assert.ok(filters.items.some((filter) => filter.id === savedFilterId));
} finally {
  if (savedFilterId) {
    await request(`/api/saved-filters/${encodeURIComponent(savedFilterId)}`, { method: "DELETE" });
  }
}

console.log(JSON.stringify({
  ok: true,
  physicalFiles: ungrouped.total,
  groupedMedia: grouped.total,
  compatibilityItems: compatibility.total,
  qualityItems: quality.total
}, null, 2));
