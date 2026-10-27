import fs from "node:fs";
import path from "node:path";

export type ExternalAiStorageState =
  | "disabled"
  | "missing"
  | "permission-denied"
  | "not-directory"
  | "uninitialized"
  | "identity-mismatch"
  | "ready"
  | "unavailable";

export type ExternalAiStorageOptions = {
  enabled: boolean;
  root: string;
  markerFile: string;
  expectedStorageId?: string;
};

export type ExternalAiStorageStatus = {
  state: ExternalAiStorageState;
  root: string;
  mountPoint: string | null;
  markerPath: string;
  storageId: string | null;
  readable: boolean;
  writable: boolean;
  ready: boolean;
  errorCode: string | null;
  message: string;
};

function getErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function getMountPoint(root: string): string | null {
  const normalized = path.resolve(root).replace(/\/+$/, "");
  const match = normalized.match(/^\/Volumes\/([^/]+)/);
  return match ? `/Volumes/${match[1]}` : null;
}

function result(
  options: ExternalAiStorageOptions,
  state: ExternalAiStorageState,
  values: Partial<ExternalAiStorageStatus>
): ExternalAiStorageStatus {
  return {
    state,
    root: path.resolve(options.root),
    mountPoint: getMountPoint(options.root),
    markerPath: path.join(path.resolve(options.root), options.markerFile),
    storageId: null,
    readable: false,
    writable: false,
    ready: false,
    errorCode: null,
    message: "外置 AI 存储暂不可用",
    ...values
  };
}

/**
 * Read-only preflight. This function never creates the configured path, because
 * doing so while /Volumes is unmounted would silently place AI data internally.
 */
export function inspectExternalAiStorage(options: ExternalAiStorageOptions): ExternalAiStorageStatus {
  if (!options.enabled) {
    return result(options, "disabled", { message: "Agent 功能已通过配置关闭" });
  }

  const root = path.resolve(options.root);
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) {
      return result(options, "not-directory", {
        errorCode: "ENOTDIR",
        message: "外置 AI 路径存在，但不是目录"
      });
    }
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
    const directory = fs.opendirSync(root);
    directory.closeSync();
  } catch (error) {
    const code = getErrorCode(error);
    const state: ExternalAiStorageState = code === "ENOENT"
      ? "missing"
      : code === "EACCES" || code === "EPERM"
        ? "permission-denied"
        : "unavailable";
    return result(options, state, {
      errorCode: code || null,
      message: state === "missing"
        ? "外置 AI 硬盘尚未挂载或目录尚未初始化"
        : state === "permission-denied"
          ? "外置 AI 硬盘已连接，但当前进程没有读写权限"
          : "外置 AI 存储暂时无法访问"
    });
  }

  const markerPath = path.join(root, options.markerFile);
  let marker: { storageId?: unknown; product?: unknown };
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { storageId?: unknown; product?: unknown };
  } catch (error) {
    const code = getErrorCode(error);
    return result(options, "uninitialized", {
      readable: true,
      writable: true,
      errorCode: code || "INVALID_MARKER",
      message: "硬盘目录可用，但尚未完成 Alexandria 18+ AI 初始化"
    });
  }

  const storageId = typeof marker.storageId === "string" ? marker.storageId.trim() : "";
  const validProduct = marker.product === "alexandria-ai";
  if (!storageId || !validProduct || (options.expectedStorageId && storageId !== options.expectedStorageId)) {
    return result(options, "identity-mismatch", {
      storageId: storageId || null,
      readable: true,
      writable: true,
      errorCode: "STORAGE_IDENTITY_MISMATCH",
      message: "检测到的硬盘不是已配置的 Alexandria 18+ AI 存储"
    });
  }

  return result(options, "ready", {
    storageId,
    readable: true,
    writable: true,
    ready: true,
    message: "外置 AI 存储已连接并通过身份校验"
  });
}
