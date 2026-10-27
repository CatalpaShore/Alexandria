import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile?.();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const label = "org.alexandria.public-agent-runtime";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeScript = path.join(projectRoot, "scripts/start-external-ai-runtime.mjs");
const ollamaBin = execFileSync("which", ["ollama"], { encoding: "utf8" }).trim();
const launchAgentsDir = path.join(os.homedir(), "Library/LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const uid = process.getuid();

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(runtimeScript)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>OLLAMA_BIN</key><string>${escapeXml(ollamaBin)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ThrottleInterval</key><integer>20</integer>
</dict>
</plist>
`;

fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
try {
  execFileSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
} catch {
  // Not loaded yet.
}
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
console.log(`Installed ${label} at ${plistPath}`);
