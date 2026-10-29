import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { sampleLibrarySource } from "../../server/src/librarySourceSample.js";

it("bounds preview work and does not follow nested directory symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alexandria-sample-"));
  try {
    const media = path.join(root, "media");
    const outside = path.join(root, "outside");
    await fs.mkdir(media); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside.mp4"), "fixture");
    if (process.platform !== "win32") {
      await fs.symlink(outside, path.join(media, "link"), "dir");
      expect(await sampleLibrarySource(media)).toMatchObject({ videos: 0, checked: 1 });
    }
    await Promise.all(Array.from({ length: 305 }, (_, index) => fs.writeFile(path.join(media, `file-${index}.mp4`), "fixture")));
    expect(await sampleLibrarySource(media)).toMatchObject({ checked: 300, limited: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
