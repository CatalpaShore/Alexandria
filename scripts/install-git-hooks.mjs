import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "inherit" });
  console.log("Git hooks installed from .githooks");
} catch (error) {
  console.error("Unable to install Git hooks. Run this command inside the repository.");
  process.exitCode = 1;
}
