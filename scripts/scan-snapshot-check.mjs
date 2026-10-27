import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-snapshot-check-"));
const sourceOne = path.join(root, "source-one");
const sourceTwo = path.join(root, "source-two");
const nested = path.join(sourceOne, "A");
const dataDir = path.join(root, "data");
fs.mkdirSync(nested, { recursive: true });
fs.mkdirSync(sourceTwo, { recursive: true });
fs.writeFileSync(path.join(nested, "ABC-123.mp4"), "first");

process.env.DATA_DIR = dataDir;
process.env.MEDIA_SOURCES = `JAV:Fixture=${sourceOne}`;

const [{ scanMediaLibrary }, { db }] = await Promise.all([
  import("../dist/server/scanner.js"),
  import("../dist/server/db.js")
]);

try {
  const initial = await scanMediaLibrary();
  assert.equal(initial.scanMode, "full");
  assert.equal(initial.indexed, 1);
  assert.equal(initial.removed, 0);
  assert.ok(fs.existsSync(path.join(dataDir, "scan-snapshots.json")));

  const incremental = await scanMediaLibrary();
  assert.equal(incremental.scanMode, "incremental");
  assert.equal(incremental.indexed, 1);
  assert.ok(incremental.directoriesSkipped >= 2);

  const originalDirectoryTime = fs.statSync(nested).mtime;
  fs.writeFileSync(path.join(nested, "ABC-123.mp4"), "updated fixture");
  fs.utimesSync(nested, originalDirectoryTime, originalDirectoryTime);
  const modified = await scanMediaLibrary();
  assert.equal(modified.scanMode, "incremental");
  assert.equal(modified.changed, 1);

  fs.writeFileSync(path.join(nested, "XYZ-999.mp4"), "second");
  const added = await scanMediaLibrary();
  assert.equal(added.indexed, 2);
  assert.equal(added.changed, 1);

  fs.unlinkSync(path.join(nested, "ABC-123.mp4"));
  const deleted = await scanMediaLibrary();
  assert.equal(deleted.indexed, 1);
  assert.equal(deleted.removed, 1);

  fs.writeFileSync(path.join(sourceTwo, "NEW-001.mp4"), "replacement source");
  process.env.MEDIA_SOURCES = `JAV:Fixture=${sourceTwo}`;
  const sourceChanged = await scanMediaLibrary();
  assert.equal(sourceChanged.scanMode, "full");
  assert.equal(sourceChanged.fullScanReason, "source-configuration-changed");
  assert.equal(sourceChanged.indexed, 1);
  assert.equal(sourceChanged.removed, 1);
  const current = db.prepare("SELECT absolute_path AS absolutePath FROM media_files").all();
  assert.deepEqual(current, [{ absolutePath: path.join(sourceTwo, "NEW-001.mp4") }]);

  const forced = await scanMediaLibrary({ forceFull: true });
  assert.equal(forced.scanMode, "full");
  assert.equal(forced.fullScanReason, "forced");

  const periodic = await scanMediaLibrary({ fullScanIntervalMs: 0 });
  assert.equal(periodic.scanMode, "full");
  assert.equal(periodic.fullScanReason, "periodic-validation-due");

  fs.writeFileSync(path.join(dataDir, "scan-snapshots.json"), "not-json");
  const recovered = await scanMediaLibrary();
  assert.equal(recovered.scanMode, "full");
  assert.equal(recovered.fullScanReason, "snapshot-invalid");
  assert.equal(recovered.indexed, 1);

  process.env.MEDIA_SOURCES = `JAV:Fixture=${path.join(root, "unmounted-source")}`;
  await assert.rejects(scanMediaLibrary());
  const afterUnavailableSource = db.prepare("SELECT absolute_path AS absolutePath FROM media_files").all();
  assert.deepEqual(afterUnavailableSource, [{ absolutePath: path.join(sourceTwo, "NEW-001.mp4") }]);

  process.env.MEDIA_SOURCES = `JAV:Fixture=${sourceTwo};JAV:Offline=${path.join(root, "unmounted-source")}`;
  const partial = await scanMediaLibrary();
  assert.equal(partial.indexed, 1);
  assert.equal(partial.snapshotSaved, false);
  assert.equal(partial.roots.find((entry) => entry.name === "JAV:Offline")?.state, "missing");
  const afterPartialScan = db.prepare("SELECT absolute_path AS absolutePath FROM media_files").all();
  assert.deepEqual(afterPartialScan, [{ absolutePath: path.join(sourceTwo, "NEW-001.mp4") }]);

  console.log(JSON.stringify({
    ok: true,
    initialMode: initial.scanMode,
    skippedDirectories: incremental.directoriesSkipped,
    modificationDetected: modified.changed,
    deletionDetected: deleted.removed,
    sourceChangeCleanup: sourceChanged.removed,
    forcedValidation: forced.fullScanReason,
    periodicValidation: periodic.fullScanReason,
    invalidSnapshotFallback: recovered.fullScanReason,
    unavailableSourcePreservedIndex: true,
    partialSourceScan: true
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
