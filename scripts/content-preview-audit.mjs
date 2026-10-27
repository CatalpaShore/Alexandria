import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const readyOnly = process.argv.includes("--ready-only");
const verifyHashes = process.argv.includes("--hash");
const [{ db }, { config }, previews] = await Promise.all([
  import("../server/src/db.ts"),
  import("../server/src/config.ts"),
  import("../server/src/contentPreviews.ts")
]);

function isInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const storage = previews.inspectContentPreviewStorage();
if (!storage.ready) throw new Error(storage.message);

const rows = db.prepare(`
  SELECT media.*,
    story.content_status AS contentStatus,
    story.content_manifest_path AS manifestPath,
    story.content_bytes AS contentBytes,
    story.content_version AS contentVersion,
    story.content_source_signature AS sourceSignature,
    story.content_error AS contentError
  FROM media_files media
  LEFT JOIN media_storyboards story ON story.media_id = media.id
  WHERE media.media_type = 'video'
  ORDER BY media.source_name, media.relative_path, media.id
`).all();

const counts = { total: rows.length, ready: 0, pending: 0, failed: 0, missing: 0 };
const issues = [];
let issueTotal = 0;
let checkedAssets = 0;
let checkedBytes = 0;
let verifiedHashes = 0;

function issue(media, code, detail) {
  issueTotal += 1;
  if (issues.length < 200) {
    issues.push({
      mediaId: media.id,
      code: media.normalized_code || media.basename,
      source: media.source_name,
      issue: code,
      detail
    });
  }
}

try {
  for (const media of rows) {
    const status = media.contentStatus || "missing";
    if (status !== "ready") {
      if (status === "pending") counts.pending += 1;
      else if (status === "failed") counts.failed += 1;
      else counts.missing += 1;
      if (!readyOnly) issue(media, `status-${status}`, media.contentError || "Content preview is incomplete");
      continue;
    }
    counts.ready += 1;
    if (!media.manifestPath || !isInsideRoot(config.contentPreview.root, media.manifestPath)) {
      issue(media, "unsafe-manifest-path", media.manifestPath || "empty path");
      continue;
    }
    if (!fs.existsSync(media.manifestPath)) {
      issue(media, "missing-manifest", media.manifestPath);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(media.manifestPath, "utf8"));
    } catch (error) {
      issue(media, "invalid-manifest", error instanceof Error ? error.message : String(error));
      continue;
    }
    const computedSignature = previews.createContentPreviewSourceSignature(media, media.duration_seconds || manifest.durationSeconds || 0);
    if (manifest.mediaId !== media.id) issue(media, "manifest-media-mismatch", String(manifest.mediaId));
    if (manifest.version !== config.contentPreview.profileVersion || media.contentVersion !== config.contentPreview.profileVersion) {
      issue(media, "profile-version-mismatch", `${manifest.version}/${media.contentVersion}`);
    }
    if (manifest.sourceSignature !== media.sourceSignature || manifest.sourceSignature !== computedSignature) {
      issue(media, "source-signature-mismatch", `${manifest.sourceSignature}/${media.sourceSignature}/${computedSignature}`);
    }
    if (!Array.isArray(manifest.photos) || manifest.photos.length !== 9) {
      issue(media, "photo-count", String(manifest.photos?.length ?? "missing"));
    }
    if (!Array.isArray(manifest.gifs) || manifest.gifs.length !== 3) {
      issue(media, "gif-count", String(manifest.gifs?.length ?? "missing"));
    }
    const assets = [...(manifest.photos || []), ...(manifest.gifs || [])];
    let bundleBytes = 0;
    for (const asset of assets) {
      const assetPath = path.join(path.dirname(media.manifestPath), asset.file || "");
      if (path.basename(asset.file || "") !== asset.file || !isInsideRoot(config.contentPreview.root, assetPath)) {
        issue(media, "unsafe-asset-path", String(asset.file));
        continue;
      }
      if (!fs.existsSync(assetPath)) {
        issue(media, "missing-asset", String(asset.file));
        continue;
      }
      const stat = fs.statSync(assetPath);
      checkedAssets += 1;
      checkedBytes += stat.size;
      bundleBytes += stat.size;
      if (!stat.isFile() || stat.size <= 0 || stat.size !== asset.bytes) {
        issue(media, "asset-size-mismatch", `${asset.file}:${stat.size}/${asset.bytes}`);
      }
      if (verifyHashes) {
        verifiedHashes += 1;
        const actualHash = sha256(assetPath);
        if (actualHash !== asset.sha256) issue(media, "asset-hash-mismatch", String(asset.file));
      }
    }
    if (bundleBytes !== manifest.totalBytes || bundleBytes !== media.contentBytes) {
      issue(media, "bundle-size-mismatch", `${bundleBytes}/${manifest.totalBytes}/${media.contentBytes}`);
    }
  }
} finally {
  if (db.open) db.close();
}

const result = {
  ...counts,
  completionPercent: counts.total > 0 ? Math.round((counts.ready / counts.total) * 10_000) / 100 : 0,
  checkedAssets,
  checkedBytes,
  verifiedHashes,
  issueCount: issueTotal,
  issues,
  readyOnly,
  verifyHashes
};
console.log("CONTENT_PREVIEW_AUDIT_RESULT");
console.log(JSON.stringify(result, null, 2));
if (issueTotal > 0) process.exitCode = 1;
