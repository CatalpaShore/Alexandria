import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// TypeScript preserves old output; clean it so excluded local modules cannot ship as stale files.
fs.rmSync(path.join(project, "dist/server"), {recursive: true, force: true});
execFileSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"), "-p", "server/tsconfig.json"], {cwd: project, stdio: "inherit"});
