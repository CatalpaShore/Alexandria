import fs from "node:fs";
import path from "node:path";

const required = [
  "package.json",
  "client/src/main.tsx",
  "client/src/App.tsx",
  "server/src/index.ts",
  "server/src/scanner.ts",
  "server/src/mediaJobs.ts",
  "server/src/mediaProbe.ts",
  "server/src/mediaDerivatives.ts",
  "server/src/productRoutes.ts",
  "client/src/components/SavedFiltersDrawer.tsx",
  "client/src/components/EntityDrawer.tsx",
  "client/src/components/MetadataQualityDrawer.tsx",
  "client/src/components/CompatibilityCenterDrawer.tsx",
  "Dockerfile",
  "docker-compose.yml"
];

const missing = required.filter((file) => !fs.existsSync(path.resolve(file)));

if (missing.length > 0) {
  console.error(`Missing required files:\n${missing.join("\n")}`);
  process.exit(1);
}

console.log("Smoke check passed.");
