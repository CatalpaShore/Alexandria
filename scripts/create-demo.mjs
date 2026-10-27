import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { demoCatalog as examples, demoStem, demoManifestKind } from "./lib/demoCatalog.mjs";
import { createHash } from "node:crypto";

import { demoFileNames, verifyPublicDemo } from "./lib/publicDemoIntegrity.mjs";
const publicDemo = process.argv.includes("--public");
const root = path.resolve(publicDemo ? ".local/public-demo/movies" : ".local/demo-media");
const ensureDirectory = async dir => {
  await fs.mkdir(dir, { recursive: true });
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("Demo directories cannot be symbolic links");
};
if (publicDemo) {
  try { await fs.access(root); await verifyPublicDemo(); }
  catch (error) { if (error.code !== "ENOENT") throw error; if (await fs.readdir(root).then(files => files.length > 0).catch(() => false)) throw new Error("Public demo media exists without a valid manifest; use a fresh directory"); }
}
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  throw new Error(
    "Install FFmpeg before generating the optional demo library.",
  );
}
await ensureDirectory(path.dirname(root));
await ensureDirectory(root);
for (let i = 0; i < examples.length; i++) {
  const film = examples[i];
  const { title, collection, tags, director, actors, year, summary, artwork } = film;
  const base = "213447", accent = "d6ac68";
  const dir = path.join(root, collection);
  await ensureDirectory(dir);
  const file = path.join(
    dir,
    path.basename(demoStem(film, i)) + ".mp4",
  );
  try {
    await fs.access(file);
  } catch {
    const vf =
      "drawbox=x=" +
      (100 + i * 19) +
      ":y=80:w=180:h=350:color=0x" +
      accent +
      ":t=fill,drawbox=x=0:y=380:w=960:h=160:color=0x" +
      accent +
      "@0.25:t=fill,drawbox=x=580:y=160:w=240:h=240:color=0x" +
      accent +
      "@0.35:t=fill";
    execFileSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x" + base + ":s=960x540:r=12:d=12",
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        file,
      ],
      { stdio: "inherit" },
    );
  }
  await fs.writeFile(
    file.slice(0, -4) + ".media.json",
    JSON.stringify(
      {
        title,
        description:
          summary + "\n\n[DEMO] 真实非成人电影资料；播放的是 12 秒原创兼容测试片，并非电影正片。\n图片：" + artwork.attribution + " · " + artwork.license + "\n来源：" + film.source + "\n授权：" + artwork.licenseUrl,
        collection,
        tags,
        people: actors,
        director, studio: film.studio,
        year,
      },
      null,
      2,
    ),
  );
  const poster = await fs.readFile(path.join("client/public/demo/films", artwork.file)).catch(() => fs.readFile(path.join("dist/client/demo/films", artwork.file)));
  if (createHash("sha256").update(poster).digest("hex") !== artwork.sha256) throw new Error("Bundled film artwork checksum mismatch");
  await fs.writeFile(file.slice(0, -4) + "-poster.png", poster);
  for (const [lang, lines] of Object.entries({
    zh: ["真实电影资料 · 界面展示", "这是原创兼容测试片，并非电影正片。"],
    en: ["Real film metadata · interface demo", "Original compatibility test clip, not the actual film."],
    ja: ["実在の映画情報 · 画面デモ", "互換性テスト用の映像です。映画本編ではありません。"]
  })) await fs.writeFile(file.slice(0, -4) + `.${lang}.srt`, `1\n00:00:00,000 --> 00:00:05,000\n${lines[0]}\n\n2\n00:00:05,000 --> 00:00:11,500\n${lines[1]}\n`);
}
const generated = [];
async function visit(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Demo media cannot contain symbolic links");
    if (entry.isDirectory()) await visit(file);
    else generated.push({ file: path.relative(root, file), sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
  }
}
await visit(root);
if (publicDemo) {
  // Refuse additional content rather than silently publishing operator files.
  const allowed = demoFileNames();
  if (generated.some(item => !allowed.has(item.file)) || generated.length !== allowed.size) throw new Error("Public demo directory contains unexpected content; use a fresh demo directory");
  await fs.writeFile(path.resolve(".local/public-demo/film-manifest.json"), JSON.stringify({ kind: demoManifestKind, files: generated }, null, 2));
} else {
  const env = "PORT=4310\nDATA_DIR=.local/data\nMEDIA_SOURCES=LOCAL:Demo=" + root + "\nAMW_LAN_MODE=false\nAMW_LAN_AUTH=true\nSCAN_ON_START=true\nSCAN_START_DELAY_MS=0\nAMW_AGENT_ENABLED=false\nMETADATA_AUTO_ENRICH=false\nSUBTITLE_AUTO_TRANSLATE_FAVORITES=false\n";
  try { await fs.writeFile(".env", env, { flag: "wx", mode: 0o600 }); console.log("Created private .env for the demo library."); }
  catch (error) { if (error.code !== "EEXIST") throw error; console.log("Existing .env preserved. Add the demo folder in Settings: " + root); }
}
console.log(`Prepared ${examples.length} real non-adult film records, licensed local artwork and original test clips. No network access is needed.`);
