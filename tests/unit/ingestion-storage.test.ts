import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertIngestionStorageAccess } from "../../server/src/ingestionStorage";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("ingestion storage preflight", () => {
  it("verifies download and library rename access without leaving probe files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "amw-ingestion-storage-"));
    temporaryRoots.push(root);
    const downloadRoot = path.join(root, "download");
    const libraryRoot = path.join(root, "library");
    await fs.mkdir(downloadRoot);
    await fs.mkdir(libraryRoot);

    await expect(assertIngestionStorageAccess([{
      label: "测试源",
      downloadRoot,
      libraryRoot
    }])).resolves.toBeUndefined();

    expect(await fs.readdir(downloadRoot)).toEqual([]);
    expect(await fs.readdir(libraryRoot)).toEqual([]);
  });

  it("fails before scanning when a configured directory is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "amw-ingestion-storage-"));
    temporaryRoots.push(root);
    const libraryRoot = path.join(root, "library");
    await fs.mkdir(libraryRoot);

    await expect(assertIngestionStorageAccess([{
      label: "离线磁盘",
      downloadRoot: path.join(root, "missing-download"),
      libraryRoot
    }])).rejects.toThrow("自动入库存储预检失败");
  });
});
