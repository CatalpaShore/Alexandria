import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectOllamaApi } from "./external-ai-runtime-health.mjs";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeScript = path.join(projectRoot, "scripts/start-external-ai-runtime.mjs");
const enabled = (process.env.AMW_AGENT_ENABLED ?? "false").trim().toLowerCase() !== "false";
const root = path.resolve(process.env.AMW_EXTERNAL_AI_ROOT ?? path.resolve(process.env.DATA_DIR ?? ".local/data", "external-ai"));
const markerPath = path.join(root, process.env.AMW_EXTERNAL_AI_MARKER_FILE ?? ".alexandria-ai-volume.json");
const expectedStorageId = (process.env.AMW_EXTERNAL_AI_STORAGE_ID ?? "").trim();
const ollamaUrl = (process.env.AMW_AGENT_OLLAMA_URL ?? "http://127.0.0.1:11435").replace(/\/+$/, "");
const chatModel = (process.env.AMW_AGENT_CHAT_MODEL ?? "qwen3.5:9b").trim();
const launchAgentLabel = "org.alexandria.public-agent-runtime";
const launchAgentPlist = path.join(os.homedir(), "Library/LaunchAgents", `${launchAgentLabel}.plist`);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inspectStorage() {
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return { ready: false, reason: `${root} 不是目录` };
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.product !== "alexandria-ai" || !marker.storageId) {
      return { ready: false, reason: "外置 AI 存储身份标记无效" };
    }
    if (expectedStorageId && marker.storageId !== expectedStorageId) {
      return { ready: false, reason: "外置 AI 存储身份与项目配置不一致" };
    }
    return { ready: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
    return { ready: false, reason: `${root} 暂不可用 (${code})` };
  }
}

async function main() {
  if (!enabled) {
    console.log("[agent-runtime] 智能馆长已通过 AMW_AGENT_ENABLED=false 关闭，跳过运行时启动");
    return;
  }

  const storage = inspectStorage();
  if (!storage.ready) {
    console.warn(`[agent-runtime] ${storage.reason}；跳过 AI 运行时，前后端继续启动`);
    return;
  }

  const api = await inspectOllamaApi(ollamaUrl, [chatModel]);
  if (api.ready) {
    console.log(`[agent-runtime] 专用 Ollama 已就绪；${chatModel} 保持未预加载，进入馆长后按需手动加载`);
    return;
  }

  const runtimeDir = path.join(root, "runtime");
  const logPath = path.join(runtimeDir, "ollama.log");
  fs.mkdirSync(runtimeDir, { recursive: true });
  let launchMethod = "detached";

  if (process.platform === "darwin" && fs.existsSync(launchAgentPlist) && typeof process.getuid === "function") {
    try {
      execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${launchAgentLabel}`], { stdio: "ignore" });
      launchMethod = "launch-agent";
      console.log("[agent-runtime] 已通过 macOS LaunchAgent 拉起运行时，避免继承终端或 Codex 沙箱的 Metal 限制");
    } catch (error) {
      console.warn(`[agent-runtime] LaunchAgent 启动失败，将评估兼容回退：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  if (launchMethod === "detached") {
    if (process.platform === "darwin" && process.env.CODEX_SANDBOX) {
      console.warn("[agent-runtime] 当前为 Codex 受限沙箱且未能使用 LaunchAgent；为避免启动无法访问 Metal 的进程，跳过兼容回退");
      return;
    }
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [runtimeScript], {
      cwd: projectRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });
    fs.closeSync(logFd);
    child.unref();
  }

  let lastApiReason = "运行时尚未监听";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await inspectOllamaApi(ollamaUrl, [chatModel], 750);
    if (current.ready) break;
    lastApiReason = current.reason ?? lastApiReason;
    await delay(500);
  }

  const readyApi = await inspectOllamaApi(ollamaUrl, [chatModel], 1_500);
  if (!readyApi.ready) {
    console.warn(`[agent-runtime] 自动启动后仍无法连接完整运行时：${lastApiReason}；前后端继续启动，日志：${logPath}`);
    return;
  }

  console.log(`[agent-runtime] 专用 Ollama 已自动启动；${chatModel} 保持未预加载，进入馆长后按需手动加载`);
}

await main();
