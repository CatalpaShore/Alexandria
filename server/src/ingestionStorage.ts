import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type IngestionStorageSource = {
  label: string;
  downloadRoot: string;
  libraryRoot: string;
};

async function verifyDirectoryRenameAccess(directory: string, label: string): Promise<void> {
  const probeId = crypto.randomUUID();
  const sourceProbe = path.join(directory, `.amw-ingestion-probe-${probeId}.tmp`);
  const targetProbe = path.join(directory, `.amw-ingestion-probe-${probeId}.ready`);
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) throw new Error("路径不是目录");
    await fs.writeFile(sourceProbe, "ingestion-write-probe", { flag: "wx" });
    await fs.rename(sourceProbe, targetProbe);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知错误";
    throw new Error(
      `自动入库存储预检失败：${label}不可写或不允许重命名（${directory}）。` +
      `请确认磁盘已挂载，并从拥有外接磁盘写权限的终端启动服务。 原因：${detail}`
    );
  } finally {
    await fs.rm(sourceProbe, { force: true }).catch(() => undefined);
    await fs.rm(targetProbe, { force: true }).catch(() => undefined);
  }
}

export async function assertIngestionStorageAccess(sources: IngestionStorageSource[]): Promise<void> {
  for (const source of sources) {
    await verifyDirectoryRenameAccess(source.downloadRoot, `${source.label}下载目录`);
    await verifyDirectoryRenameAccess(source.libraryRoot, `${source.label}媒体库目录`);
  }
}
