import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDemoPoster } from "./lib/demoArtwork.mjs";

if (process.env.AMW_DEMO_MODE === "true") throw new Error("Adult metadata examples cannot be added to public Demo");
const catalog = JSON.parse(await fs.readFile("examples/adult-metadata/catalog.json", "utf8"));
const root = path.resolve(".local/adult-metadata-example");
await fs.mkdir(root, { recursive: true });
if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Example directory cannot be a symbolic link");
for (const [index, item] of catalog.items.entries()) {
  const base = path.join(root, item.code);
  try { await fs.access(base + ".mp4"); }
  catch {
    execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${["304353","524536","3a4e44"][index]}:s=960x540:r=12:d=8`, "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", base + ".mp4"], { stdio: "inherit" });
  }
  await fs.writeFile(base + "-poster.png", createDemoPoster(index));
  // Minimal facts only; source pages' descriptions, covers and movie files are not copied.
  await fs.writeFile(base + ".nfo", `<?xml version="1.0" encoding="UTF-8"?><movie><title>${item.displayTitle}</title><plot>真实作品的最小文字字段示例；本地播放内容为原创色块测试视频，不是该作品；图片为原创抽象示意图。</plot><actor><name>${item.actors[0]}</name></actor><studio>${item.maker}</studio><premiered>${item.releaseDate}</premiered><tag>文字元数据示例</tag><set>成人作品档案示例</set></movie>`);
}
console.log("Generated 3 metadata-only examples with original non-explicit placeholder art/video. Add .local/adult-metadata-example as a private source; public Demo never imports it.");
