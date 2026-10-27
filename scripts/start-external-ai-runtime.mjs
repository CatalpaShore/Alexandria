import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectOllamaApi } from "./external-ai-runtime-health.mjs";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const root = path.resolve(process.env.AMW_EXTERNAL_AI_ROOT ?? path.resolve(process.env.DATA_DIR ?? ".local/data", "external-ai"));
const markerPath = path.join(root, process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json");
const expectedStorageId = (process.env.AMW_EXTERNAL_AI_STORAGE_ID ?? "").trim();
let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  fs.accessSync(markerPath, fs.constants.R_OK);
} catch {
  console.error(`Agent runtime not started: external storage is unavailable (${root})`);
  process.exit(2);
}
if (marker.product !== "alexandria-ai" || !marker.storageId || (expectedStorageId && marker.storageId !== expectedStorageId)) {
  console.error("Agent runtime not started: external storage identity mismatch");
  process.exit(3);
}

const host = new URL(process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435");
const chatModel = (process.env.AMW_AGENT_CHAT_MODEL ?? "qwen3.5:9b").trim();
const existing = await inspectOllamaApi(host.origin, [chatModel]);
if (existing.ready) {
  console.log(`Agent runtime is ready at ${host.origin}; ${chatModel} remains unloaded until requested in the curator UI`);
  process.exit(0);
}

const child = spawn(process.env.OLLAMA_BIN ?? "ollama", ["serve"], {
  stdio: "inherit",
  env: {
    ...process.env,
    OLLAMA_HOST: `${host.hostname}:${host.port || "11435"}`,
    OLLAMA_MODELS: path.join(root, "models/ollama"),
    OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? "2m",
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? "1",
    OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS ?? "2"
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Agent runtime failed to launch: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
