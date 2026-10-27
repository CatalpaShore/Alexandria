import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const architecture = execFileSync("docker", ["info", "--format", "{{.Architecture}}"], {encoding: "utf8"}).trim();
const platform = process.env.MEDIA_WORKER_BUILD_PLATFORM ?? (architecture === "aarch64" || architecture === "arm64" ? "linux/arm64" : "linux/amd64");
if (!["linux/arm64", "linux/amd64"].includes(platform)) throw new Error("Unsupported worker platform");
const tag = process.env.MEDIA_WORKER_BUILD_IMAGE ?? `alexandria-worker:${platform.split("/")[1]}`;
execFileSync("docker", ["build", "--platform", platform, "-t", tag, project], {stdio: "inherit"});
console.log(`Worker built: ${tag} (${platform}). Set HIGHLIGHT_WORKER_IMAGE and use compose.native-highlights.yaml.`);
