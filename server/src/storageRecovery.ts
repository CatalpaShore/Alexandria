import { config, getMediaSources } from "./config.js";
import {
  inspectStorageSource,
  parseRemoteMounts,
  prepareStorageAccess,
  type StorageAccessStatus
} from "./storageAccess.js";

export type StorageRecoveryStatus = {
  enabled: boolean;
  started: boolean;
  running: boolean;
  allReady: boolean;
  ready: number;
  total: number;
  consecutiveUnavailableChecks: number;
  mountAttemptCount: number;
  maxMountAttempts: number;
  mountRetryExhausted: boolean;
  nextMountAttemptAt: string | null;
  lastCheckedAt: string | null;
  lastMountAttemptAt: string | null;
  lastRecoveredAt: string | null;
  lastError: string | null;
  lastMountAttempts: string[];
  resumedJobs: number;
  sources: StorageAccessStatus[];
};

type RecoveryHandler = () => number | void;

let timer: NodeJS.Timeout | null = null;
let running = false;
let previousAllReady: boolean | null = null;
let lastMountAttemptMs = 0;
let onRecovered: RecoveryHandler | null = null;
let status: StorageRecoveryStatus = {
  enabled: config.storageRecovery.enabled,
  started: false,
  running: false,
  allReady: false,
  ready: 0,
  total: getMediaSources().length,
  consecutiveUnavailableChecks: 0,
  mountAttemptCount: 0,
  maxMountAttempts: config.storageRecovery.maxMountAttempts,
  mountRetryExhausted: false,
  nextMountAttemptAt: null,
  lastCheckedAt: null,
  lastMountAttemptAt: null,
  lastRecoveredAt: null,
  lastError: null,
  lastMountAttempts: [],
  resumedJobs: 0,
  sources: []
};

function inspectSources(): StorageAccessStatus[] {
  return getMediaSources().map(inspectStorageSource);
}

function currentReady(sources: StorageAccessStatus[]): number {
  return sources.filter((source) => source.readable).length;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(-800) || "未知存储恢复错误";
}

export function shouldAttemptStorageMount(input: {
  allReady: boolean;
  remoteMountCount: number;
  nowMs: number;
  lastAttemptMs: number;
  retryMs: number;
  mountAttemptCount: number;
  maxMountAttempts: number;
  force?: boolean;
}): boolean {
  return !input.allReady
    && input.remoteMountCount > 0
    && input.mountAttemptCount < input.maxMountAttempts
    && (input.force === true || input.lastAttemptMs === 0 || input.nowMs - input.lastAttemptMs >= input.retryMs);
}

export function shouldAllowDegradedStorageStartup(input: {
  storageRequired: boolean;
  hasRequiredAccess: boolean;
  recoveryEnabled: boolean;
  remoteMountCount: number;
}): boolean {
  return input.storageRequired
    && !input.hasRequiredAccess
    && input.recoveryEnabled
    && input.remoteMountCount > 0;
}

function getNextMountAttemptAt(input: {
  allReady: boolean;
  remoteMountCount: number;
  mountRetryExhausted: boolean;
  nowMs: number;
  lastAttemptMs: number;
  retryMs: number;
}): string | null {
  if (input.allReady || input.remoteMountCount === 0 || input.mountRetryExhausted) return null;
  const nextAttemptMs = input.lastAttemptMs > 0
    ? Math.max(input.nowMs, input.lastAttemptMs + input.retryMs)
    : input.nowMs;
  return new Date(nextAttemptMs).toISOString();
}

export async function runStorageRecoveryCheck(options: { forceMount?: boolean } = {}): Promise<StorageRecoveryStatus> {
  if (running || !config.storageRecovery.enabled) return getStorageRecoveryStatus();
  running = true;
  status = { ...status, started: true, running: true };
  const nowMs = Date.now();
  const wasRetryExhausted = status.mountRetryExhausted;
  let remoteMountCount = 0;
  try {
    const remoteMounts = parseRemoteMounts(process.env.AMW_REMOTE_MOUNTS);
    remoteMountCount = remoteMounts.size;
    let sources = inspectSources();
    let ready = currentReady(sources);
    let mountAttempts: string[] = [];
    if (shouldAttemptStorageMount({
      allReady: ready === sources.length,
      remoteMountCount: remoteMounts.size,
      nowMs,
      lastAttemptMs: lastMountAttemptMs,
      retryMs: config.storageRecovery.mountRetryMs,
      mountAttemptCount: status.mountAttemptCount,
      maxMountAttempts: config.storageRecovery.maxMountAttempts,
      force: options.forceMount
    })) {
      lastMountAttemptMs = nowMs;
      const mountAttemptCount = status.mountAttemptCount + 1;
      status = {
        ...status,
        mountAttemptCount,
        mountRetryExhausted: mountAttemptCount >= config.storageRecovery.maxMountAttempts,
        lastMountAttemptAt: new Date(lastMountAttemptMs).toISOString()
      };
      const prepared = await prepareStorageAccess(getMediaSources(), {
        remoteMounts,
        waitMs: config.storageRecovery.mountWaitMs,
        openPermissionSettings: false
      });
      sources = prepared.sources;
      ready = prepared.ready;
      mountAttempts = prepared.mountAttempts;
    }

    const allReady = sources.length > 0 && ready === sources.length;
    const didRecover = previousAllReady === false && allReady;
    const mountAttemptCount = allReady ? 0 : status.mountAttemptCount;
    const mountRetryExhausted = !allReady
      && remoteMountCount > 0
      && mountAttemptCount >= config.storageRecovery.maxMountAttempts;
    const nextMountAttemptAt = getNextMountAttemptAt({
      allReady,
      remoteMountCount,
      mountRetryExhausted,
      nowMs,
      lastAttemptMs: lastMountAttemptMs,
      retryMs: config.storageRecovery.mountRetryMs
    });
    let resumedJobs = status.resumedJobs;
    if (didRecover) {
      resumedJobs += Number(onRecovered?.() ?? 0);
      console.log(`[storage-recovery] All ${sources.length} media sources recovered; resumed ${resumedJobs - status.resumedJobs} waiting jobs`);
    } else if (previousAllReady !== false && !allReady) {
      console.warn(`[storage-recovery] ${sources.length - ready}/${sources.length} media sources unavailable; background source jobs will wait`);
    }
    if (!wasRetryExhausted && mountRetryExhausted) {
      console.warn(
        `[storage-recovery] Remote mount retry limit reached (${mountAttemptCount}/${config.storageRecovery.maxMountAttempts}); automatic mount commands are paused until storage recovers or the service restarts`
      );
    }
    previousAllReady = allReady;
    status = {
      ...status,
      started: true,
      running: false,
      allReady,
      ready,
      total: sources.length,
      consecutiveUnavailableChecks: allReady ? 0 : status.consecutiveUnavailableChecks + 1,
      mountAttemptCount,
      maxMountAttempts: config.storageRecovery.maxMountAttempts,
      mountRetryExhausted,
      nextMountAttemptAt,
      lastCheckedAt: new Date().toISOString(),
      lastMountAttemptAt: lastMountAttemptMs > 0 ? new Date(lastMountAttemptMs).toISOString() : null,
      lastRecoveredAt: didRecover ? new Date().toISOString() : status.lastRecoveredAt,
      lastError: null,
      lastMountAttempts: mountAttempts,
      resumedJobs,
      sources
    };
  } catch (error) {
    const mountRetryExhausted = remoteMountCount > 0
      && status.mountAttemptCount >= config.storageRecovery.maxMountAttempts;
    if (!wasRetryExhausted && mountRetryExhausted) {
      console.warn(
        `[storage-recovery] Remote mount retry limit reached (${status.mountAttemptCount}/${config.storageRecovery.maxMountAttempts}) after a failed check`
      );
    }
    status = {
      ...status,
      started: true,
      running: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: safeErrorMessage(error),
      consecutiveUnavailableChecks: status.consecutiveUnavailableChecks + 1,
      maxMountAttempts: config.storageRecovery.maxMountAttempts,
      mountRetryExhausted,
      nextMountAttemptAt: getNextMountAttemptAt({
        allReady: false,
        remoteMountCount,
        mountRetryExhausted,
        nowMs,
        lastAttemptMs: lastMountAttemptMs,
        retryMs: config.storageRecovery.mountRetryMs
      })
    };
    console.error("[storage-recovery] Check failed:", status.lastError);
  } finally {
    running = false;
    status = { ...status, running: false };
  }
  return getStorageRecoveryStatus();
}

export function startStorageRecovery(
  handler?: RecoveryHandler,
  options: { initialMountAttemptCount?: number } = {}
): void {
  if (!config.storageRecovery.enabled || timer) return;
  onRecovered = handler ?? null;
  const sources = inspectSources();
  const ready = currentReady(sources);
  previousAllReady = sources.length > 0 && ready === sources.length;
  const initialMountAttemptCount = previousAllReady
    ? 0
    : Math.min(
        Math.max(0, options.initialMountAttemptCount ?? 0),
        config.storageRecovery.maxMountAttempts
      );
  // Server startup already ran the interactive mount preflight. When it is
  // still unavailable, wait for the normal retry window instead of opening a
  // duplicate Finder authentication prompt immediately.
  lastMountAttemptMs = previousAllReady ? 0 : Date.now();
  const remoteMountCount = parseRemoteMounts(process.env.AMW_REMOTE_MOUNTS).size;
  const mountRetryExhausted = !previousAllReady
    && remoteMountCount > 0
    && initialMountAttemptCount >= config.storageRecovery.maxMountAttempts;
  status = {
    ...status,
    enabled: true,
    started: true,
    allReady: previousAllReady,
    ready,
    total: sources.length,
    mountAttemptCount: initialMountAttemptCount,
    maxMountAttempts: config.storageRecovery.maxMountAttempts,
    mountRetryExhausted,
    nextMountAttemptAt: getNextMountAttemptAt({
      allReady: previousAllReady,
      remoteMountCount,
      mountRetryExhausted,
      nowMs: Date.now(),
      lastAttemptMs: lastMountAttemptMs,
      retryMs: config.storageRecovery.mountRetryMs
    }),
    sources,
    lastCheckedAt: new Date().toISOString(),
    lastMountAttemptAt: lastMountAttemptMs > 0 ? new Date(lastMountAttemptMs).toISOString() : null
  };
  void runStorageRecoveryCheck();
  timer = setInterval(() => {
    void runStorageRecoveryCheck();
  }, config.storageRecovery.checkIntervalMs);
  timer.unref();
}

export function stopStorageRecovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
  onRecovered = null;
  status = { ...status, started: false, running: false };
}

export function getStorageRecoveryStatus(): StorageRecoveryStatus {
  return {
    ...status,
    sources: status.sources.map((source) => ({ ...source })),
    lastMountAttempts: [...status.lastMountAttempts]
  };
}
