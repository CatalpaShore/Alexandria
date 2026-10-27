import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

export async function readEnvironment(root, inherited = process.env) {
  const text = await fs.readFile(path.join(root, ".env"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { ...parseEnv(text), ...inherited };
}

export function checkTools() {
  return [
    { name: "Node.js 22+", ok: Number(process.versions.node.split(".")[0]) >= 22 },
    ...["ffmpeg", "ffprobe"].map(name => ({ name, ok: spawnSync(name, ["-version"], { stdio: "ignore", timeout: 10_000 }).status === 0 }))
  ];
}

export async function inspectSource(input) {
  if (!path.isAbsolute(input)) throw new Error("ABSOLUTE_PATH_REQUIRED");
  const root = path.resolve(input);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("DIRECTORY_REQUIRED");
  const queue = [root];
  let checked = 0, video = 0, subtitles = 0, metadata = 0;
  // Bounded read-only sample. It never follows nested symlinks or touches file contents.
  while (queue.length && checked < 300) {
    const dir = await fs.opendir(queue.shift());
    for await (const item of dir) {
      if (++checked > 300) break;
      if (item.isDirectory()) queue.push(path.join(dir.path, item.name));
      if (!item.isFile()) continue;
      if (/\.(mp4|mkv|mov|avi|webm|wmv|m4v|mpg|mpeg|ts)$/i.test(item.name)) video++;
      if (/\.(srt|ass|ssa|vtt)$/i.test(item.name)) subtitles++;
      if (/\.nfo$|\.media\.json$/i.test(item.name)) metadata++;
    }
  }
  return { root, checked: Math.min(checked, 300), video, subtitles, metadata, limited: checked >= 300 || queue.length > 0 };
}

export async function planSetup(root, inputs, inherited = process.env) {
  const env = await readEnvironment(root, inherited);
  const dataDir = path.resolve(root, env.DATA_DIR || ".local/data");
  const sources = await Promise.all(inputs.map(inspectSource));
  if (!sources.length || sources.length > 32) throw new Error("SOURCE_COUNT");
  const identities = new Set(await Promise.all(sources.map(source => fs.realpath(source.root))));
  if (identities.size !== sources.length) throw new Error("DUPLICATE_SOURCE");
  const realSources = [...identities];
  // Avoid indexing this application's own state, models, or backup files as media.
  // Resolve existing ancestors too: a fresh data directory can sit below a
  // symlinked parent (for example a system temporary directory).
  async function realLocation(target) {
    try { return await fs.realpath(target); }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(target) === target) throw error;
      return path.join(await realLocation(path.dirname(target)), path.basename(target));
    }
  }
  const realData = await realLocation(dataDir);
  if (realSources.some(source => {
    const relative = path.relative(source, realData);
    const reverse = path.relative(realData, source);
    return [relative, reverse].some(part => part === "" || (!part.startsWith(".." + path.sep) && part !== ".." && !path.isAbsolute(part)));
  })) throw new Error("DATA_INSIDE_SOURCE");
  return { root, dataDir, env, sources, target: path.join(dataDir, "library-sources.json") };
}

export async function initializeLibrary(plan) {
  const exists = async file => fs.stat(file).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; });
  const database = path.resolve(plan.root, plan.env.AMW_DATABASE_PATH || path.join(plan.dataDir, "media-wall.sqlite"));
  if (plan.env.AMW_DEMO_MODE === "true" || plan.env.MEDIA_SOURCES?.trim() || plan.env.MEDIA_ROOTS?.trim() || plan.env.MEDIA_LIBRARY_ROOTS?.trim()
    || (plan.env.MEDIA_ROOT?.trim() && path.resolve(plan.root, plan.env.MEDIA_ROOT.trim()) !== path.join(plan.root, "media"))
    || await exists(database) || await exists(plan.target) || await exists(path.join(plan.dataDir, "library-config.json"))) {
    throw new Error("EXISTING_LIBRARY");
  }
  await fs.mkdir(plan.dataDir, { recursive: true, mode: 0o700 });
  const sources = plan.sources.map((source, index) => ({ category: "LOCAL", name: `Library-${index + 1}`, root: source.root }));
  // Exclusive creation: never truncate a configuration created by another process.
  const handle = await fs.open(plan.target, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ sources, updatedAt: new Date().toISOString() }, null, 2) + "\n"); }
  catch (error) { await handle.close(); await fs.unlink(plan.target); throw error; }
  await handle.close();
  try {
    await fs.copyFile(path.join(plan.root, ".env.example"), path.join(plan.root, ".env"), 1 /* COPYFILE_EXCL */);
    await fs.chmod(path.join(plan.root, ".env"), 0o600);
  } catch (error) { if (error.code !== "EEXIST") { await fs.unlink(plan.target); throw error; } }
  return sources;
}
