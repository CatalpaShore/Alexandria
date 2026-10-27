import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The generator's integrity policy is shared with its launcher.
import { demoFileNames, verifyPublicDemo } from "../../scripts/lib/publicDemoIntegrity.mjs";
import { createDemoPoster } from "../../scripts/lib/demoArtwork.mjs";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alexandria-demo-integrity-"));
  const files = [];
  for (const file of demoFileNames()) {
    const body = Buffer.from("original-test-fixture");
    await fs.mkdir(path.dirname(path.join(root, "movies", file)), { recursive: true });
    await fs.writeFile(path.join(root, "movies", file), body);
    files.push({ file, sha256: createHash("sha256").update(body).digest("hex") });
  }
  await fs.writeFile(path.join(root, "film-manifest.json"), JSON.stringify({ kind: "alexandria-open-film-mock-v2", files }));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("public demo content integrity", () => {
  it("accepts exactly the generated catalog and deterministic test artwork", async () => {
    await expect(verifyPublicDemo(root)).resolves.toBeUndefined();
    const poster = createDemoPoster(0);
    expect(poster.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(poster.equals(createDemoPoster(0))).toBe(true);
    expect(poster.equals(createDemoPoster(1))).toBe(false);
  });
  it("rejects changed media rather than silently blessing it for publication", async () => {
    await fs.writeFile(path.join(root, "movies", [...demoFileNames()][0]), "changed content");
    await expect(verifyPublicDemo(root)).rejects.toThrow("changed");
  });
  it("rejects additional files that are not part of the non-adult catalog", async () => {
    await fs.writeFile(path.join(root, "movies", "unexpected.mp4"), "extra");
    await expect(verifyPublicDemo(root)).rejects.toThrow("Extra file");
  });
  it("rejects a symlink into another library", async () => {
    const file = path.join(root, "movies", [...demoFileNames()][0]);
    await fs.unlink(file);
    await fs.symlink(path.join(root, "film-manifest.json"), file);
    await expect(verifyPublicDemo(root)).rejects.toThrow("symbolic links");
  });
  it("rejects duplicate manifest entries even when the file count is unchanged", async () => {
    const file = path.join(root, "film-manifest.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.files[1] = manifest.files[0];
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(verifyPublicDemo(root)).rejects.toThrow("Unexpected public demo asset");
  });
});
