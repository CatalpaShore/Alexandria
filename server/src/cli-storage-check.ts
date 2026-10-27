import { config } from "./config.js";
import {
  formatStorageStatus,
  parseRemoteMounts,
  prepareStorageAccess
} from "./storageAccess.js";

const waitSeconds = Number.parseInt(process.env.AMW_STORAGE_WAIT_SECONDS ?? "20", 10);
const result = await prepareStorageAccess(config.mediaSources, {
  remoteMounts: parseRemoteMounts(process.env.AMW_REMOTE_MOUNTS),
  waitMs: Number.isFinite(waitSeconds) ? Math.max(0, waitSeconds) * 1_000 : 20_000
});

for (const source of result.sources) {
  console.log(`${source.readable ? "✓" : "!"} ${formatStorageStatus(source)}`);
}

if (result.ready === result.sources.length) {
  console.log(`全部 ${result.sources.length} 个媒体源均可读取。`);
} else {
  console.log(`仅 ${result.ready}/${result.sources.length} 个媒体源可读取；翻译队列会等待未恢复的源卷。`);
}

if (result.mountAttempts.length > 0) {
  console.log(`已请求连接远程卷：${result.mountAttempts.join("、")}`);
}

if (result.permissionSettingsOpened) {
  console.log("已打开 macOS 完全磁盘访问设置；授权启动后端的应用后请重新运行检查。");
}

if (result.ready !== result.sources.length) process.exitCode = 2;
