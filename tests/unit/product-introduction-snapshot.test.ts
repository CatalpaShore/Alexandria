import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Snapshot = {
  version: number;
  generatedAt: string;
  total: number;
  totalSize: number;
  actorAssetCount: number;
  favoriteMediaIds: string[];
  actorAssets: Array<{ imageUrl: string }>;
  mediaItems: Array<{ introPosterUrl: string }>;
};

const projectRoot = process.cwd();
const snapshotPath = path.join(projectRoot, "client", "src", "generated", "productIntroductionSnapshot.json");
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Snapshot;

function publicAssetPath(url: string): string {
  return path.join(projectRoot, "client", "public", url.replace(/^\//, ""));
}

describe("pre-generated product introduction snapshot", () => {
  it("contains enough fictional local data for every visual slot", () => {
    expect(snapshot.version).toBe(1);
    expect(Number.isNaN(Date.parse(snapshot.generatedAt))).toBe(false);
    expect(snapshot.total).toBeGreaterThan(0);
    expect(snapshot.totalSize).toBeGreaterThanOrEqual(0);
    expect(snapshot.mediaItems.length).toBeGreaterThanOrEqual(91);
    expect(snapshot.actorAssetCount).toBe(0);
    expect(snapshot.actorAssets).toHaveLength(0);
  });

  it("references only bundled static assets and every asset exists", () => {
    const urls = [
      ...snapshot.mediaItems.map((item) => item.introPosterUrl),
      ...snapshot.actorAssets.map((asset) => asset.imageUrl)
    ];
    expect(urls).not.toContain("/brand-icon.png");
    for (const url of urls) {
      expect(url.startsWith("/demo/")).toBe(true);
      expect(url.startsWith("/api/")).toBe(false);
      expect(fs.existsSync(publicAssetPath(url)), url).toBe(true);
    }
  });
});
