import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.VITE_PORT ?? 4311);
const lanMode = (process.env.AMW_LAN_MODE ?? "false").trim().toLowerCase() === "true";
const host = lanMode ? (process.env.AMW_HOST ?? "0.0.0.0").trim() || "0.0.0.0" : "127.0.0.1";
const projectRoot = path.resolve(import.meta.dirname, "..");
const viteBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");

function readCwd(pid) {
  const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
}

function findListenerPids() {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

async function stopPreviousFrontend() {
  for (const pid of findListenerPids()) {
    const cwd = readCwd(pid);
    const belongsToCurrentProject = cwd === projectRoot || cwd.startsWith(`${projectRoot}${path.sep}`);
    if (!belongsToCurrentProject) {
      throw new Error(`端口 ${port} 被其他程序占用（PID ${pid}），为避免误关闭已停止启动。`);
    }

    console.log(`正在关闭旧的前端调试服务（PID ${pid}）...`);
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 30 && findListenerPids().includes(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (findListenerPids().includes(pid)) {
      throw new Error(`旧的前端调试服务（PID ${pid}）未能正常退出。`);
    }
  }
}

if (!fs.existsSync(viteBin)) {
  throw new Error("未找到 Vite，请先运行 pnpm install。");
}

await stopPreviousFrontend();

const vite = spawn(viteBin, ["--host", host, "--port", String(port)], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => vite.kill(signal));
}

vite.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
