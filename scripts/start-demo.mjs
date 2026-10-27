import fs from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { verifyPublicDemo } from "./lib/publicDemoIntegrity.mjs";

await fs.access("dist/server/index.js").catch(() => { throw new Error("Build first: pnpm build"); });
execFileSync(process.execPath, ["scripts/create-demo.mjs", "--public"], { stdio: "inherit" });
await verifyPublicDemo();
const child = spawn(process.execPath, ["dist/server/index.js"], {
  env: { ...process.env, AMW_DEMO_MODE: "true", PORT: process.env.PORT || "4312" }, stdio: "inherit"
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 0));
