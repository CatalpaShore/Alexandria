import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { demoCatalog, demoStem, demoManifestKind } from "./demoCatalog.mjs";

export function demoFileNames() {
  return new Set(demoCatalog.flatMap((film, i) => {
    const base = demoStem(film, i);
    return [base + ".mp4", base + ".media.json", base + "-poster.png", ...["zh", "en", "ja"].map(lang => base + `.${lang}.srt`)];
  }));
}
export async function verifyPublicDemo(root = path.resolve(".local/public-demo")) {
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Demo root cannot be a symbolic link");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "film-manifest.json"), "utf8"));
  const allowed = demoFileNames();
  if (manifest.kind !== demoManifestKind || manifest.files.length !== allowed.size) throw new Error("Invalid public demo manifest");
  const seen = new Set();
  for (const item of manifest.files) {
    if (!allowed.has(item.file) || seen.has(item.file)) throw new Error("Unexpected public demo asset");
    seen.add(item.file);
    const file = path.join(root, "movies", item.file);
    const real = await fs.realpath(file);
    if (real !== file || (await fs.lstat(file)).isSymbolicLink()) throw new Error("Demo assets cannot use symbolic links");
    if (createHash("sha256").update(await fs.readFile(file)).digest("hex") !== item.sha256) throw new Error("Demo asset changed; recreate a clean public demo");
  }
  let count = 0;
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Demo assets cannot use symbolic links");
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
      else { count++; if (!allowed.has(path.relative(path.join(root, "movies"), path.join(dir, entry.name)))) throw new Error("Extra file in public demo library"); }
    }
  }
  await visit(path.join(root, "movies"));
  if (count !== allowed.size) throw new Error("Unexpected public demo file count");
}
