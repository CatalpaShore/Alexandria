import fs from "node:fs";
import path from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { createBackup } from "./backup.js";
import { config } from "./config.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";

export const BACKUP_SCOPES = ["app-data", "project-code", "generated-assets"] as const;
export type BackupScope = (typeof BACKUP_SCOPES)[number];
export type BackupJobStatus = "queued" | "scanning" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type BackupJobPart = {
  id: string;
  label: string;
  filesTotal: number;
  filesCopied: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesCopied: number;
  bytesSkipped: number;
};

export type BackupSettings = {
  enabled: boolean;
  targetRoot: string;
  frequency: "daily" | "weekly";
  hour: number;
  weekday: number;
  scopes: BackupScope[];
  updatedAt: string;
};

export type BackupJob = {
  id: string;
  trigger: "manual" | "automatic";
  status: BackupJobStatus;
  targetRoot: string;
  scopes: BackupScope[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  currentFile?: string;
  filesTotal: number;
  filesCopied: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesCopied: number;
  bytesSkipped: number;
  parts?: BackupJobPart[];
  excludedSources: string[];
  error?: string;
};

type CopyEntry = {
  source: string;
  destination: string;
  bytes: number;
  mtimeMs: number;
  partId: string;
  kind: "file" | "symlink";
  linkTarget?: string;
};
type RuntimeJob = { job: BackupJob; pauseRequested: boolean; cancelRequested: boolean };

const settingsPath = path.join(config.dataDir, "backup-settings.json");
const jobsPath = path.join(config.dataDir, "backup-jobs.json");
const defaultTargetRoot = path.join(config.externalAi.root, "backups", "alexandria");
const t7VolumeRoot = path.parse(config.externalAi.root).root === "/"
  ? path.join("/Volumes", path.basename(path.dirname(config.externalAi.root)))
  : config.externalAi.root;
const runtimes = new Map<string, RuntimeJob>();
const jobs: BackupJob[] = readJson<BackupJob[]>(jobsPath, []).map((job) =>
  job.status === "running" || job.status === "scanning" || job.status === "queued"
    ? { ...job, status: "paused", error: "服务重启后已安全暂停，可继续执行" }
    : job
);
let scheduler: NodeJS.Timeout | null = null;
let database: BetterSqlite3.Database | null = null;

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function persistJobs(): void {
  writeJsonAtomic(jobsPath, jobs.slice(0, 50));
}

function normalizeScopes(scopes: readonly unknown[]): BackupScope[] {
  const valid = scopes.filter((scope): scope is BackupScope => BACKUP_SCOPES.includes(scope as BackupScope));
  return valid.includes("project-code") ? [...BACKUP_SCOPES] : [...new Set(valid)];
}

function getDefaultSettings(): BackupSettings {
  return {
    enabled: true,
    targetRoot: defaultTargetRoot,
    frequency: "daily",
    hour: 3,
    weekday: 0,
    scopes: [...BACKUP_SCOPES],
    updatedAt: new Date(0).toISOString()
  };
}

export function getBackupSettings(): BackupSettings {
  const saved = readJson<Partial<BackupSettings>>(settingsPath, {});
  return {
    ...getDefaultSettings(),
    ...saved,
    scopes: Array.isArray(saved.scopes) ? normalizeScopes(saved.scopes) : [...BACKUP_SCOPES]
  };
}

export function saveBackupSettings(input: Omit<BackupSettings, "updatedAt">): BackupSettings {
  const settings: BackupSettings = {
    ...input,
    targetRoot: path.resolve(input.targetRoot),
    scopes: normalizeScopes(input.scopes),
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(settingsPath, settings);
  return settings;
}

export function listBackupJobs(): BackupJob[] {
  return jobs.slice(0, 20);
}

export function inspectBackupTarget(targetRoot: string): {
  targetRoot: string; available: boolean; writable: boolean; freeBytes: number | null; isDefaultT7: boolean; error?: string;
} {
  const resolved = path.resolve(targetRoot);
  const volumeMatch = resolved.match(/^\/Volumes\/([^/]+)/);
  if (volumeMatch) {
    const mountPoint = `/Volumes/${volumeMatch[1]}`;
    try {
      const mountStat = fs.statSync(mountPoint);
      const volumesStat = fs.statSync("/Volumes");
      if (!mountStat.isDirectory() || mountStat.dev === volumesStat.dev) {
        throw new Error("外置硬盘尚未真实挂载");
      }
      if (isWithin(resolved, config.externalAi.root)) {
        const storage = inspectExternalAiStorage({
          enabled: true,
          root: config.externalAi.root,
          markerFile: config.externalAi.markerFile,
          expectedStorageId: config.externalAi.expectedStorageId
        });
        if (!storage.ready) throw new Error(storage.message);
      }
    } catch (error) {
      return {
        targetRoot: resolved,
        available: false,
        writable: false,
        freeBytes: null,
        isDefaultT7: isWithin(resolved, t7VolumeRoot),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  let probeRoot = resolved;
  while (!fs.existsSync(probeRoot) && path.dirname(probeRoot) !== probeRoot) probeRoot = path.dirname(probeRoot);
  try {
    const stat = fs.statSync(probeRoot);
    if (!stat.isDirectory()) throw new Error("目标位置不是文件夹");
    fs.accessSync(probeRoot, fs.constants.R_OK | fs.constants.W_OK);
    const disk = fs.statfsSync(probeRoot);
    return {
      targetRoot: resolved,
      available: true,
      writable: true,
      freeBytes: Number(disk.bavail) * Number(disk.bsize),
      isDefaultT7: isWithin(resolved, t7VolumeRoot)
    };
  } catch (error) {
    return {
      targetRoot: resolved,
      available: false,
      writable: false,
      freeBytes: null,
      isDefaultT7: isWithin(resolved, t7VolumeRoot),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function collectFiles(
  sourceRoot: string,
  destinationRoot: string,
  partId: string,
  entries: CopyEntry[],
  interrupted: () => boolean,
  excludedRoots: string[] = [],
  excludedNames: string[] = []
): Promise<boolean> {
  try {
    const rootStat = await fs.promises.lstat(sourceRoot);
    if (rootStat.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(sourceRoot);
      entries.push({ source: sourceRoot, destination: destinationRoot, bytes: Buffer.byteLength(linkTarget), mtimeMs: rootStat.mtimeMs, partId, kind: "symlink", linkTarget });
      return true;
    }
    if (rootStat.isFile()) {
      entries.push({ source: sourceRoot, destination: destinationRoot, bytes: rootStat.size, mtimeMs: rootStat.mtimeMs, partId, kind: "file" });
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const pending = [{ source: sourceRoot, destination: destinationRoot }];
  while (pending.length > 0) {
    if (interrupted()) return false;
    const current = pending.pop()!;
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(current.source, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const child of children) {
      const source = path.join(current.source, child.name);
      const destination = path.join(current.destination, child.name);
      if (excludedNames.includes(child.name) || excludedRoots.some((root) => isWithin(source, root))) continue;
      if (child.isSymbolicLink()) {
        const stat = await fs.promises.lstat(source);
        const linkTarget = await fs.promises.readlink(source);
        entries.push({ source, destination, bytes: Buffer.byteLength(linkTarget), mtimeMs: stat.mtimeMs, partId, kind: "symlink", linkTarget });
      } else if (child.isDirectory()) pending.push({ source, destination });
      else if (child.isFile()) {
        const stat = await fs.promises.stat(source);
        entries.push({ source, destination, bytes: stat.size, mtimeMs: stat.mtimeMs, partId, kind: "file" });
      }
    }
  }
  return true;
}

function sourceGroups(scopes: BackupScope[], targetRoot: string, excludedSources: string[]) {
  const projectMirrorRoot = path.join(targetRoot, "current", "project");
  const groups: Array<{
    partId: string;
    label: string;
    source: string;
    destination: string;
    excludedRoots?: string[];
    excludedNames?: string[];
  }> = [];
  const add = (
    partId: string,
    label: string,
    source: string,
    destination: string,
    excludedRoots?: string[],
    excludedNames?: string[]
  ) => {
    const resolved = path.resolve(source);
    if (isWithin(resolved, config.externalAi.root) || isWithin(resolved, t7VolumeRoot) || isWithin(resolved, targetRoot)) {
      excludedSources.push(resolved);
      return;
    }
    if (isWithin(targetRoot, resolved)) throw new Error(`备份目标不能位于来源目录内部：${resolved}`);
    groups.push({ partId, label, source: resolved, destination, excludedRoots, excludedNames });
  };
  if (scopes.includes("app-data")) {
    add(
      "application-files",
      "应用配置与日志",
      config.dataDir,
      path.join(projectMirrorRoot, "data"),
      [
        config.thumbnailDir,
        config.coverCacheDir,
        config.derivativeDir,
        config.metadataExportDir,
        path.join(config.dataDir, "backups"),
        path.join(config.dataDir, "restore-rollbacks")
      ],
      ["media-wall.sqlite", "media-wall.sqlite-wal", "media-wall.sqlite-shm", "restore.lock", "restore-worker.stopped"]
    );
  }
  if (scopes.includes("project-code")) {
    const projectRoot = path.resolve(".");
    add(
      "project-code",
      "完整项目环境",
      projectRoot,
      projectMirrorRoot,
      [
        config.dataDir,
        path.join(projectRoot, "data"),
        path.join(projectRoot, "seed")
      ],
      []
    );
    const nodeRuntimeRoot = path.dirname(path.dirname(process.execPath));
    add(
      "node-runtime",
      "Node.js 运行环境",
      nodeRuntimeRoot,
      path.join(projectMirrorRoot, ".alexandria-runtime", "node")
    );
  }
  if (scopes.includes("generated-assets")) {
    add("thumbnails", "缩略图", config.thumbnailDir, path.join(projectMirrorRoot, "data", "thumbnails"));
    add("covers", "封面缓存", config.coverCacheDir, path.join(projectMirrorRoot, "data", "covers"));
    add("derivatives", "字幕与播放派生资源", config.derivativeDir, path.join(projectMirrorRoot, "data", "derivatives"));
    add("metadata-exports", "元数据导出", config.metadataExportDir, path.join(projectMirrorRoot, "data", "exports"));
    add("cover-seed", "封面种子", config.coverSeedDir, path.join(projectMirrorRoot, "seed", "covers"));
    add("metadata-seed", "元数据种子", config.metadataSeedPath, path.join(projectMirrorRoot, "seed", "metadata-seed.json.gz"));
  }
  return groups;
}

function emptyPart(id: string, label: string): BackupJobPart {
  return { id, label, filesTotal: 0, filesCopied: 0, filesSkipped: 0, bytesTotal: 0, bytesCopied: 0, bytesSkipped: 0 };
}

function getPart(job: BackupJob, id: string): BackupJobPart {
  const part = job.parts?.find((candidate) => candidate.id === id);
  if (!part) throw new Error(`备份分部不存在：${id}`);
  return part;
}

async function summarizeDirectory(root: string): Promise<{ files: number; bytes: number }> {
  const entries: CopyEntry[] = [];
  await collectFiles(root, root, "summary", entries, () => false);
  return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

async function filesMatch(entry: CopyEntry): Promise<boolean> {
  try {
    const destination = await fs.promises.lstat(entry.destination);
    if (entry.kind === "symlink") {
      return destination.isSymbolicLink() && await fs.promises.readlink(entry.destination) === entry.linkTarget;
    }
    return destination.isFile() && destination.size === entry.bytes && Math.abs(destination.mtimeMs - entry.mtimeMs) < 2;
  } catch {
    return false;
  }
}

async function copyEntry(entry: CopyEntry): Promise<void> {
  await fs.promises.mkdir(path.dirname(entry.destination), { recursive: true });
  const temporary = `${entry.destination}.alexandria-part`;
  await fs.promises.rm(temporary, { force: true });
  if (entry.kind === "symlink") {
    await fs.promises.symlink(entry.linkTarget!, temporary);
  } else {
    await fs.promises.copyFile(entry.source, temporary);
    await fs.promises.utimes(temporary, new Date(), new Date(entry.mtimeMs));
  }
  await fs.promises.rm(entry.destination, { force: true });
  await fs.promises.rename(temporary, entry.destination);
}

async function writeRestoreBundle(job: BackupJob): Promise<void> {
  if (!job.scopes.includes("project-code")) return;
  const projectRoot = path.join(job.targetRoot, "current", "project");
  const files = [
    {
      path: path.join(projectRoot, ".alexandria-runtime", "environment.json"),
      mode: 0o644,
      content: `${JSON.stringify({
        format: "alexandria-restorable-project",
        version: 1,
        createdAt: new Date().toISOString(),
        sourceProjectRoot: path.resolve("."),
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        bundledNode: ".alexandria-runtime/node/bin/node",
        startCommand: "./start-restored.sh",
        sourceVideosIncluded: false
      }, null, 2)}\n`
    },
    {
      path: path.join(projectRoot, "start-restored.sh"),
      mode: 0o755,
      content: `#!/bin/bash\nset -euo pipefail\nPROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"\ncd "$PROJECT_DIR"\nexec "$PROJECT_DIR/.alexandria-runtime/node/bin/node" dist/server/index.js\n`
    },
    {
      path: path.join(job.targetRoot, "current", "RESTORE.md"),
      mode: 0o644,
      content: `# Alexandria 18+ 完整项目还原\n\n1. 将 \`project\` 文件夹整体复制到目标 Mac。\n2. 保持原媒体盘挂载路径，源视频不在本备份中。\n3. 在项目目录运行 \`./start-restored.sh\`。\n\n项目镜像包含数据库一致性快照、应用数据、生成资源、源码、Git 历史、依赖、构建产物、环境配置、Android 工具链和当前 Node.js 运行时。系统级 FFmpeg 与 macOS 权限仍由目标机器提供。\n`
    }
  ];
  const part = getPart(job, "project-code");
  for (const file of files) {
    await fs.promises.mkdir(path.dirname(file.path), { recursive: true });
    await fs.promises.writeFile(file.path, file.content, { encoding: "utf8", mode: file.mode });
    const bytes = Buffer.byteLength(file.content);
    part.filesTotal += 1;
    part.filesCopied += 1;
    part.bytesTotal += bytes;
    part.bytesCopied += bytes;
    job.filesTotal += 1;
    job.filesCopied += 1;
    job.bytesTotal += bytes;
    job.bytesCopied += bytes;
  }
}

async function run(runtime: RuntimeJob): Promise<void> {
  const { job } = runtime;
  try {
    const target = inspectBackupTarget(job.targetRoot);
    if (!target.available || !target.writable) throw new Error(`备份目标不可用：${target.error ?? job.targetRoot}`);
    fs.mkdirSync(job.targetRoot, { recursive: true });
    job.status = "scanning";
    job.startedAt ??= new Date().toISOString();
    job.error = undefined;
    persistJobs();
    const groups = sourceGroups(job.scopes, job.targetRoot, job.excludedSources);
    job.parts = [
      ...(job.scopes.includes("app-data") ? [emptyPart("app-snapshot", "数据库与用户状态")] : []),
      ...groups.map((group) => emptyPart(group.partId, group.label))
    ];

    if (job.scopes.includes("app-data")) {
      if (!database) throw new Error("数据库尚未就绪");
      const snapshotRoot = path.join(job.targetRoot, "snapshots", "app-data");
      const snapshotId = `${job.id}-app`;
      const snapshotDir = path.join(snapshotRoot, snapshotId);
      const existed = fs.existsSync(snapshotDir);
      if (!existed) await createBackup({ database, outputRoot: snapshotRoot, backupId: snapshotId });
      const snapshotManifest = JSON.parse(await fs.promises.readFile(path.join(snapshotDir, "manifest.json"), "utf8")) as {
        artifacts: Array<{ role: string; path: string }>;
      };
      const databaseArtifact = snapshotManifest.artifacts.find((artifact) => artifact.role === "database");
      if (!databaseArtifact) throw new Error("应用数据快照缺少数据库文件");
      const snapshotDatabasePath = path.join(snapshotDir, databaseArtifact.path);
      const restorableDatabasePath = path.join(job.targetRoot, "current", "project", "data", "media-wall.sqlite");
      const snapshotDatabaseStat = await fs.promises.stat(snapshotDatabasePath);
      await copyEntry({
        source: snapshotDatabasePath,
        destination: restorableDatabasePath,
        bytes: snapshotDatabaseStat.size,
        mtimeMs: snapshotDatabaseStat.mtimeMs,
        partId: "app-snapshot",
        kind: "file"
      });
      const summary = await summarizeDirectory(snapshotDir);
      const part = getPart(job, "app-snapshot");
      const restorableDatabaseStat = await fs.promises.stat(restorableDatabasePath);
      part.filesTotal = summary.files + 1;
      part.bytesTotal = summary.bytes + restorableDatabaseStat.size;
      if (existed) {
        part.filesSkipped = summary.files;
        part.bytesSkipped = summary.bytes;
        part.filesCopied = 1;
        part.bytesCopied = restorableDatabaseStat.size;
        job.filesSkipped += summary.files;
        job.bytesSkipped += summary.bytes;
        job.filesCopied += 1;
        job.bytesCopied += restorableDatabaseStat.size;
      } else {
        part.filesCopied = summary.files + 1;
        part.bytesCopied = summary.bytes + restorableDatabaseStat.size;
        job.filesCopied += summary.files + 1;
        job.bytesCopied += summary.bytes + restorableDatabaseStat.size;
      }
      persistJobs();
    }

    const entries: CopyEntry[] = [];
    for (const group of groups) {
      const complete = await collectFiles(
        group.source,
        group.destination,
        group.partId,
        entries,
        () => runtime.pauseRequested || runtime.cancelRequested,
        group.excludedRoots,
        group.excludedNames
      );
      if (!complete) {
        job.status = runtime.cancelRequested ? "cancelled" : "paused";
        if (runtime.cancelRequested) job.completedAt = new Date().toISOString();
        persistJobs();
        return;
      }
    }
    const snapshotFiles = job.filesCopied + job.filesSkipped;
    const snapshotBytes = job.bytesCopied + job.bytesSkipped;
    job.filesTotal = snapshotFiles + entries.length;
    job.bytesTotal = snapshotBytes + entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      const part = getPart(job, entry.partId);
      part.filesTotal += 1;
      part.bytesTotal += entry.bytes;
    }
    const pendingEntries: CopyEntry[] = [];
    for (const entry of entries) {
      if (runtime.pauseRequested || runtime.cancelRequested) {
        job.status = runtime.cancelRequested ? "cancelled" : "paused";
        if (runtime.cancelRequested) job.completedAt = new Date().toISOString();
        persistJobs();
        return;
      }
      if (await filesMatch(entry)) {
        const part = getPart(job, entry.partId);
        part.filesSkipped += 1;
        part.bytesSkipped += entry.bytes;
        job.filesSkipped += 1;
        job.bytesSkipped += entry.bytes;
      } else {
        pendingEntries.push(entry);
      }
    }
    const requiredBytes = pendingEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    const freeBytes = inspectBackupTarget(job.targetRoot).freeBytes;
    if (freeBytes !== null && requiredBytes > freeBytes) {
      throw new Error(`目标剩余空间不足：需要写入 ${requiredBytes} 字节，剩余 ${freeBytes} 字节`);
    }
    job.status = "running";
    persistJobs();

    for (const entry of pendingEntries) {
      if (runtime.cancelRequested) {
        job.status = "cancelled";
        job.completedAt = new Date().toISOString();
        persistJobs();
        return;
      }
      if (runtime.pauseRequested) {
        job.status = "paused";
        persistJobs();
        return;
      }
      job.currentFile = entry.source;
      await copyEntry(entry);
      const part = getPart(job, entry.partId);
      part.filesCopied += 1;
      part.bytesCopied += entry.bytes;
      job.filesCopied += 1;
      job.bytesCopied += entry.bytes;
      if ((job.filesCopied + job.filesSkipped) % 10 === 0) persistJobs();
    }
    await writeRestoreBundle(job);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.currentFile = undefined;
    writeJsonAtomic(path.join(job.targetRoot, "latest-run.json"), job);
    persistJobs();
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.completedAt = new Date().toISOString();
    persistJobs();
  } finally {
    runtimes.delete(job.id);
  }
}

export function startBackupJob(input: { trigger?: "manual" | "automatic"; targetRoot: string; scopes: BackupScope[] }): BackupJob {
  if (jobs.some((job) => ["queued", "scanning", "running"].includes(job.status))) {
    throw new Error("已有备份任务正在执行");
  }
  const now = new Date();
  const job: BackupJob = {
    id: now.toISOString().replace(/[:.]/g, "-"),
    trigger: input.trigger ?? "manual",
    status: "queued",
    targetRoot: path.resolve(input.targetRoot),
    scopes: normalizeScopes(input.scopes),
    createdAt: now.toISOString(),
    filesTotal: 0,
    filesCopied: 0,
    filesSkipped: 0,
    bytesTotal: 0,
    bytesCopied: 0,
    bytesSkipped: 0,
    parts: [],
    excludedSources: []
  };
  jobs.unshift(job);
  persistJobs();
  const runtime = { job, pauseRequested: false, cancelRequested: false };
  runtimes.set(job.id, runtime);
  void run(runtime);
  return job;
}

export function controlBackupJob(id: string, action: "pause" | "resume" | "cancel"): BackupJob {
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error("备份任务不存在");
  const runtime = runtimes.get(id);
  if (action === "pause") {
    if (!runtime || !["queued", "scanning", "running"].includes(job.status)) throw new Error("当前任务无法暂停");
    runtime.pauseRequested = true;
  } else if (action === "cancel") {
    if (runtime) runtime.cancelRequested = true;
    else if (job.status === "paused") {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      persistJobs();
    } else throw new Error("当前任务无法取消");
  } else {
    if (job.status !== "paused") throw new Error("只有暂停的任务可以继续");
    job.filesTotal = 0;
    job.bytesTotal = 0;
    job.filesCopied = 0;
    job.bytesCopied = 0;
    job.filesSkipped = 0;
    job.bytesSkipped = 0;
    job.parts = [];
    const next = { job, pauseRequested: false, cancelRequested: false };
    runtimes.set(id, next);
    void run(next);
  }
  return job;
}

function shouldRunAutomatic(settings: BackupSettings, now: Date): boolean {
  if (!settings.enabled || now.getHours() !== settings.hour) return false;
  if (settings.frequency === "weekly" && now.getDay() !== settings.weekday) return false;
  const latest = jobs.find((job) => job.trigger === "automatic");
  if (!latest) return true;
  const latestDate = new Date(latest.createdAt);
  return settings.frequency === "daily"
    ? latestDate.toDateString() !== now.toDateString()
    : now.getTime() - latestDate.getTime() >= 6 * 24 * 60 * 60 * 1000;
}

export function startBackupManager(db: BetterSqlite3.Database): void {
  database = db;
  if (scheduler) return;
  const tick = () => {
    const settings = getBackupSettings();
    if (shouldRunAutomatic(settings, new Date()) && !jobs.some((job) => ["queued", "scanning", "running"].includes(job.status))) {
      startBackupJob({ trigger: "automatic", targetRoot: settings.targetRoot, scopes: settings.scopes });
    }
  };
  tick();
  scheduler = setInterval(tick, 60_000);
  scheduler.unref();
}

export function stopBackupManager(): void {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  for (const runtime of runtimes.values()) runtime.pauseRequested = true;
}
