import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { MediaSource } from "./config.js";

const execFileAsync = promisify(execFile);

export type StorageAccessState =
  | "ready"
  | "missing"
  | "permission-denied"
  | "not-directory"
  | "unavailable";

export type StorageAccessStatus = MediaSource & {
  state: StorageAccessState;
  readable: boolean;
  mountPoint: string | null;
  errorCode: string | null;
  message: string;
};

export type StorageAvailabilitySummary = {
  mode: "connected" | "partial" | "solid-state-only";
  connectedSources: number;
  totalSources: number;
  connectedSourceNames: string[];
  videoPlaybackAvailable: boolean;
  message: string;
};

export type StoragePreparationResult = {
  sources: StorageAccessStatus[];
  ready: number;
  unavailable: number;
  mountAttempts: string[];
  permissionSettingsOpened: boolean;
};

/** Decide whether the storage preflight is strong enough to start the server. */
export function hasRequiredStorageAccess(
  result: Pick<StoragePreparationResult, "sources" | "ready">,
  requireAll: boolean
): boolean {
  if (result.sources.length === 0) return false;
  return requireAll ? result.ready === result.sources.length : result.ready > 0;
}

export function summarizeStorageAvailability(
  sources: Array<Pick<StorageAccessStatus, "name" | "readable">>
): StorageAvailabilitySummary {
  const connectedSourceNames = sources.filter((source) => source.readable).map((source) => source.name);
  const connectedSources = connectedSourceNames.length;
  const totalSources = sources.length;
  const mode = connectedSources === 0
    ? "solid-state-only"
    : connectedSources === totalSources
      ? "connected"
      : "partial";
  const message = mode === "solid-state-only"
    ? "当前仅使用固态硬盘中的馆藏索引、元数据和缓存图片；视频源暂未连接"
    : mode === "partial"
      ? "部分视频源暂未连接；离线来源仅提供固态硬盘中的馆藏数据"
      : "全部视频源已连接";
  return {
    mode,
    connectedSources,
    totalSources,
    connectedSourceNames,
    videoPlaybackAvailable: connectedSources > 0,
    message
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

type MountProbe = { checkedAt: number; mounted: boolean | null };
const mountProbeCache = new Map<string, MountProbe>();
const MOUNT_PROBE_CACHE_MS = 2_000;

/**
 * A disconnected macOS volume can leave its `/Volumes/<name>` directory
 * behind. A plain `stat` therefore reports a false-positive readable source
 * and the recovery loop never tries to reconnect it. Confirm the mount table
 * before trusting a volume-backed path. Keep the filesystem type agnostic so
 * local APFS/exFAT volumes work as well as SMB shares. Fail open when the
 * mount command is unavailable so this check cannot prevent normal startup.
 */
function isMountedVolume(mountPoint: string | null): boolean | null {
  if (process.platform !== "darwin" || !mountPoint) return true;
  const now = Date.now();
  const cached = mountProbeCache.get(mountPoint);
  if (cached && now - cached.checkedAt < MOUNT_PROBE_CACHE_MS) return cached.mounted;

  let mounted: boolean | null = null;
  try {
    const output = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 3_000 });
    mounted = output.split("\n").some((line) => line.includes(` on ${mountPoint} (`));
  } catch {
    // Do not turn a diagnostics-tool failure into a storage outage. The
    // subsequent filesystem probe remains the fallback signal.
    mounted = null;
  }
  mountProbeCache.set(mountPoint, { checkedAt: now, mounted });
  return mounted;
}

export function getVolumeMountPoint(root: string): string | null {
  if (process.platform !== "darwin") return null;
  const normalized = root.replace(/\/+$/, "");
  const match = normalized.match(/^\/Volumes\/([^/]+)/);
  return match ? `/Volumes/${match[1]}` : null;
}

export function getVolumeName(root: string): string | null {
  return getVolumeMountPoint(root)?.slice("/Volumes/".length) ?? null;
}

export function parseRemoteMounts(value: string | undefined): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const entry of (value ?? "").split(";")) {
    const normalized = entry.trim();
    if (!normalized) continue;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const volumeName = normalized.slice(0, separator).trim();
    const mountUrl = normalized.slice(separator + 1).trim();
    if (!volumeName || !mountUrl) continue;
    try {
      const url = new URL(mountUrl);
      if (!["smb:", "afp:", "nfs:"].includes(url.protocol)) continue;
      mounts.set(volumeName, mountUrl);
    } catch {
      // Ignore malformed mount entries so a typo cannot execute as a local command.
    }
  }
  return mounts;
}

/** Convert a password-free smb:// URL to the syntax required by mount_smbfs. */
export function toSmbMountTarget(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "smb:" || !url.hostname || url.password) return null;
    const sharePath = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
      .join("/");
    if (!sharePath) return null;
    const user = url.username ? `${decodeURIComponent(url.username)}@` : "";
    const port = url.port ? `:${url.port}` : "";
    return `//${user}${url.hostname}${port}/${sharePath}`;
  } catch {
    return null;
  }
}

export function inspectStorageSource(source: MediaSource): StorageAccessStatus {
  const mountPoint = getVolumeMountPoint(source.root);
  const mounted = isMountedVolume(mountPoint);
  if (mounted === false) {
    return {
      ...source,
      state: "missing",
      readable: false,
      mountPoint,
      errorCode: "ENOTMOUNTED",
      message: "磁盘或目录尚未挂载"
    };
  }
  try {
    const stat = fs.statSync(source.root);
    if (!stat.isDirectory()) {
      return {
        ...source,
        state: "not-directory",
        readable: false,
        mountPoint,
        errorCode: "ENOTDIR",
        message: "路径存在，但不是目录"
      };
    }

    fs.accessSync(source.root, fs.constants.R_OK);
    const directory = fs.opendirSync(source.root);
    directory.closeSync();
    return {
      ...source,
      state: "ready",
      readable: true,
      mountPoint,
      errorCode: null,
      message: "已连接且可读取"
    };
  } catch (error) {
    const code = errorCode(error);
    const state: StorageAccessState = code === "ENOENT"
      ? "missing"
      : code === "EACCES" || code === "EPERM"
        ? "permission-denied"
        : "unavailable";
    const message = state === "missing"
      ? "磁盘或目录尚未挂载"
      : state === "permission-denied"
        ? "磁盘已连接，但当前进程没有读取权限"
        : "磁盘暂时不可读取";
    return {
      ...source,
      state,
      readable: false,
      mountPoint,
      errorCode: code || null,
      message
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openMacOsTarget(target: string): Promise<boolean> {
  try {
    await execFileAsync("open", [target], { timeout: 10_000 });
    return true;
  } catch (error) {
    console.warn("Unable to open macOS storage target:", errorCode(error) || "unknown error");
    return false;
  }
}

/**
 * Try the non-interactive macOS SMB client after Finder has had a chance to
 * restore the share. `-N` reads the saved nsmb/keychain credentials and
 * `nopassprompt` guarantees that a headless service can never hang waiting for
 * a password dialog. The URL is never logged and may contain only the
 * password-free user/share configured in AMW_REMOTE_MOUNTS.
 */
async function mountRemoteVolume(target: string, mountPoint: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const mountTarget = toSmbMountTarget(target);
  if (!mountTarget) return false;
  try {
    fs.mkdirSync(mountPoint, { recursive: true });
    await execFileAsync("/sbin/mount_smbfs", [
      "-N",
      "-o", "nopassprompt,soft",
      mountTarget,
      mountPoint
    ], { timeout: 15_000 });
    return true;
  } catch (error) {
    // A failed fallback is expected when the volume is already mounted or
    // credentials are not available; the next recovery tick will retry.
    console.warn("Unable to mount macOS SMB target non-interactively:", errorCode(error) || "unknown error");
    return false;
  }
}

export async function prepareStorageAccess(
  sources: MediaSource[],
  options: {
    remoteMounts?: Map<string, string>;
    waitMs?: number;
    openPermissionSettings?: boolean;
  } = {}
): Promise<StoragePreparationResult> {
  const remoteMounts = options.remoteMounts ?? parseRemoteMounts(process.env.AMW_REMOTE_MOUNTS);
  const waitMs = Math.max(0, options.waitMs ?? 20_000);
  const mountAttempts: string[] = [];
  let sourcesStatus = sources.map(inspectStorageSource);
  const attemptedVolumes = new Set<string>();

  if (process.platform === "darwin") {
    for (const source of sourcesStatus) {
      if (source.state === "ready") continue;
      const volumeName = getVolumeName(source.root);
      const mountUrl = volumeName ? remoteMounts.get(volumeName) : null;
      if (!volumeName || !mountUrl || attemptedVolumes.has(volumeName)) continue;
      attemptedVolumes.add(volumeName);
      const opened = await openMacOsTarget(mountUrl);
      if (opened) mountAttempts.push(volumeName);
      // If Finder returned before the share became readable (including a
      // silent credential failure), give the headless SMB client one safe,
      // keychain-backed attempt as well; it never prompts for a password.
      const mountPoint = getVolumeMountPoint(source.root);
      if (!inspectStorageSource(source).readable && mountPoint && await mountRemoteVolume(mountUrl, mountPoint)) {
        if (!mountAttempts.includes(volumeName)) mountAttempts.push(volumeName);
      }
    }
  }

  let permissionSettingsOpened = false;
  if (
    process.platform === "darwin" &&
    options.openPermissionSettings !== false &&
    sourcesStatus.some((source) => source.state === "permission-denied")
  ) {
    permissionSettingsOpened = await openMacOsTarget(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    );
  }

  if (waitMs > 0 && (mountAttempts.length > 0 || permissionSettingsOpened)) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
      sourcesStatus = sources.map(inspectStorageSource);
      if (sourcesStatus.every((source) => source.state === "ready")) break;
      // A volume may back more than one configured source (Japan and FC2).
      // Do not stop waiting after the first directory becomes visible: the
      // caller must see every configured source as readable before it resumes
      // source-dependent jobs.
      if (mountAttempts.length > 0 && sourcesStatus.every((source) => source.state === "ready")) break;
    }
  }

  const ready = sourcesStatus.filter((source) => source.state === "ready").length;
  return {
    sources: sourcesStatus,
    ready,
    unavailable: sourcesStatus.length - ready,
    mountAttempts,
    permissionSettingsOpened
  };
}

export function formatStorageStatus(status: StorageAccessStatus): string {
  const detail = status.errorCode ? ` (${status.errorCode})` : "";
  return `${status.category}:${status.name} ${status.message}${detail} - ${status.root}`;
}
