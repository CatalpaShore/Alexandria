import fs from "node:fs";
import { execFileSync } from "node:child_process";

const git = args => execFileSync("git", args, { maxBuffer: 128 * 1024 * 1024 });
let privateTerms = [];
try {
  privateTerms = JSON.parse(fs.readFileSync(".local/privacy-blocklist.json", "utf8"));
  if (!Array.isArray(privateTerms) || privateTerms.some(value => typeof value !== "string")) {
    throw new Error("Private blocklist must be an array of strings");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const issues = [];
function inspect(text, object) {
  if (privateTerms.some(term => term.length > 2 && text.toLowerCase().includes(term.toLowerCase()))) {
    issues.push(`${object}: private identifier matched (value redacted)`);
  } else if (/\/(?:Users|home)\/[^/\s]+\//.test(text) || /[A-Z]:\\Users\\[^\\\s]+\\/i.test(text)) {
    issues.push(`${object}: personal home path`);
  } else if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/.test(text)) {
    issues.push(`${object}: possible credential`);
  }
}
let blobs = 0;
const objects = git(["rev-list", "--objects", "--all", "--no-object-names"]).toString().trim().split("\n").filter(Boolean);
for (const object of new Set(objects)) {
  if (git(["cat-file", "-t", object]).toString().trim() !== "blob") continue;
  blobs++;
  const body = git(["cat-file", "blob", object]);
  if (!body.includes(0)) inspect(body.toString("utf8"), object.slice(0, 12));
}
const commits = git(["log", "--all", "--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x00"]).toString().split("\0\n").filter(entry => entry.trim());
for (const entry of commits) {
  const [hash, ...metadata] = entry.trimStart().split("\0");
  inspect(metadata.join("\n"), hash.slice(0, 12));
}
if (issues.length) {
  console.error(`Git history privacy check failed: ${issues.length} finding(s) across ${blobs} blobs. Current-file checks do not remove historical content.`);
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Git history text check passed: ${blobs} blobs, ${commits.length} commits. Historical binary assets require separate visual review.`);
}
