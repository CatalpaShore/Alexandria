import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filesAreIdentical,
  normalizeIngestionFilename,
  resolveIngestionTarget
} from "../../server/src/ingestionFiles";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "amw-ingestion-files-"));
  temporaryRoots.push(root);
  return root;
}

describe("ingestion duplicate resolution", () => {
  it("compares complete file content instead of trusting names or sizes", async () => {
    const root = await fixtureRoot();
    const left = path.join(root, "left.mp4");
    const equal = path.join(root, "equal.mp4");
    const different = path.join(root, "different.mp4");
    await Promise.all([
      fs.writeFile(left, Buffer.from("same-content")),
      fs.writeFile(equal, Buffer.from("same-content")),
      fs.writeFile(different, Buffer.from("diff-content"))
    ]);

    await expect(filesAreIdentical(left, equal)).resolves.toBe(true);
    await expect(filesAreIdentical(left, different)).resolves.toBe(false);
  });

  it("keeps an exact duplicate out of the library", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "download.mp4");
    const target = path.join(root, "ABP-123.mp4");
    await Promise.all([fs.writeFile(source, "duplicate"), fs.writeFile(target, "duplicate")]);
    const candidate = normalizeIngestionFilename("ABP-123.mp4", new Set(["ABP"]));
    expect(candidate).not.toBeNull();

    await expect(resolveIngestionTarget(source, target, candidate!)).resolves.toMatchObject({
      kind: "duplicate",
      targetPath: target,
      normalizedName: "ABP-123.mp4"
    });
  });

  it("adds a numbered suffix for a different JAV segment while preserving the metadata code", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "download.mp4");
    const target = path.join(root, "ABP-123-C.mp4");
    await Promise.all([fs.writeFile(source, "new-segment"), fs.writeFile(target, "existing-seg")]);
    const candidate = normalizeIngestionFilename("ABP-123-C.mp4", new Set(["ABP"]));
    expect(candidate?.normalizedCode).toBe("ABP-123");

    await expect(resolveIngestionTarget(source, target, candidate!)).resolves.toMatchObject({
      kind: "available",
      normalizedName: "ABP-123-2-C.mp4",
      segment: 2
    });
    expect(candidate?.normalizedCode).toBe("ABP-123");
  });

  it("increments an FC2 part suffix without changing its metadata code", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "download.mp4");
    const target = path.join(root, "FC2-PPV-1234567-1.mp4");
    await Promise.all([fs.writeFile(source, "new-part"), fs.writeFile(target, "firstprt")]);
    const candidate = normalizeIngestionFilename("FC2-PPV-1234567.mp4", new Set());

    await expect(resolveIngestionTarget(source, target, candidate!)).resolves.toMatchObject({
      kind: "available",
      normalizedName: "FC2-PPV-1234567-2.mp4",
      segment: 2
    });
    expect(candidate?.normalizedCode).toBe("FC2-PPV-1234567");
  });
});
