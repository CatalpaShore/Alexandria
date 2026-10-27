import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDemoRequest } from '../../demo/online/browser-api.mjs';
const root = path.resolve('.local/online-demo/site');
const data = JSON.parse(await fs.readFile(path.join(root, 'demo-data.json')));
const get = (url, method) => resolveDemoRequest(data, url, method);
test('filters, facets, search, pagination and simulated activity agree', () => {
  assert.equal(get('/api/media').body.total, 12);
  assert.equal(get('/api/media?q=Sintel').body.total, 1);
  assert.equal(get('/api/media?q=does-not-exist').body.total, 0);
  assert.equal(get('/api/media?favoriteOnly=true').body.total, 6);
  assert.equal(get('/api/media?playbackState=completed').body.total, 3);
  assert.equal(get('/api/media?playbackState=inProgress').body.total, 5);
  assert.equal(get('/api/media?maker=Blender%20Studio').body.total, 12);
  assert.equal(get('/api/media?actor=Halina%20Reijn').body.total, 1);
  assert.equal(get('/api/media?category=JAV').body.total, 0);
  assert.equal(get('/api/media?pageSize=4&page=2').body.items.length, 4);
  assert.equal(get('/api/media/facets?q=Sintel').body.actors.length, 2);
  assert.equal(get('/api/search/suggestions?q=Halina').body.actors[0].value, 'Halina Reijn');
  assert.equal(get('/api/entities/actor/Halina%20Reijn').body.total, 1);
  assert.equal(get('/api/topics/actor?q=Halina').body.total, 1);
});
test('graph connects the actual shared demonstration films', () => {
  const graph = get('/api/knowledge-graph?types=actor,director&minShared=1').body;
  assert.ok(graph.nodes.length > 10 && graph.edges.length > 0);
  assert.ok(graph.nodes.every(n => ['actor','director'].includes(n.type)));
  const params = 'sourceType=actor&sourceValue=Halina%20Reijn&targetType=director&targetValue=Colin%20Levy';
  assert.equal(get('/api/knowledge-graph/connection?' + params).body.total, 1);
  assert.equal(get('/api/knowledge-graph/path?' + params).body.found, true);
});
test('write and administrator requests cannot access configuration or mutate fixtures', () => {
  const before = JSON.stringify(data);
  for (const method of ['POST','PUT','PATCH','DELETE']) assert.equal(get('/api/favorites', method).status, 403);
  for (const url of ['/api/settings/library-paths','/api/backup','/api/tour','/api/agent/config']) assert.equal(get(url).status, 403);
  assert.equal(JSON.stringify(data), before);
});
test('artifact contains only bundled demo assets, no tours, personal paths or symlinks', async () => {
  const content = JSON.stringify(data);
  assert.doesNotMatch(content, /\/(?:Users|home)\/|sk-[a-zA-Z0-9]{20,}/i);
  assert.equal(data.content, 'non-adult-film-mock');
  assert.equal(Object.keys(data.assets).length, 60);
  for (const file of Object.values(data.assets)) { assert.match(file, /^demo-assets\/[a-zA-Z0-9.-]+$/); assert.ok((await fs.stat(path.join(root,file))).size > 0); }
  for (const directory of ['tour','showcase']) await assert.rejects(fs.access(path.join(root,directory)));
  async function inspect(dir) { for (const entry of await fs.readdir(dir,{withFileTypes:true})) { assert.equal(entry.isSymbolicLink(),false); if(entry.isDirectory()) await inspect(path.join(dir,entry.name)); } }
  await inspect(root);
});
