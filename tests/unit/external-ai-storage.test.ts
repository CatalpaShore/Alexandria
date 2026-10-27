import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentCapabilities } from "../../server/src/agentCapabilities.js";
import { inspectExternalAiStorage } from "../../server/src/externalAiStorage.js";

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amw-external-ai-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("external AI storage preflight", () => {
  it("reports a missing drive without creating its configured directory", () => {
    const parent = createTemporaryRoot();
    const root = path.join(parent, "not-mounted", "AdultMediaWallAI");
    const status = inspectExternalAiStorage({
      enabled: true,
      root,
      markerFile: ".alexandria-ai-volume.json"
    });

    expect(status).toMatchObject({ state: "missing", ready: false, readable: false, writable: false });
    expect(fs.existsSync(root)).toBe(false);
  });

  it("requires an Alexandria marker before accepting a writable directory", () => {
    const root = createTemporaryRoot();
    const status = inspectExternalAiStorage({
      enabled: true,
      root,
      markerFile: ".alexandria-ai-volume.json"
    });

    expect(status).toMatchObject({ state: "uninitialized", ready: false, readable: true, writable: true });
  });

  it("accepts only a marker with the configured storage identity", () => {
    const root = createTemporaryRoot();
    const markerFile = ".alexandria-ai-volume.json";
    fs.writeFileSync(
      path.join(root, markerFile),
      JSON.stringify({ product: "alexandria-ai", storageId: "example-primary" }),
      "utf8"
    );

    expect(inspectExternalAiStorage({
      enabled: true,
      root,
      markerFile,
      expectedStorageId: "example-primary"
    })).toMatchObject({ state: "ready", ready: true, storageId: "example-primary" });

    expect(inspectExternalAiStorage({
      enabled: true,
      root,
      markerFile,
      expectedStorageId: "another-drive"
    })).toMatchObject({ state: "identity-mismatch", ready: false });
  });

  it("re-evaluates hot-unplug and reinsertion without retaining stale readiness", () => {
    const parent = createTemporaryRoot();
    const root = path.join(parent, "ExampleDrive", "AdultMediaWallAI");
    const markerFile = ".alexandria-ai-volume.json";
    const options = {
      enabled: true,
      root,
      markerFile,
      expectedStorageId: "example-hot-plug"
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, markerFile),
      JSON.stringify({ product: "alexandria-ai", storageId: "example-hot-plug" }),
      "utf8"
    );
    expect(inspectExternalAiStorage(options)).toMatchObject({ state: "ready", ready: true });

    fs.rmSync(path.join(parent, "ExampleDrive"), { recursive: true, force: true });
    expect(inspectExternalAiStorage(options)).toMatchObject({ state: "missing", ready: false });
    expect(fs.existsSync(root)).toBe(false);

    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, markerFile),
      JSON.stringify({ product: "alexandria-ai", storageId: "example-hot-plug" }),
      "utf8"
    );
    expect(inspectExternalAiStorage(options)).toMatchObject({ state: "ready", ready: true });
  });

  it("keeps Agent unavailable while explicitly preserving existing platform chains", () => {
    const capabilities = getAgentCapabilities({
      enabled: true,
      root: path.join(createTemporaryRoot(), "missing"),
      markerFile: ".alexandria-ai-volume.json"
    });

    expect(capabilities).toMatchObject({
      implementationStage: "phase-1-foundation",
      agentAvailable: false,
      unavailableCode: "AGENT_STORAGE_UNAVAILABLE",
      isolation: {
        internalFallbackAllowed: false,
        existingPlatformUnaffected: true,
        currentTranslationMode: "legacy-unchanged",
        completedSubtitlesRemainInternal: true
      }
    });
  });
});
