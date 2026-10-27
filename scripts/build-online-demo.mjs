import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const output = path.resolve('.local/online-demo/site');
const base = process.env.DEMO_BASE_PATH || '/Alexandria/';
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw Error('DEMO_BASE_PATH must be / or a slash-delimited repository path');
const run = (file, args) => execFileSync(file, args, { cwd: root, stdio: 'inherit' });
run(process.execPath, ['scripts/create-demo.mjs', '--public']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--base', base, '--outDir', output]);
// The adult-library tour must never be part of the non-adult hosted artifact.
await fs.rm(path.join(output, 'tour'), { recursive: true, force: true });
await fs.rm(path.join(output, 'showcase'), { recursive: true, force: true });
run(process.execPath, ['scripts/export-online-demo.mjs']);
for (const file of ['browser-api.mjs','demo-worker.js','bootstrap.mjs']) await fs.copyFile(path.join(root, 'demo/online', file), path.join(output, file));
let html = await fs.readFile(path.join(output, 'index.html'), 'utf8');
const entry = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
if (!entry) throw Error('Vite entry script was not found');
const revision = createHash('sha256').update(await fs.readFile(path.join(output, 'demo-data.json'))).update(await fs.readFile('demo/online/demo-worker.js')).update(await fs.readFile('demo/online/browser-api.mjs')).digest('hex').slice(0,16);
html = html.replace(entry[0], `<script type="module" src="${base}bootstrap.mjs" data-entry="${entry[1]}" data-revision="${revision}"></script>`);
html = html.replace(/<title>.*?<\/title>/, '<title>Alexandria · Non-adult interactive demo</title>');
await fs.writeFile(path.join(output, 'index.html'), html);
await fs.writeFile(path.join(output, '.nojekyll'), '');
await fs.writeFile(path.join(output, 'demo-build.json'), JSON.stringify({ content: 'non-adult-film-mock', base, revision }));
console.log(`Static non-adult demo ready: ${path.relative(root, output)} (base ${base})`);
