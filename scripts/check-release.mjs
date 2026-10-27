import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const git = args => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
const worktree = process.argv.includes("--worktree");
const files = [...new Set(git(worktree ? ["ls-files", "-co", "--exclude-standard", "-z"] : ["ls-files", "-z"]).toString().split("\0").filter(Boolean))].filter(file => !worktree || fs.existsSync(file));
if (!files.length) throw new Error("Stage the public source before checking the release index");
const read = file => worktree ? fs.readFileSync(file) : git(["show", `:${file}`]);
const reviewed = JSON.parse(read("docs/public-assets.json").toString("utf8"));
const failures = [];
const excluded = /(^|\/)(\.local|node_modules|data|media|seed|dist|\.env(?!\.example$)|artifacts|test-results|playwright-report)(\/|$)/;
const binary = /\.(sqlite\w*|db|mp4|mkv|mov|avi|webm|mp3|flac|wav|jpg|jpeg|png|webp|gif|nfo|srt|vtt|ass|ssa|pem|key|p12|jks|keystore|apk|zip|tar|gz)$/i;
let privateTerms = [];
// The private blocklist is operator-owned and never stored in public source.
try {
  privateTerms = JSON.parse(fs.readFileSync(".local/privacy-blocklist.json", "utf8"));
  if (!Array.isArray(privateTerms) || privateTerms.some(term => typeof term !== "string")) {
    throw new Error("Private blocklist must be an array of strings");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const file of files) {
  if (excluded.test(file) || /(imageStudio|image-studio|downloadRecovery|cilimaoSource|xunleiClient)/.test(file)) { failures.push(`${file}: excluded runtime, content or removed module`); continue; }
  const body = read(file);
  if (reviewed[file]) {
    if (!/^(client\/public\/brand-icon\.png|docs\/screenshots\/[a-z-]+\.png|client\/public\/demo\/films\/[a-z0-9-]+\.png|client\/public\/showcase\/[a-z-]+\.png|client\/public\/tour\/(?:product-tour(?:-(?:en|ja))?\.mp4|subtitles-(?:zh|en|ja)\.vtt))$/.test(file) || createHash("sha256").update(body).digest("hex") !== reviewed[file].sha256) failures.push(`${file}: reviewed public asset checksum mismatch`);
    continue;
  }
  if (binary.test(file) || body.includes(0)) { failures.push(`${file}: binary asset needs explicit review and checksum`); continue; }
  const text = body.toString("utf8");
  if (/\/(?:Users|home)\/[^/\s]+\//.test(text) || /[A-Z]:\\Users\\[^\\\s]+\\/i.test(text) || /\/Volumes\/(?:[a-z]+\d+-\w{6,}|[^/\s]*(?:serial|device-id)[^/\s]*)/i.test(text)) failures.push(`${file}: private machine path`);
  if (privateTerms.some(term => typeof term === "string" && term.length > 2 && (text.toLowerCase().includes(term.toLowerCase()) || file.toLowerCase().includes(term.toLowerCase())))) failures.push(`${file}: private identifier from local blocklist`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/.test(text) || /\bAKIA[A-Z0-9]{16}\b/.test(text)) failures.push(`${file}: possible credential`);
  if (path.basename(file) === "productIntroductionSnapshot.json" && (/https?:\/\//.test(text) || !text.includes('"actorAssetCount": 0'))) failures.push(`${file}: demo snapshot requires review`);
}
for (const file of Object.keys(reviewed)) if (!files.includes(file)) failures.push(`${file}: reviewed asset missing from publication`);
if (failures.length) throw new Error(failures.join("\n"));
console.log(`Public ${worktree ? "working tree" : "release index"} passed: ${files.length} files; reviewed brand, licensed film artwork, screenshots and tour assets only; no runtime data, private paths or known credential patterns.`);
