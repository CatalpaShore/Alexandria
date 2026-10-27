import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaSource } from "./config.js";

// Snapshots are hints, never authority: malformed or incompatible data is rejected so
// scanner.ts can fall back to a full scan before applying missing-file cleanup.
export const scanSnapshotVersion = 2;

export type ScanSnapshotFile = {
  name: string;
  kind: "media" | "sidecar";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
};

export type ScanDirectorySnapshot = {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  files: ScanSnapshotFile[];
  children: string[];
};

export type ScanSourceSnapshot = {
  category: string;
  name: string;
  root: string;
  directories: Record<string, ScanDirectorySnapshot>;
};

export type ScanSnapshot = {
  version: typeof scanSnapshotVersion;
  generatedAt: string;
  lastFullScanAt: string;
  sourcesFingerprint: string;
  sources: Record<string, ScanSourceSnapshot>;
};

export type ScanSnapshotLoadResult = {
  snapshot: ScanSnapshot | null;
  reason: "ready" | "missing" | "invalid" | "unreadable";
};

export function getScanSnapshotPath(dataDir: string): string {
  return path.join(dataDir, "scan-snapshots.json");
}

export function createScanSourceKey(source: MediaSource): string {
  return crypto
    .createHash("sha256")
    .update(`${source.category}\0${source.name}\0${path.resolve(source.root)}`)
    .digest("hex")
    .slice(0, 20);
}

export function fingerprintScanSources(sources: MediaSource[]): string {
  const normalized = sources
    .map((source) => ({
      category: source.category,
      name: source.name,
      root: path.resolve(source.root)
    }))
    .sort((left, right) =>
      `${left.category}\0${left.name}\0${left.root}`.localeCompare(
        `${right.category}\0${right.name}\0${right.root}`
      )
    );

  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSnapshotFile(value: unknown): value is ScanSnapshotFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ScanSnapshotFile>;
  return (
    typeof file.name === "string" &&
    (file.kind === "media" || file.kind === "sidecar") &&
    isFiniteNumber(file.size) &&
    isFiniteNumber(file.mtimeMs) &&
    isFiniteNumber(file.ctimeMs) &&
    isFiniteNumber(file.ino)
  );
}

function isDirectorySnapshot(value: unknown): value is ScanDirectorySnapshot {
  if (!value || typeof value !== "object") return false;
  const directory = value as Partial<ScanDirectorySnapshot>;
  return (
    isFiniteNumber(directory.mtimeMs) &&
    isFiniteNumber(directory.ctimeMs) &&
    isFiniteNumber(directory.size) &&
    isFiniteNumber(directory.ino) &&
    Array.isArray(directory.files) &&
    directory.files.every(isSnapshotFile) &&
    Array.isArray(directory.children) &&
    directory.children.every((child) => typeof child === "string")
  );
}

function isSourceSnapshot(value: unknown): value is ScanSourceSnapshot {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<ScanSourceSnapshot>;
  return (
    typeof source.category === "string" &&
    typeof source.name === "string" &&
    typeof source.root === "string" &&
    Boolean(source.directories) &&
    typeof source.directories === "object" &&
    Object.values(source.directories).every(isDirectorySnapshot)
  );
}

function isScanSnapshot(value: unknown): value is ScanSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ScanSnapshot>;
  return (
    snapshot.version === scanSnapshotVersion &&
    typeof snapshot.generatedAt === "string" &&
    typeof snapshot.lastFullScanAt === "string" &&
    typeof snapshot.sourcesFingerprint === "string" &&
    Boolean(snapshot.sources) &&
    typeof snapshot.sources === "object" &&
    Object.values(snapshot.sources).every(isSourceSnapshot)
  );
}

export async function loadScanSnapshot(dataDir: string): Promise<ScanSnapshotLoadResult> {
  try {
    const raw = await fs.readFile(getScanSnapshotPath(dataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isScanSnapshot(parsed)
      ? { snapshot: parsed, reason: "ready" }
      : { snapshot: null, reason: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshot: null, reason: "missing" };
    }
    if (error instanceof SyntaxError) {
      return { snapshot: null, reason: "invalid" };
    }
    return { snapshot: null, reason: "unreadable" };
  }
}

export async function saveScanSnapshot(dataDir: string, snapshot: ScanSnapshot): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const snapshotPath = getScanSnapshotPath(dataDir);
  const temporaryPath = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  await fs.rename(temporaryPath, snapshotPath);
}

export function getSnapshotMediaPaths(snapshot: ScanSnapshot): Set<string> {
  const paths = new Set<string>();
  for (const source of Object.values(snapshot.sources)) {
    const prefix = `${source.category}/${source.name}`;
    for (const [directory, entry] of Object.entries(source.directories)) {
      for (const file of entry.files) {
        if (file.kind !== "media") continue;
        paths.add(`${prefix}/${directory ? `${directory}/` : ""}${file.name}`);
      }
    }
  }
  return paths;
}
