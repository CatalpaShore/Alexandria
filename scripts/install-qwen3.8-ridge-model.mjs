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
const sourcePath = path.join(root, "models/gguf/qwen3.8-27b-ridge/Qwen3.8-27B-Ridge-3.7bpw.gguf");
const modelfilePath = path.join(root, "runtime/Modelfile.qwen3.8-ridge");
const modelName = (process.env.AMW_AGENT_CHAT_MODEL ?? "qwen3.8-ridge:27b").trim();
const ollamaUrl = new URL(process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435");
const expectedSha256 = "95580dbdaad579582ee898257116abc18d7f3625a00c16a15735d41444a09f5e";

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
    `Missing Ridge GGUF: ${sourcePath}`,
    "Download empero-ai/Qwen3.8-27B-Ridge-GGUF/Qwen3.8-27B-Ridge-3.7bpw.gguf first."
  ].join("\n"));
}

const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk);
const actualSha256 = hash.digest("hex");
if (actualSha256 !== expectedSha256) {
  fail(`Ridge GGUF checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
}

fs.mkdirSync(path.dirname(modelfilePath), { recursive: true });
fs.writeFileSync(modelfilePath, [
  `FROM ${sourcePath}`,
  "PARAMETER num_ctx 16384",
  "PARAMETER temperature 0.7",
  "PARAMETER top_p 0.8",
  "PARAMETER top_k 20",
  "PARAMETER presence_penalty 1.5",
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
