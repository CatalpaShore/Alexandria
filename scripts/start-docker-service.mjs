import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try { process.loadEnvFile(path.join(project, ".env")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const info = text => console.log(`[Alexandria 18+] ${text}`);
async function waitFor(check, milliseconds, description) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await check()) return;
    await delay(1500);
  } while (Date.now() < deadline);
  throw new Error(description);
}
async function docker(args) {
  return run("docker", args, { cwd: project, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
}
async function main() {
  // Compose can resolve bind paths without a running daemon. Never print its
  // environment: it may include tokens. Do not import application/database code.
  const { stdout } = await docker(["compose", "config", "--format", "json"]);
  const compose = JSON.parse(stdout);
  const services = ["media-wall", "media-worker"].filter(name => compose.services[name]);
  if ((process.env.COMPOSE_PROFILES ?? "").split(",").includes("native-highlights") && compose.services["highlight-worker"]) services.push("highlight-worker");
  const binds = [...new Set(services.flatMap(name => compose.services[name].volumes)
    .filter(volume => volume.type === "bind" && volume.source.startsWith("/Volumes/"))
    .map(volume => volume.source))];
  const readable = root => {
    try {
      fs.accessSync(root, fs.constants.R_OK);
      return fs.statSync(root).isDirectory();
    } catch { return false; }
  };
  async function connected(root) {
    if (!readable(root)) return false;
    if (process.platform !== "darwin") return true;
    const volume = root.match(/^\/Volumes\/[^/]+/)?.[0];
    const result = await run("/sbin/mount", [], { timeout: 3000 });
    return result.stdout.split("\n").some(line => line.includes(` on ${volume} (`));
  }
  const remotes = new Map((process.env.AMW_REMOTE_MOUNTS ?? "").split(";").flatMap(entry => {
    const split = entry.indexOf("=");
    return split > 0 ? [[entry.slice(0, split).trim(), entry.slice(split + 1).trim()]] : [];
  }));
  for (const root of binds) {
    if (await connected(root)) continue;
    const volume = root.split("/")[2];
    const target = remotes.get(volume);
    if (process.platform === "darwin" && target) {
      const url = new URL(target);
      if (url.protocol !== "smb:" || url.password) throw new Error("请使用不含密码的 SMB 连接配置");
      info(`正在连接 ${volume}，请完成系统可能显示的登录提示。`);
      await run("/usr/bin/open", [target], { timeout: 10000 });
      await waitFor(() => connected(root), 60000, `共享盘未就绪：${volume}，请在访达中连接后重试。`);
    } else throw new Error(`请先连接存储目录：${root}`);
  }
  info("存储目录已就绪，检查 Docker。");
  const ready = async () => { try { await docker(["info", "--format", "{{.ServerVersion}}"]); return true; } catch { return false; } };
  if (!await ready()) {
    if (process.platform !== "darwin") throw new Error("请先启动 Docker 引擎。");
    await run("/usr/bin/open", ["-a", "Docker"], { timeout: 10000 });
    await waitFor(ready, 90000, "Docker 引擎未能就绪，请检查 Docker Desktop。");
  }
  // Start the configured services without rebuilding or replacing data volumes.
  const result = await run("docker", ["compose", "up", "-d", "--no-build", ...services], { cwd: project, timeout: 90000 });
  if (result.stderr) process.stderr.write(result.stderr);
  const port = compose.services["media-wall"].ports.find(port => port.target === 3000)?.published ?? 5179;
  const address = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const response = await fetch(`${address}/api/health/ping`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      const body = await response.json();
      return body.ok === true && body.service === "alexandria";
    }
    catch { return false; }
  }, 90000, "容器已启动，但健康检查未通过，请查看 docker compose logs media-wall。");
  info(`服务已就绪：${address}`);
}
main().catch(error => { console.error(`[Alexandria 18+] ${error.message}`); process.exitCode = 1; });
