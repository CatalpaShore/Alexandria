import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { config } from "../../server/src/config";
import { runStorageRecoveryCheck } from "../../server/src/storageRecovery";

it("checks the newly saved media source without a server restart", async () => {
  const sourceFile = path.join(config.dataDir, "library-sources.json");
  const root = path.join(config.dataDir, "new-library");
  fs.writeFileSync(sourceFile, JSON.stringify({ sources: [{ category: "LOCAL", name: "Library", root }] }));
  expect((await runStorageRecoveryCheck()).allReady).toBe(false);
  fs.mkdirSync(root);
  const ready = await runStorageRecoveryCheck();
  expect(ready.allReady).toBe(true);
  expect(ready.sources[0].root).toBe(root);
  const secondRoot = path.join(config.dataDir, "other-library");
  fs.mkdirSync(secondRoot);
  fs.writeFileSync(sourceFile, JSON.stringify({ sources: [{ category: "LOCAL", name: "Other", root: secondRoot }] }));
  expect((await runStorageRecoveryCheck()).sources[0].root).toBe(secondRoot);
});
