import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(projectRoot, "data"));
const databasePath = path.join(dataDir, "media-wall.sqlite");
const backfillLogPath = path.join(dataDir, "metadata-all-backfill.log");
const outputPath = path.join(projectRoot, "seed", "ingestion-history.json");
const entries = new Map();

const db = new Database(databasePath, { readonly: true });
try {
  const automaticRows = db.prepare(`
    SELECT normalized_code AS normalizedCode, MIN(created_at) AS ingestedAt
    FROM ingestion_items
    WHERE status = 'moved' AND normalized_code != ''
    GROUP BY normalized_code
  `).all();
  for (const row of automaticRows) {
    entries.set(row.normalizedCode, { ...row, source: "automatic" });
  }
} finally {
  db.close();
}

if (fs.existsSync(backfillLogPath)) {
  const lines = fs.readFileSync(backfillLogPath, "utf8").split("\n");
  const candidateLine = lines.find((line) => line.includes("dry run candidates=FC2:"));
  const startedLine = lines.find((line) =>
    line.includes("controller started") && line.includes("dryRun=false") && line.includes("candidates=131")
  );
  if (candidateLine && startedLine) {
    const ingestedAt = startedLine.slice(0, startedLine.indexOf(" "));
    const codes = candidateLine.split("dry run candidates=")[1]
      .split(",")
      .map((value) => value.replace(/^(FC2|JAV):/, "").trim())
      .filter(Boolean);
    for (const normalizedCode of codes) {
      if (!entries.has(normalizedCode)) {
        entries.set(normalizedCode, { normalizedCode, ingestedAt, source: "metadata-backfill" });
      }
    }
  }
}

const payload = {
  version: 1,
  exportedAt: new Date().toISOString(),
  entries: [...entries.values()].sort((left, right) =>
    right.ingestedAt.localeCompare(left.ingestedAt) || left.normalizedCode.localeCompare(right.normalizedCode)
  )
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Ingestion history seed exported: ${payload.entries.length} entries -> ${outputPath}`);
