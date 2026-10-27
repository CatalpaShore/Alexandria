import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const root = path.resolve(process.env.AMW_EXTERNAL_AI_ROOT ?? path.resolve(process.env.DATA_DIR ?? ".local/data", "external-ai"));
const markerPath = path.join(root, process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json");
const sourcePath = path.join(root, "models/gguf/ornith-1.5-35b-a3b/Ornith-1.5-35B-Q4_K_M.gguf");
const modelfilePath = path.join(root, "runtime/Modelfile.ornith-1.5-35b-a3b");
const modelName = (process.env.AMW_ORNITH_CHAT_MODEL ?? "ornith1.5:35b-a3b-q4").trim();
const ollamaUrl = new URL(process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435");
const expectedSha256 = "ca6ea26329c88b78ffd90a85163be2e746c2fafd1024f56db47e499f117f9a7f";

function fail(message) {
  console.error(message);
  process.exit(1);
}

let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
} catch {
  fail(`External AI storage is unavailable or uninitialized: ${root}`);
}
if (marker.product !== "alexandria-ai" || !marker.storageId) fail("External AI storage identity is invalid");
if (!fs.existsSync(sourcePath)) {
  fail([
    `Missing Ornith GGUF: ${sourcePath}`,
    "Download ornith-ai/Ornith-1.5-35B-A3B-GGUF/Ornith-1.5-35B-Q4_K_M.gguf first."
  ].join("\n"));
}

const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk);
const actualSha256 = hash.digest("hex");
if (actualSha256 !== expectedSha256) {
  fail(`Ornith GGUF checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
}

fs.mkdirSync(path.dirname(modelfilePath), { recursive: true });
fs.writeFileSync(modelfilePath, [
  `FROM ${sourcePath}`,
  "PARAMETER num_ctx 8192",
  "PARAMETER temperature 0.6",
  "PARAMETER top_p 0.95",
  "PARAMETER top_k 20",
  ""
].join("\n"), { encoding: "utf8", mode: 0o640 });

execFileSync(process.env.OLLAMA_BIN ?? "ollama", ["create", modelName, "-f", modelfilePath], {
  stdio: "inherit",
  env: {
    ...process.env,
    OLLAMA_HOST: ollamaUrl.host,
    OLLAMA_MODELS: path.join(root, "models/ollama")
  }
});

console.log(JSON.stringify({ installed: true, model: modelName, sourcePath, sha256: actualSha256 }, null, 2));
