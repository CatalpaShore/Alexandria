import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const model = process.argv[2] ?? "hy-mt1.5:7b-q4";
const root = path.resolve(process.env.AMW_EXTERNAL_AI_ROOT ?? path.resolve(process.env.DATA_DIR ?? ".local/data", "external-ai"));
const markerPath = path.join(root, process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json");
const runtimeDir = path.join(root, "runtime");
const externalHost = process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435";
const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
const expectedStorageId = (process.env.AMW_EXTERNAL_AI_STORAGE_ID ?? "").trim();
if (marker.product !== "alexandria-ai" || !marker.storageId || (expectedStorageId && marker.storageId !== expectedStorageId)) {
  throw new Error("External AI storage marker or identity is invalid");
}
fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
fs.mkdirSync(runtimeDir, { recursive: true });

const modelfile = execFileSync("ollama", ["show", model, "--modelfile"], {
  encoding: "utf8",
  env: { ...process.env, OLLAMA_HOST: "http://127.0.0.1:11434" }
});
const tempPath = path.join(runtimeDir, `migration-${process.pid}.Modelfile`);
try {
  fs.writeFileSync(tempPath, modelfile, { encoding: "utf8", mode: 0o600 });
  execFileSync("ollama", ["create", model, "-f", tempPath], {
    stdio: "inherit",
    env: { ...process.env, OLLAMA_HOST: externalHost }
  });
} finally {
  fs.rmSync(tempPath, { force: true });
}
console.log(`Migrated ${model} to ${externalHost}; the internal rollback copy was retained.`);
