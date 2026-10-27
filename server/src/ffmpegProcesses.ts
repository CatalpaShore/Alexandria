import type { ChildProcess } from "node:child_process";
import os from "node:os";
import { config } from "./config.js";

const activeProcesses = new Set<ChildProcess>();

export function trackFfmpegProcess<T extends ChildProcess>(child: T): T {
  activeProcesses.add(child);
  if (child.pid && config.mediaWorkerProcessNiceness > 0) {
    try {
      os.setPriority(child.pid, config.mediaWorkerProcessNiceness);
    } catch {
      // Process priority is a best-effort optimization on restricted NAS runtimes.
    }
  }
  const remove = () => activeProcesses.delete(child);
  child.once("error", remove);
  child.once("exit", remove);
  return child;
}

export function stopActiveFfmpegProcesses(signal: NodeJS.Signals = "SIGTERM"): number {
  let stopped = 0;
  for (const child of activeProcesses) {
    if (child.exitCode != null || child.killed) continue;
    try {
      if (child.kill(signal)) stopped += 1;
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
  return stopped;
}
