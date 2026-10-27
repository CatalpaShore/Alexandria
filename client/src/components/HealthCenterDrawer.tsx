import { getIntlLocale } from "../i18n/core";
import { t, useLocale } from "../i18n";
import { Alert, Descriptions, Drawer, Progress, Skeleton, Space, Statistic, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Activity, Database, Gauge, HardDrive, Image, PlayCircle, Wrench } from "lucide-react";
import { fetchHealthSummary, formatBytes } from "../lib/api";
import "../operations-diagnostics.css";

type HealthCenterDrawerProps = {
  open: boolean;
  onClose: () => void;
};

const { Text } = Typography;

export type OperationsMaintenanceReport = {
  id: number;
  reason: "startup" | "database" | "derivatives" | "temporary-files" | "manual";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  database: {
    checkpoint: { busy: number; log: number; checkpointed: number } | null;
    freelistBytes: number;
    integrityQuarantined: number;
    jobsRemoved: number;
    missingCacheRowsRemoved: number;
    optimizedAt: string;
    sidecarsRemoved: number;
    durationMs: number;
  } | null;
  derivativeIndex: { updated: number; missing: number; durationMs: number } | null;
  temporaryFiles: { removed: number; bytes: number; durationMs: number } | null;
  errors: Array<{ operation: string; message: string }>;
};

export type OperationsDiagnosticsResponse = {
  generatedAt: string;
  uptimeSeconds: number;
  process: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  requests: {
    active: number;
    requests: number;
    errors: number;
    rejected: number;
    errorRatePercent: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    routes: Array<{
      route: string;
      requests: number;
      errors: number;
      rejected: number;
      errorRatePercent: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
    }>;
  };
  database: {
    databaseBytes: number;
    walBytes: number;
    sharedMemoryBytes: number;
    pageSize: number;
    pageCount: number;
    freelistPages: number;
    freelistBytes: number;
    freeRatioPercent: number;
    journalMode: string;
    autoVacuum: number;
  };
  jobs: {
    workerRunning: boolean;
    playbackActive: boolean;
    probeToolAvailable: boolean;
    ffmpegToolAvailable: boolean;
    pending: number;
    running: number;
    failed: number;
    failedLast24Hours: number;
    retryScheduled: number;
    expiredLeases: number;
    oldestPendingAgeSeconds: number | null;
    oldestRunningAgeSeconds: number | null;
    schedule: {
      timeZone: string;
      nightStartHour: number;
      nightEndHour: number;
      daytimeCooldownMs: number;
      localHour: number;
      nightWindowActive: boolean;
      daytimeBackgroundDue: boolean;
      backgroundAllowed: boolean;
      foregroundPriority: number;
      processNiceness: number;
      ffmpegThreads: number;
    };
  };
  temporaryFiles: { count: number; bytes: number; staleCount: number; staleBytes: number };
  scanning: {
    active: boolean;
    latest: {
      indexed: number;
      unchanged: number;
      changed: number;
      removed: number;
      scanMode: "full" | "incremental";
      fullScanReason: string;
      directoriesRead: number;
      directoriesSkipped: number;
      snapshotSaved: boolean;
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      roots: Array<{ name: string; indexed: number }>;
    } | null;
  };
  maintenance: {
    started: boolean;
    startedAt: string | null;
    running: boolean;
    currentReason: string | null;
    skippedRuns: number;
    schedule: {
      startupDelayMs: number;
      databaseIntervalMs: number;
      derivativeIntervalMs: number;
      temporaryFileIntervalMs: number;
      temporaryFileMaxAgeMs: number;
    } | null;
    lastReport: OperationsMaintenanceReport | null;
    recentReports: OperationsMaintenanceReport[];
  };
  alerts: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
};

export async function fetchOperationsDiagnostics(): Promise<OperationsDiagnosticsResponse> {
  const response = await fetch("/api/diagnostics", { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `诊断数据读取失败：${response.status}`);
  }
  return response.json() as Promise<OperationsDiagnosticsResponse>;
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function formatHours(seconds: number): string {
  if (!seconds || seconds <= 0) return "-";
  return t("{{p0}} 小时", { p0: Math.round(seconds / 3600).toLocaleString(getIntlLocale()) });
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return "-";
  if (seconds < 60) return t("{{p0}} 秒", { p0: seconds });
  if (seconds < 3600) return t("{{p0}} 分钟", { p0: Math.round(seconds / 60) });
  return t("{{p0}} 小时", { p0: (seconds / 3600).toFixed(1) });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "-" : date.toLocaleString(getIntlLocale(), { hour12: false });
}

export function HealthCenterDrawer({ open, onClose }: HealthCenterDrawerProps) {
  useLocale();
  const health = useQuery({
    queryKey: ["health-summary"],
    queryFn: fetchHealthSummary,
    enabled: open,
    refetchInterval: (queryState) => (queryState.state.data?.scanning ? 2500 : false)
  });
  const diagnostics = useQuery({
    queryKey: ["operations-diagnostics"],
    queryFn: fetchOperationsDiagnostics,
    enabled: open,
    refetchInterval: open ? 5_000 : false,
    retry: false
  });
  const data = health.data;
  const operations = diagnostics.data;
  const metadataReadyPercent = data ? percent(data.metadata.ready, data.metadata.total) : 0;
  const thumbnailReadyCount =
    data?.thumbnails.statuses.find((status) => status.value === "ready")?.count ?? 0;
  const thumbnailReadyPercent = data ? percent(thumbnailReadyCount, data.totals.count) : 0;

  return (
    <Drawer
      className="health-drawer"
      onClose={onClose}
      open={open}
      placement="right"
      title={t("数据健康中心")}
      size={560}
    >
      {health.isLoading && <Skeleton active paragraph={{ rows: 8 }} />}
      {health.error && (
        <Alert
          message={health.error instanceof Error ? health.error.message : "健康数据读取失败"}
          type="error"
        />
      )}
      {data && (
        <div className="health-shell">
          <div className="health-stat-grid">
            <Statistic prefix={<Database size={16} />} title={t("文件")} value={data.totals.count} />
            <Statistic prefix={<HardDrive size={16} />} title={t("容量")} value={formatBytes(data.totals.totalSize)} />
            <Statistic prefix={<PlayCircle size={16} />} title="片库时长" value={formatHours(data.totals.totalDurationSeconds)} />
            <Statistic prefix={<Activity size={16} />} title={t("收藏")} value={data.favorites.count} />
          </div>

          {diagnostics.error && (
            <Alert
              className="operations-diagnostics-alert"
              message="运维诊断接口尚未接入或暂不可用"
              description={diagnostics.error instanceof Error ? diagnostics.error.message : undefined}
              showIcon
              type="warning"
            />
          )}

          {operations && (
            <section className="health-section operations-overview">
              <div className="health-section-title">
                <Text strong>运行状态</Text>
                <Space size={6}>
                  {operations.scanning.active && <Tag color="processing">扫描中</Tag>}
                  {operations.maintenance.running && <Tag color="processing">维护中</Tag>}
                  <Tag color={operations.alerts.some((item) => item.severity === "error") ? "error" : operations.alerts.length ? "warning" : "success"}>
                    {operations.alerts.length ? `${operations.alerts.length} 项提醒` : "运行正常"}
                  </Tag>
                </Space>
              </div>
              <div className="operations-stat-grid">
                <Statistic prefix={<Gauge size={16} />} title="API P95" value={operations.requests.p95Ms} suffix="ms" />
                <Statistic prefix={<Activity size={16} />} title="错误率" value={operations.requests.errorRatePercent} suffix="%" />
                <Statistic prefix={<Database size={16} />} title="WAL" value={formatBytes(operations.database.walBytes)} />
                <Statistic prefix={<Wrench size={16} />} title="待处理任务" value={operations.jobs.pending} />
              </div>
              {operations.alerts.length > 0 && (
                <div className="operations-alert-list">
                  {operations.alerts.map((item) => (
                    <Alert key={item.code} message={item.message} showIcon type={item.severity} />
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="health-section">
            <div className="health-section-title">
              <Text strong>元数据覆盖</Text>
              <Tag color={metadataReadyPercent >= 80 ? "success" : "warning"}>{metadataReadyPercent}%</Tag>
            </div>
            <Progress percent={metadataReadyPercent} railColor="#303030" showInfo={false} strokeColor="#ff9900" />
            <Space size={[6, 6]} wrap>
              {data.metadata.statuses.map((status) => (
                <Tag key={status.value}>{`${status.value} ${status.count}`}</Tag>
              ))}
            </Space>
          </section>

          {operations && (
            <section className="health-section">
              <div className="health-section-title">
                <Text strong>队列与数据库</Text>
                <Tag color={operations.jobs.workerRunning ? "success" : "warning"}>
                  {operations.jobs.workerRunning ? "工作器在线" : "工作器离线"}
                </Tag>
              </div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="运行中">{operations.jobs.running}</Descriptions.Item>
                <Descriptions.Item label="计划重试">{operations.jobs.retryScheduled}</Descriptions.Item>
                <Descriptions.Item label="24 小时失败">{operations.jobs.failedLast24Hours}</Descriptions.Item>
                <Descriptions.Item label="过期租约">{operations.jobs.expiredLeases}</Descriptions.Item>
                <Descriptions.Item label="最早排队">{formatAge(operations.jobs.oldestPendingAgeSeconds)}</Descriptions.Item>
                <Descriptions.Item label="后台时段">
                  {`${String(operations.jobs.schedule.nightStartHour).padStart(2, "0")}:00–${String(operations.jobs.schedule.nightEndHour).padStart(2, "0")}:00`}
                </Descriptions.Item>
                <Descriptions.Item label="当前策略">
                  {operations.jobs.schedule.nightWindowActive
                    ? "后半夜连续处理"
                    : `白天低频处理（${Math.round(operations.jobs.schedule.daytimeCooldownMs / 60_000)} 分钟/项）`}
                </Descriptions.Item>
                <Descriptions.Item label="CPU 约束">
                  {`FFmpeg ${operations.jobs.schedule.ffmpegThreads} 线程 / nice ${operations.jobs.schedule.processNiceness}`}
                </Descriptions.Item>
                <Descriptions.Item label="数据库空闲页">{operations.database.freeRatioPercent}%</Descriptions.Item>
                <Descriptions.Item label="数据库">{formatBytes(operations.database.databaseBytes)}</Descriptions.Item>
                <Descriptions.Item label="临时转码">{`${operations.temporaryFiles.count} 项 / ${formatBytes(operations.temporaryFiles.bytes)}`}</Descriptions.Item>
              </Descriptions>
            </section>
          )}

          {operations?.scanning.latest && (
            <section className="health-section">
              <div className="health-section-title">
                <Text strong>最近扫描</Text>
                <Tag color={operations.scanning.latest.scanMode === "incremental" ? "processing" : "default"}>
                  {operations.scanning.latest.scanMode === "incremental" ? "增量" : "全量"}
                </Tag>
              </div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="新增或更新">{operations.scanning.latest.changed}</Descriptions.Item>
                <Descriptions.Item label={t("移除")}>{operations.scanning.latest.removed}</Descriptions.Item>
                <Descriptions.Item label="跳过目录">{operations.scanning.latest.directoriesSkipped}</Descriptions.Item>
                <Descriptions.Item label="耗时">{t("{{p0}} 秒", { p0: (operations.scanning.latest.durationMs / 1000).toFixed(1) })}</Descriptions.Item>
                <Descriptions.Item label="完成时间" span={2}>{formatDate(operations.scanning.latest.finishedAt)}</Descriptions.Item>
              </Descriptions>
            </section>
          )}

          {operations && operations.requests.routes.length > 0 && (
            <section className="health-section">
              <div className="health-section-title">
                <Text strong>慢接口</Text>
                <Tag>{operations.requests.requests.toLocaleString(getIntlLocale())} 次请求</Tag>
              </div>
              <div className="operations-route-list">
                {operations.requests.routes.slice(0, 6).map((route) => (
                  <div className="operations-route-row" key={route.route}>
                    <Text ellipsis={{ tooltip: route.route }}>{route.route}</Text>
                    <Text type="secondary">P95 {route.p95Ms} ms</Text>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="health-section">
            <div className="health-section-title">
              <Text strong>缩略图缓存</Text>
              <Tag color={thumbnailReadyPercent >= 80 ? "success" : "warning"}>{thumbnailReadyPercent}%</Tag>
            </div>
            <Progress percent={thumbnailReadyPercent} railColor="#303030" showInfo={false} strokeColor="#ff9900" />
            <Space size={[6, 6]} wrap>
              {data.thumbnails.statuses.map((status) => (
                <Tag key={status.value}>{`${status.value} ${status.count}`}</Tag>
              ))}
            </Space>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="视频帧缓存">
                {`${data.thumbnails.cache.files.toLocaleString(getIntlLocale())} 文件 / ${formatBytes(
                  data.thumbnails.cache.bytes
                )}`}
              </Descriptions.Item>
              <Descriptions.Item label="封面缓存">
                {`${data.covers.cache.files.toLocaleString(getIntlLocale())} 文件 / ${formatBytes(data.covers.cache.bytes)}`}
              </Descriptions.Item>
            </Descriptions>
          </section>

          <section className="health-section">
            <div className="health-section-title">
              <Text strong>播放与缓存</Text>
              {data.cache.warmupRunning && <Tag color="processing">预热中</Tag>}
            </div>
            <Descriptions column={2} size="small">
              <Descriptions.Item label={t("播放记录")}>{data.playback.count}</Descriptions.Item>
              <Descriptions.Item label="看到一半">{data.playback.inProgress}</Descriptions.Item>
              <Descriptions.Item label={t("已看完")}>{data.playback.completed}</Descriptions.Item>
              <Descriptions.Item label="接口缓存">
                {`${data.cache.mediaEntries} / ${data.cache.facetEntries}`}
              </Descriptions.Item>
              <Descriptions.Item label={t("最近播放")} span={2}>
                {data.playback.lastPlayedAt || "-"}
              </Descriptions.Item>
            </Descriptions>
          </section>

          <section className="health-section">
            <div className="health-section-title">
              <Text strong>{t("媒体分类")}</Text>
              {data.scanning && <Tag color="processing">扫描中</Tag>}
            </div>
            <Space size={[6, 6]} wrap>
              {data.categories.map((category) => (
                <Tag key={category.value}>{`${category.value} ${category.count}`}</Tag>
              ))}
              {data.mediaTypes.map((type) => (
                <Tag icon={<Image size={12} />} key={type.value}>{`${type.value} ${type.count}`}</Tag>
              ))}
            </Space>
          </section>

          <section className="health-section">
            <div className="health-section-title">
              <Text strong>存储与数据源</Text>
            </div>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="数据库">
                {`media-wall.sqlite · ${formatBytes(data.storage.databaseBytes)}`}
              </Descriptions.Item>
              <Descriptions.Item label="元数据种子">
                {formatBytes(data.storage.metadataSeedBytes)}
              </Descriptions.Item>
            </Descriptions>
            <div className="health-source-list">
              {data.library.sources.map((source) => (
                <div className="health-source-row" key={`${source.category}:${source.name}`}>
                  <Tag color={source.exists ? "success" : "warning"}>{source.category}</Tag>
                  <Text>{source.name}</Text>
                  <Text type="secondary">{source.exists ? "在线" : t("不可用")}</Text>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
}
