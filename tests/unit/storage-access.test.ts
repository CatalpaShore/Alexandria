import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getVolumeMountPoint,
  hasRequiredStorageAccess,
  inspectStorageSource,
  parseRemoteMounts,
  summarizeStorageAvailability,
  toSmbMountTarget
} from "../../server/src/storageAccess";
import {
  shouldAllowDegradedStorageStartup,
  shouldAttemptStorageMount
} from "../../server/src/storageRecovery";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("storage access preflight", () => {
  it("distinguishes readable directories from missing paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-storage-"));
    temporaryRoots.push(root);

    const ready = inspectStorageSource({ category: "JAV", name: "Fixture", root });
    const missing = inspectStorageSource({
      category: "JAV",
      name: "Missing",
      root: path.join(root, "not-mounted")
    });

    expect(ready).toMatchObject({ state: "ready", readable: true, errorCode: null });
    expect(missing).toMatchObject({ state: "missing", readable: false, errorCode: "ENOENT" });
  });

  it("does not treat a stale macOS volume directory as a mounted source", () => {
    // The mount-table probe is intentionally a no-op outside macOS, where the
    // fixture directory is a normal local path and should remain readable.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-storage-volume-"));
    temporaryRoots.push(root);
    expect(inspectStorageSource({ category: "JAV", name: "Fixture", root })).toMatchObject({
      readable: true,
      state: "ready"
    });
  });

  it("accepts only supported remote mount URLs", () => {
    const mounts = parseRemoteMounts(
      "media-one=smb://nas.local/media-one;media-two=afp://nas.local/media-two;bad=https://example.com"
    );

    expect([...mounts.entries()]).toEqual([
      ["media-one", "smb://nas.local/media-one"],
      ["media-two", "afp://nas.local/media-two"]
    ]);
  });

  it("normalizes password-free SMB URLs for headless recovery", () => {
    expect(toSmbMountTarget("smb://user@nas.local/share/folder")).toBe("//user@nas.local/share/folder");
    expect(toSmbMountTarget("smb://user:secret@nas.local/share")).toBeNull();
    expect(toSmbMountTarget("https://nas.local/share")).toBeNull();
  });

  it("extracts a macOS volume mount point without exposing deeper paths", () => {
    const expected = process.platform === "darwin" ? "/Volumes/media-one" : null;
    expect(getVolumeMountPoint("/Volumes/media-one/Adult_Library/Japan")).toBe(expected);
  });

  it("throttles remote mount attempts while sources remain unavailable", () => {
    expect(shouldAttemptStorageMount({
      allReady: false,
      remoteMountCount: 2,
      nowMs: 1_000,
      lastAttemptMs: 0,
      retryMs: 300_000,
      mountAttemptCount: 0,
      maxMountAttempts: 5
    })).toBe(true);
    expect(shouldAttemptStorageMount({
      allReady: false,
      remoteMountCount: 2,
      nowMs: 60_000,
      lastAttemptMs: 1_000,
      retryMs: 300_000,
      mountAttemptCount: 1,
      maxMountAttempts: 5
    })).toBe(false);
    expect(shouldAttemptStorageMount({
      allReady: false,
      remoteMountCount: 2,
      nowMs: 60_000,
      lastAttemptMs: 1_000,
      retryMs: 300_000,
      mountAttemptCount: 1,
      maxMountAttempts: 5,
      force: true
    })).toBe(true);
    expect(shouldAttemptStorageMount({
      allReady: true,
      remoteMountCount: 2,
      nowMs: 400_000,
      lastAttemptMs: 1_000,
      retryMs: 300_000,
      mountAttemptCount: 1,
      maxMountAttempts: 5
    })).toBe(false);
  });

  it("stops issuing remote mount commands after the configured attempt limit", () => {
    expect(shouldAttemptStorageMount({
      allReady: false,
      remoteMountCount: 2,
      nowMs: 2_000_000,
      lastAttemptMs: 1_000,
      retryMs: 300_000,
      mountAttemptCount: 5,
      maxMountAttempts: 5
    })).toBe(false);
    expect(shouldAttemptStorageMount({
      allReady: false,
      remoteMountCount: 2,
      nowMs: 2_000_000,
      lastAttemptMs: 1_000,
      retryMs: 300_000,
      mountAttemptCount: 5,
      maxMountAttempts: 5,
      force: true
    })).toBe(false);
  });

  it("allows degraded startup only when bounded remote recovery can take over", () => {
    expect(shouldAllowDegradedStorageStartup({
      storageRequired: true,
      hasRequiredAccess: false,
      recoveryEnabled: true,
      remoteMountCount: 2
    })).toBe(true);
    expect(shouldAllowDegradedStorageStartup({
      storageRequired: true,
      hasRequiredAccess: false,
      recoveryEnabled: true,
      remoteMountCount: 0
    })).toBe(false);
    expect(shouldAllowDegradedStorageStartup({
      storageRequired: true,
      hasRequiredAccess: false,
      recoveryEnabled: false,
      remoteMountCount: 2
    })).toBe(false);
    expect(shouldAllowDegradedStorageStartup({
      storageRequired: true,
      hasRequiredAccess: true,
      recoveryEnabled: true,
      remoteMountCount: 2
    })).toBe(false);
  });

  it("distinguishes server startup readiness from full-library readiness", () => {
    expect(hasRequiredStorageAccess({ sources: [{}, {}], ready: 1 }, true)).toBe(false);
    expect(hasRequiredStorageAccess({ sources: [{}, {}], ready: 1 }, false)).toBe(true);
    expect(hasRequiredStorageAccess({ sources: [{}, {}], ready: 2 }, true)).toBe(true);
    expect(hasRequiredStorageAccess({ sources: [], ready: 0 }, true)).toBe(false);
  });

  it("exposes solid-state-only catalog mode when every video source is offline", () => {
    expect(summarizeStorageAvailability([
      { name: "Japan-1", readable: false },
      { name: "Japan-2", readable: false }
    ])).toEqual({
      mode: "solid-state-only",
      connectedSources: 0,
      totalSources: 2,
      connectedSourceNames: [],
      videoPlaybackAvailable: false,
      message: "当前仅使用固态硬盘中的馆藏索引、元数据和缓存图片；视频源暂未连接"
    });
    expect(summarizeStorageAvailability([
      { name: "Japan-1", readable: true },
      { name: "Japan-2", readable: false }
    ])).toMatchObject({
      mode: "partial",
      connectedSources: 1,
      connectedSourceNames: ["Japan-1"],
      videoPlaybackAvailable: true
    });
  });
});
