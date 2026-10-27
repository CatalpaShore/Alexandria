import { beforeAll, describe, expect, it } from "vitest";
import {seedNeutralLibrary} from "./neutralLibraryFixture.js";
import {
  ANALYTICS_METRIC_DEFINITIONS,
  getLibraryAnalyticsSnapshot,
  getLibraryAnalyticsSummary,
  getMatrixEvidence,
  projectLibraryAnalyticsSnapshot
} from "../../server/src/libraryAnalyticsRoutes.js";

describe("library analytics content universe", () => {
  let snapshot: ReturnType<typeof getLibraryAnalyticsSnapshot>;

  beforeAll(() => {
    seedNeutralLibrary();
    snapshot = getLibraryAnalyticsSnapshot(null);
  });

  it("builds expanded canonical actor and genre matrices with stable evidence", () => {
    const affinity = snapshot.actorAnalytics.genreAffinity;

    expect(affinity.actors.length).toBeGreaterThan(12);
    expect(affinity.genres.length).toBeGreaterThan(10);
    expect(new Set(affinity.actors.map((item) => item.value)).size).toBe(affinity.actors.length);
    expect(new Set(affinity.genres.map((item) => item.value)).size).toBe(affinity.genres.length);
    expect(affinity.actors.every((item) => (item.aliases?.length ?? 0) > 0)).toBe(true);
    expect(affinity.genres.every((item) => item.aliases.length > 0 && item.group.length > 0)).toBe(true);

    for (const cell of affinity.cells) {
      expect(cell.works).toBeGreaterThan(0);
      expect(cell.actorShare).toBeGreaterThan(0);
      expect(cell.actorShare).toBeLessThanOrEqual(1);
      expect(Number.isFinite(cell.smoothedLift)).toBe(true);
      expect(cell.confidence).toBeGreaterThanOrEqual(0);
      expect(cell.confidence).toBeLessThanOrEqual(1);
      expect(cell.expectedWorks).toBeGreaterThanOrEqual(0);
    }
  });

  it("exposes all cross-analysis matrices and resolvable deterministic signals", () => {
    const expectedIds = [
      "actor-genre",
      "maker-genre",
      "director-genre",
      "series-actor",
      "genre-year",
      "source-resolution",
      "source-compatibility",
      "provider-gaps"
    ];
    expect(snapshot.crossAnalysis.matrices.map((matrix) => matrix.id)).toEqual(expectedIds);

    for (const matrix of snapshot.crossAnalysis.matrices) {
      expect(matrix.rows.length).toBeGreaterThan(0);
      expect(matrix.columns.length).toBeGreaterThan(0);
      expect(matrix.total).toBeGreaterThan(0);
      expect(matrix.cells.every((cell) => cell.value > 0 && Number.isFinite(cell.smoothedLift))).toBe(true);
    }

    for (const signal of snapshot.crossAnalysis.signals) {
      const matrix = snapshot.crossAnalysis.matrices.find((item) => item.id === signal.matrixId);
      expect(matrix).toBeDefined();
      expect(matrix?.rows.some((item) => item.key === signal.rowKey)).toBe(true);
      expect(matrix?.columns.some((item) => item.key === signal.columnKey)).toBe(true);
      expect(matrix?.cells.some((item) => item.rowKey === signal.rowKey && item.columnKey === signal.columnKey)).toBe(true);
      if (["actor-genre", "maker-genre", "director-genre"].includes(matrix?.id ?? "")) {
        const column = matrix?.columns.find((item) => item.key === signal.columnKey);
        expect(["theme", "persona"]).toContain(column?.group);
      }
    }
  });

  it("keeps the fast summary on the same scope and metric contract as the full snapshot", () => {
    const summary = getLibraryAnalyticsSummary(null);

    expect(summary.scope).toMatchObject({ year: null, label: "全部馆藏", dateField: "release_date" });
    expect(summary.summary).toEqual(snapshot.summary);
    expect(summary.availableYears).toEqual(snapshot.availableYears);
    expect(summary.contract).toMatchObject({
      version: snapshot.contract.version,
      workIdentity: "normalized_code",
      releaseDateField: "media_metadata.release_date"
    });
    expect(summary.contract.metrics).toEqual(ANALYTICS_METRIC_DEFINITIONS);
    expect(new Set(summary.contract.metrics.map((metric) => metric.key)).size)
      .toBe(summary.contract.metrics.length);
    expect(summary.contract.metrics.every((metric) => (
      metric.definition.length > 0 && metric.denominator.length > 0 && metric.source.length > 0
    ))).toBe(true);
  });

  it("projects each lazy section without leaking unrelated heavy datasets", () => {
    const overview = projectLibraryAnalyticsSnapshot(snapshot, "overview");
    const time = projectLibraryAnalyticsSnapshot(snapshot, "time");
    const content = projectLibraryAnalyticsSnapshot(snapshot, "content");
    const technical = projectLibraryAnalyticsSnapshot(snapshot, "technical");
    const operations = projectLibraryAnalyticsSnapshot(snapshot, "operations");
    const quality = projectLibraryAnalyticsSnapshot(snapshot, "quality");
    const prefixes = projectLibraryAnalyticsSnapshot(snapshot, "content", "prefixes");
    expect(prefixes.prefixAnalytics).toEqual(snapshot.prefixAnalytics);
    expect(prefixes.facets.actor.items).toHaveLength(0);
    expect(prefixes.crossAnalysis.matrices).toHaveLength(0);
    expect(prefixes.prefixAnalytics.totalWorks).toBe(snapshot.summary.works);
    expect(prefixes.prefixAnalytics.items.every(item=>item.works<=item.knownWorks&&item.releaseCoverage===null)).toBe(true);

    expect(overview.releaseHistory).toEqual(snapshot.releaseHistory);
    expect(overview.contentMatrix.cells).toHaveLength(0);
    expect(overview.technical.resolutions).toHaveLength(0);

    expect(time.releaseHeatmap).toEqual(snapshot.releaseHeatmap);
    expect(time.actorAnalytics.genreAffinity.cells).toHaveLength(0);

    expect(content.crossAnalysis.matrices).toEqual(snapshot.crossAnalysis.matrices);
    expect(content.actorAnalytics.genreAffinity.cells).toEqual(snapshot.actorAnalytics.genreAffinity.cells);
    expect(content.releaseHistory).toHaveLength(0);
    expect(content.operations.jobTypes).toHaveLength(0);

    expect(technical.technical).toEqual(snapshot.technical);
    expect(technical.crossAnalysis.matrices).toHaveLength(0);

    expect(operations.operations).toEqual(snapshot.operations);
    expect(operations.dataQuality.backlog).toHaveLength(0);

    expect(quality.dataQuality).toEqual(snapshot.dataQuality);
    expect(quality.entityKnowledge).toEqual(snapshot.entityKnowledge);
    expect(quality.releaseHistory).toHaveLength(0);

    for (const section of [overview, time, content, technical, operations, quality]) {
      expect(section.contract).toEqual(snapshot.contract);
      expect(section.scope).toEqual(snapshot.scope);
      expect(section.summary).toEqual(snapshot.summary);
    }
    expect(projectLibraryAnalyticsSnapshot(snapshot, "details")).toBe(snapshot);
  });

  it("uses real release dates for matrix evidence and keeps undated works explicit", () => {
    const cell = snapshot.actorAnalytics.genreAffinity.cells[0];
    expect(cell).toBeDefined();
    const evidence = getMatrixEvidence(cell.actorValue, cell.genreValue, null, 5);

    expect(evidence.actor.aliases).toContain(cell.actorValue);
    expect(evidence.genre.aliases).toContain(cell.genreValue);
    expect(evidence.total).toBe(evidence.datedWorks + evidence.undatedWorks);
    expect(evidence.items).toHaveLength(Math.min(5, evidence.total));
    expect(new Set(evidence.items.map((item) => item.normalizedCode)).size).toBe(evidence.items.length);
    expect(evidence.recentWorks + evidence.previousWorks).toBeLessThanOrEqual(evidence.datedWorks);

    for (const item of evidence.items) {
      if (item.releaseDate === null) {
        expect(item).toMatchObject({ releaseYear: null, period: "undated" });
      } else {
        expect(item.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}/u);
        expect(item.releaseYear).toBe(Number(item.releaseDate.slice(0, 4)));
        expect(["recent", "previous", "historical"]).toContain(item.period);
      }
    }
  });
});
