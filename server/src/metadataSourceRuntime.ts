import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type MetadataRuntimeOptions = {
  enabled: boolean;
  serverUrl: string;
  command: string;
  databasePath: string;
  token?: string;
  retryMs?: number;
  readyTimeoutMs?: number;
};

// Only launch an explicitly configured local executable. Existing remote services
// are accessed by the normal metadata client, never managed as child processes.
export function createMetadataSourceRuntime(options: MetadataRuntimeOptions) {
  let child: ChildProcess | null = null;
  let starting: Promise<boolean> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const retry = () => {
    if (stopped || timer || !options.enabled) return;
    timer = setTimeout(() => { timer = null; void start(); }, options.retryMs ?? 30_000);
    timer.unref();
  };
  const ready = async () => {
    try {
      const response = await fetch(`${options.serverUrl}/v1/providers`, {
        headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
        signal: AbortSignal.timeout(1_500)
      });
      return response.ok;
    } catch { return false; }
  };
  function localAddress(): URL | null {
    try {
      const url = new URL(options.serverUrl);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
          || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return url;
    } catch { return null; }
  }
  function start(): Promise<boolean> {
    if (starting) return starting;
    if (!options.enabled || stopped) return Promise.resolve(false);
    starting = (async () => {
      const url = localAddress();
      if (!url || !path.isAbsolute(options.command) || !path.isAbsolute(options.databasePath)) {
        console.warn("[metadata-source] Set a loopback HTTP URL and absolute executable and database paths to enable automatic startup.");
        return false;
      }
      if (await ready()) return true;
      if (stopped) return false;
      if (!child) {
        try {
          fs.accessSync(options.command, fs.constants.X_OK);
          fs.accessSync(path.dirname(options.databasePath), fs.constants.W_OK);
          const proc = spawn(options.command, ["-bind", "127.0.0.1", "-dsn", options.databasePath,
            "-port", url.port || "80", "-db-auto-migrate", "-db-prepared-stmt"], { stdio: "ignore" });
          child = proc;
          proc.once("error", () => { if (child === proc) child = null; console.warn("[metadata-source] Could not start local service."); retry(); });
          proc.once("exit", () => { if (child === proc) child = null; retry(); });
        } catch {
          console.warn("[metadata-source] Local service executable or database directory is unavailable.");
          retry();
          return false;
        }
      }
      const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
      while (!stopped && child && Date.now() < deadline) {
        if (await ready()) { console.log("[metadata-source] Local service is ready."); return true; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!stopped) retry();
      return false;
    })().finally(() => { starting = null; });
    return starting;
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (child && !child.killed) child.kill("SIGTERM");
    child = null;
  }
  return { start, stop };
}

const runtime = createMetadataSourceRuntime({
  enabled: config.metadata.manageMetatube,
  serverUrl: config.metadata.serverUrl,
  command: config.metadata.metatubeCommand,
  databasePath: config.metadata.metatubeDatabasePath,
  token: config.metadata.token
});
export const startMetadataSourceRuntime = runtime.start;
export const stopMetadataSourceRuntime = runtime.stop;
