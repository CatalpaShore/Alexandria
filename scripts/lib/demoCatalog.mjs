import fs from "node:fs";
import path from "node:path";

// The same reviewed catalog ships with both the static client and demo generator.
const catalogFile = ["client/public/demo/films/catalog.json", "dist/client/demo/films/catalog.json"].find(file => fs.existsSync(file));
if (!catalogFile) throw new Error("Missing bundled demo film catalog");
export const demoCatalog = JSON.parse(fs.readFileSync(path.resolve(catalogFile), "utf8")).films;
export const demoManifestKind = "alexandria-open-film-mock-v2";
export function demoStem(film, index) { return path.join(film.collection, `DEMO-${String(index + 1).padStart(3, "0")}-${film.slug}`); }
