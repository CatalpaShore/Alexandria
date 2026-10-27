import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) continue;
  const value = process.argv[index + 1];
  if (value && !value.startsWith("--")) {
    args.set(key, value);
    index += 1;
  } else {
    args.set(key, "true");
  }
}

const volume = args.get("--volume") ?? "";
const storageId = args.get("--storage-id")?.trim();
const confirm = args.get("--confirm") === "INITIALIZE_ALEXANDRIA_AI";
const updateEnv = args.get("--update-env") === "true";
const mountPoint = path.join("/Volumes", volume);
const root = path.join(mountPoint, "AdultMediaWallAI");
const markerPath = path.join(root, ".alexandria-ai-volume.json");
const directories = [
  "agent/db",
  "agent/index",
  "agent/cache",
  "agent/logs",
  "agent/tmp",
  "models/ollama",
  "models/translation",
  "runtime"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!volume || path.basename(volume) !== volume || volume === "." || volume === "..") {
  fail("--volume must be one mounted volume name, without slashes or path traversal");
}

if (!fs.existsSync(mountPoint)) fail(`Volume is not mounted: ${mountPoint}`);
const mountStat = fs.statSync(mountPoint);
if (!mountStat.isDirectory()) fail(`Mount point is not a directory: ${mountPoint}`);
fs.accessSync(mountPoint, fs.constants.R_OK | fs.constants.W_OK);
if (!storageId) fail("Pass the verified volume UUID with --storage-id");
try {
  const diskInfo = execFileSync("diskutil", ["info", mountPoint], { encoding: "utf8" });
  const actualStorageId = diskInfo.match(/^\s*Volume UUID:\s*(\S+)\s*$/m)?.[1] ?? "";
  if (!actualStorageId || actualStorageId !== storageId) {
    fail(`Volume UUID mismatch: expected ${storageId}, detected ${actualStorageId || "unknown"}`);
  }
} catch (error) {
  fail(`Unable to verify volume UUID for ${mountPoint}`);
}

const plan = {
  mountPoint,
  root,
  markerPath,
  storageId,
  directories: directories.map((entry) => path.join(root, entry)),
  updateEnv
};

if (!confirm) {
  console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
  console.log("Re-run with --confirm INITIALIZE_ALEXANDRIA_AI to create these paths.");
  process.exit(0);
}

fs.mkdirSync(root, { recursive: true, mode: 0o750 });
for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o750 });

const marker = {
  product: "alexandria-ai",
  version: 1,
  storageId,
  volumeName: volume,
  initializedAt: new Date().toISOString()
};
const markerTemp = `${markerPath}.tmp-${process.pid}`;
fs.writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
fs.renameSync(markerTemp, markerPath);

if (updateEnv) {
  const envPath = path.resolve(".env");
  const updates = new Map([
    ["AMW_AGENT_ENABLED", "true"],
    ["AMW_EXTERNAL_AI_ROOT", root],
    ["AMW_EXTERNAL_AI_STORAGE_ID", storageId],
    ["AMW_AGENT_OLLAMA_URL", "http://127.0.0.1:11435"],
    ["AMW_AGENT_CHAT_MODEL", "qwen3.5:9b"],
    ["AMW_AGENT_EMBEDDING_MODEL", "qwen3-embedding:0.6b"],
    ["AMW_AGENT_TRANSLATION_MODEL", "qwen3.8-ridge:27b"],
    ["AMW_TRANSLATION_EXTERNALIZED", "true"],
    ["SUBTITLE_CONTEXTUAL_TRANSLATION_URL", "http://127.0.0.1:11435"],
    ["SUBTITLE_CONTEXTUAL_TRANSLATION_MODEL", "qwen3.8-ridge:27b"],
    ["SUBTITLE_ASR_CORRECTION_MODEL", "qwen3.8-ridge:27b"],
    ["SUBTITLE_DEDICATED_TRANSLATION_MODEL", "hy-mt1.5:7b-q4"]
  ]);
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = existing.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !updates.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates.get(match[1])}`;
  });
  for (const [key, value] of updates) if (!seen.has(key)) next.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`, "utf8");
}

console.log(JSON.stringify({ initialized: true, ...plan, marker }, null, 2));
