import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Result,
  Skeleton,
  Space,
  Statistic,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  DatabaseBackup,
  FileWarning,
  Gauge,
  HardDrive,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Wrench
} from "lucide-react";
import { useState } from "react";
import {
  createBackup,
  createRestorePlan,
  fetchBackups,
  fetchIntegrityReport,
  restoreBackup,
  startIntegrityScan,
  validateBackup,
  type AssetIntegrityBucket,
  type AssetIntegrityKind,
  type BackupListItem,
  type BackupValidation,
  type RestorePlan,
  type RestoreResult
} from "../lib/maintenanceApi";
import {
  fetchOperationsDiagnostics,
  type OperationsMaintenanceReport
} from "./HealthCenterDrawer";
import "../maintenance-center.css";
import "../operations-diagnostics.css";
import "../operations-drawer.css";

type MaintenanceCenterDrawerProps = {
  open: boolean;
  onClose: () => void;
};

const { Paragraph, Text, Title } = Typography;

const assetLabels: Record<AssetIntegrityKind, string> = {
  thumbnail: "视频缩略图",
  cover: "元数据封面",
  derivative: "播放派生资源"
};

const maintenanceReasonLabels: Record<OperationsMaintenanceReport["reason"], string> = {
  startup: "启动维护",
  database: "数据库维护",
  derivatives: "派生资源校准",
  "temporary-files": "临时文件清理",
  manual: "手动维护"
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(getIntlLocale(), { hour12: false });
}

function formatInterval(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds <= 0) return "-";
  if (milliseconds < 60_000) return t("{{p0}} 秒", { p0: Math.round(milliseconds / 1000) });
  if (milliseconds < 3_600_000) return t("{{p0}} 分钟", { p0: Math.round(milliseconds / 60_000) });
  return t("{{p0}} 小时", { p0: Math.round(milliseconds / 3_600_000) });
}

function bucketIssueCount(bucket: AssetIntegrityBucket): number {
  return bucket.missing + bucket.unsafePaths + bucket.orphanFiles + bucket.orphanIndexEntries;
}

function inventoryCount(item: BackupListItem): number {
  return Object.values(item.inventory ?? {}).reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function validationTag(validation: BackupValidation | undefined) {
  if (!validation) return null;
  return validation.valid ? (
    <Tag color="success" icon={<CheckCircle2 size={12} />}>校验通过</Tag>
  ) : (
    <Tag color="error" icon={<TriangleAlert size={12} />}>校验失败</Tag>
  );
}

async function runOperationsMaintenance(): Promise<OperationsMaintenanceReport> {
  const response = await fetch("/api/maintenance/operations", { method: "POST" });
  const body = await response.json().catch(() => null) as OperationsMaintenanceReport | { error?: string } | null;
  if (!response.ok) throw new Error(body && "error" in body ? body.error : "运行维护失败");
  return body as OperationsMaintenanceReport;
}

export function MaintenanceCenterDrawer({ open, onClose }: MaintenanceCenterDrawerProps) {
  useLocale();
  const queryClient = useQueryClient();
  const [backupId, setBackupId] = useState("");
  const [validations, setValidations] = useState<Record<string, BackupValidation>>({});
  const [restoreTarget, setRestoreTarget] = useState<BackupListItem | null>(null);
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null);
  const [confirmationToken, setConfirmationToken] = useState("");
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  const integrity = useQuery({
    queryKey: ["maintenance", "integrity"],
    queryFn: fetchIntegrityReport,
    enabled: open,
    refetchInterval: (query) => query.state.data?.running ? 1_500 : false
  });
  const backups = useQuery({
    queryKey: ["maintenance", "backups"],
    queryFn: fetchBackups,
    enabled: open
  });
  const diagnostics = useQuery({
    queryKey: ["operations-diagnostics"],
    queryFn: fetchOperationsDiagnostics,
    enabled: open,
    refetchInterval: open ? 10_000 : false,
    retry: false
  });
  const operationsRun = useMutation({
    mutationFn: runOperationsMaintenance,
    onSuccess: async (report) => {
      message.success(report.ok ? "运行维护已完成" : "维护完成，部分步骤需要关注");
      await queryClient.invalidateQueries({ queryKey: ["operations-diagnostics"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "运行维护失败")
  });

  const integrityScan = useMutation({
    mutationFn: startIntegrityScan,
    onSuccess: async () => {
      message.info("完整性扫描已启动");
      await queryClient.invalidateQueries({ queryKey: ["maintenance", "integrity"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "扫描启动失败")
  });
  const backupCreate = useMutation({
    mutationFn: (id?: string) => createBackup(id),
    onSuccess: async (result) => {
      setBackupId("");
      message.success(`备份 ${result.id} 已创建`);
      await queryClient.invalidateQueries({ queryKey: ["maintenance", "backups"] });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "备份创建失败")
  });
  const backupValidate = useMutation({
    mutationFn: (id: string) => validateBackup(id),
    onSuccess: (result, id) => {
      setValidations((current) => ({ ...current, [id]: result }));
      if (result.valid) message.success(`${id} 校验通过`);
      else message.error(`${id} 校验失败`);
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "备份校验失败")
  });
  const restorePlanMutation = useMutation({
    mutationFn: (item: BackupListItem) => createRestorePlan(item.id),
    onSuccess: (plan, item) => {
      setRestoreTarget(item);
      setRestorePlan(plan);
      setConfirmationToken("");
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "恢复计划生成失败")
  });
  const restoreMutation = useMutation({
    mutationFn: ({ id, token }: { id: string; token: string }) => restoreBackup(id, token),
    onSuccess: (result) => {
      setRestoreResult(result);
      message.success("恢复完成，服务正在重启");
    },
    onError: (error) => message.error(error instanceof Error ? error.message : "恢复失败")
  });

  const report = integrity.data?.report;
  const issueCount = useLocalizedMemo(() => {
    if (!report) return 0;
    const assetIssues = Object.values(report.assets).reduce(
      (sum, bucket) => sum + bucketIssueCount(bucket),
      0
    );
    const databaseIssues = Object.values(report.database).reduce((sum, count) => sum + count, 0);
    return assetIssues + databaseIssues + report.traversal.unreadableEntries;
  }, [report]);

  function beginRestore(item: BackupListItem): void {
    Modal.confirm({
      className: "maintenance-danger-confirm",
      title: `准备恢复 ${item.id}？`,
      icon: <TriangleAlert color="#ff9900" size={22} />,
      content: (
        <div className="maintenance-confirm-copy">
          <Paragraph>恢复会替换当前数据库、路径配置和收藏数据，现有状态将先写入回滚备份。</Paragraph>
          <Alert
            type="warning"
            showIcon
            message="恢复完成后服务进程会退出，容器必须配置自动重启策略，或由你手动重启容器。"
          />
        </div>
      ),
      okText: "生成恢复计划",
      cancelText: t("取消"),
      okButtonProps: { danger: true },
      onOk: async () => {
        const validation = await validateBackup(item.id);
        setValidations((current) => ({ ...current, [item.id]: validation }));
        if (!validation.valid) throw new Error("备份校验失败，已阻止恢复");
        await restorePlanMutation.mutateAsync(item);
      }
    });
  }

  function closeRestoreModal(): void {
    if (restoreMutation.isPending) return;
    setRestoreTarget(null);
    setRestorePlan(null);
    setConfirmationToken("");
  }

  const integrityContent = integrity.isLoading ? (
    <Skeleton active paragraph={{ rows: 9 }} />
  ) : integrity.error ? (
    <Alert type="error" showIcon message={integrity.error instanceof Error ? integrity.error.message : "报告读取失败"} />
  ) : (
    <div className="maintenance-pane">
      <div className="maintenance-heading-row">
        <div>
          <Title level={4}>资产完整性</Title>
          <Text type="secondary">检查缓存文件、索引和数据库关联，扫描过程不会修改资产。</Text>
        </div>
        <Button
          icon={<RefreshCw className={integrity.data?.running ? "maintenance-spin" : undefined} size={16} />}
          loading={integrityScan.isPending}
          onClick={() => integrityScan.mutate()}
          type="primary"
        >
          {integrity.data?.running ? "扫描中" : "开始扫描"}
        </Button>
      </div>

      {!report ? (
        <Empty description="尚未生成完整性报告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <>
          <div className="maintenance-stat-grid">
            <Statistic prefix={<ShieldCheck size={17} />} title="问题总数" value={issueCount} />
            <Statistic prefix={<FileWarning size={17} />} title="问题样本" value={report.issues.length} />
            <Statistic prefix={<HardDrive size={17} />} title="扫描文件" value={Object.values(report.assets).reduce((sum, item) => sum + item.scannedFiles, 0)} />
            <Statistic title="耗时" value={(report.durationMs / 1000).toFixed(1)} suffix="秒" />
          </div>
          <div className="maintenance-report-meta">
            <Tag color={issueCount === 0 ? "success" : "warning"}>{issueCount === 0 ? "状态良好" : "需要关注"}</Tag>
            <Text type="secondary">生成于 {formatDate(report.generatedAt)}</Text>
            {report.truncatedIssueSamples > 0 && <Tag>{t("另有")} {report.truncatedIssueSamples} 条样本未展示</Tag>}
          </div>
          <div className="maintenance-asset-grid">
            {(Object.entries(report.assets) as Array<[AssetIntegrityKind, AssetIntegrityBucket]>).map(([kind, bucket]) => (
              <section className="maintenance-asset-block" key={kind}>
                <div className="maintenance-section-title">
                  <Text strong>{assetLabels[kind]}</Text>
                  <Tag color={bucketIssueCount(bucket) === 0 ? "success" : "warning"}>{bucketIssueCount(bucket)} 问题</Tag>
                </div>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="已索引">{bucket.indexed.toLocaleString(getIntlLocale())}</Descriptions.Item>
                  <Descriptions.Item label="已存在">{bucket.present.toLocaleString(getIntlLocale())}</Descriptions.Item>
                  <Descriptions.Item label="磁盘文件">{bucket.scannedFiles.toLocaleString(getIntlLocale())}</Descriptions.Item>
                  <Descriptions.Item label="磁盘容量">{formatBytes(bucket.scannedBytes)}</Descriptions.Item>
                  <Descriptions.Item label="缺失">{bucket.missing.toLocaleString(getIntlLocale())}</Descriptions.Item>
                  <Descriptions.Item label="孤立文件">{bucket.orphanFiles.toLocaleString(getIntlLocale())}</Descriptions.Item>
                </Descriptions>
              </section>
            ))}
          </div>
          {report.issues.length > 0 && (
            <section className="maintenance-issue-section">
              <div className="maintenance-section-title"><Text strong>问题样本</Text></div>
              <List
                dataSource={report.issues.slice(0, 100)}
                renderItem={(issue) => (
                  <List.Item>
                    <List.Item.Meta
                      avatar={<FileWarning color="#ff9900" size={17} />}
                      title={<Space size={6} wrap><Tag>{issue.kind}</Tag><Text>{issue.code}</Text></Space>}
                      description={<><Text type="secondary">{issue.detail}</Text>{issue.path && <Text className="maintenance-path" ellipsis={{ tooltip: issue.path }}>{issue.path}</Text>}</>}
                    />
                  </List.Item>
                )}
                size="small"
              />
            </section>
          )}
        </>
      )}
    </div>
  );

  const backupContent = backups.isLoading ? (
    <Skeleton active paragraph={{ rows: 9 }} />
  ) : backups.error ? (
    <Alert type="error" showIcon message={backups.error instanceof Error ? backups.error.message : "备份列表读取失败"} />
  ) : (
    <div className="maintenance-pane">
      <div className="maintenance-heading-row">
        <div>
          <Title level={4}>备份与恢复</Title>
          <Text type="secondary" ellipsis={{ tooltip: backups.data?.backupRoot }}>存储位置：{backups.data?.backupRoot || "-"}</Text>
        </div>
      </div>
      <section className="maintenance-create-backup">
        <Input
          allowClear
          maxLength={80}
          onChange={(event) => setBackupId(event.target.value)}
          placeholder="可选：自定义备份名称"
          status={backupId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(backupId) ? "error" : undefined}
          value={backupId}
        />
        <Button
          disabled={Boolean(backupId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(backupId))}
          icon={<DatabaseBackup size={16} />}
          loading={backupCreate.isPending}
          onClick={() => backupCreate.mutate(backupId.trim() || undefined)}
          type="primary"
        >创建备份</Button>
      </section>

      {(backups.data?.items.length ?? 0) === 0 ? (
        <Empty description="暂无备份" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <List
          className="maintenance-backup-list"
          dataSource={backups.data?.items ?? []}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  icon={<ShieldCheck size={15} />}
                  key="validate"
                  loading={backupValidate.isPending && backupValidate.variables === item.id}
                  onClick={() => backupValidate.mutate(item.id)}
                  size="small"
                >校验</Button>,
                <Button
                  danger
                  disabled={item.invalid}
                  icon={<RotateCcw size={15} />}
                  key="restore"
                  loading={restorePlanMutation.isPending && restorePlanMutation.variables?.id === item.id}
                  onClick={() => beginRestore(item)}
                  size="small"
                >{t("恢复")}</Button>
              ]}
            >
              <List.Item.Meta
                avatar={<div className="maintenance-backup-icon"><Archive size={18} /></div>}
                title={<Space size={[6, 4]} wrap><Text strong>{item.id}</Text>{item.invalid && <Tag color="error">清单损坏</Tag>}{validationTag(validations[item.id])}</Space>}
                description={
                  <Space className="maintenance-backup-meta" size={[8, 4]} wrap>
                    <Text type="secondary">{formatDate(item.createdAt)}</Text>
                    <Text type="secondary">{formatBytes(item.bytes)}</Text>
                    <Text type="secondary">{inventoryCount(item).toLocaleString(getIntlLocale())} 条用户数据</Text>
                  </Space>
                }
              />
              {validations[item.id] && (!validations[item.id].valid || validations[item.id].warnings.length > 0) && (
                <Alert
                  className="maintenance-validation-alert"
                  type={validations[item.id].valid ? "warning" : "error"}
                  showIcon
                  message={validations[item.id].valid ? validations[item.id].warnings.join("；") : validations[item.id].errors.join("；")}
                />
              )}
            </List.Item>
          )}
        />
      )}
    </div>
  );

  const operations = diagnostics.data;
  const lastMaintenance = operations?.maintenance.lastReport ?? null;
  const operationsContent = diagnostics.isLoading ? (
    <Skeleton active paragraph={{ rows: 8 }} />
  ) : diagnostics.error ? (
    <Alert
      description={diagnostics.error instanceof Error ? diagnostics.error.message : undefined}
      message="运维诊断接口尚未接入或暂不可用"
      showIcon
      type="warning"
    />
  ) : operations ? (
    <div className="maintenance-pane operations-maintenance-pane">
      <div className="maintenance-heading-row">
        <div>
          <Title level={4}>自动维护</Title>
          <Text type="secondary">定时清理转码临时项、校准派生资源索引，并执行 SQLite 优化与 WAL 检查点。</Text>
        </div>
        <Space size={8}>
          <Button icon={<RefreshCw size={16} />} loading={diagnostics.isFetching} onClick={() => diagnostics.refetch()}>
            刷新
          </Button>
          <Button icon={<Wrench size={16} />} loading={operationsRun.isPending || operations?.maintenance.running} onClick={() => operationsRun.mutate()} type="primary">
            立即维护
          </Button>
        </Space>
      </div>

      <div className="operations-status-strip">
        <Tag color={operations.maintenance.started ? "success" : "warning"}>
          {operations.maintenance.started ? "调度已启动" : "调度未启动"}
        </Tag>
        {operations.maintenance.running && <Tag color="processing">{operations.maintenance.currentReason || "维护中"}</Tag>}
        <Text type="secondary">进程运行 {formatInterval(operations.uptimeSeconds * 1000)}</Text>
      </div>

      <div className="maintenance-stat-grid operations-maintenance-stats">
        <Statistic prefix={<Gauge size={17} />} title="API P95" value={operations.requests.p95Ms} suffix="ms" />
        <Statistic prefix={<Activity size={17} />} title="24 小时任务失败" value={operations.jobs.failedLast24Hours} />
        <Statistic prefix={<HardDrive size={17} />} title="WAL" value={formatBytes(operations.database.walBytes)} />
        <Statistic prefix={<Wrench size={17} />} title="过期临时项" value={operations.temporaryFiles.staleCount} />
      </div>

      {operations.alerts.length > 0 && (
        <div className="operations-alert-list">
          {operations.alerts.map((alert) => (
            <Alert key={alert.code} message={alert.message} showIcon type={alert.severity} />
          ))}
        </div>
      )}

      <section className="operations-report-card">
        <div className="maintenance-section-title">
          <Text strong>最近维护结果</Text>
          {lastMaintenance ? (
            <Tag color={lastMaintenance.ok ? "success" : "warning"}>{lastMaintenance.ok ? t("完成") : "部分失败"}</Tag>
          ) : (
            <Tag>尚未执行</Tag>
          )}
        </div>
        {!lastMaintenance ? (
          <Empty description="启动延迟结束后将生成首份维护报告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="维护类型">{maintenanceReasonLabels[lastMaintenance.reason]}</Descriptions.Item>
              <Descriptions.Item label="总耗时">{t("{{p0}} 秒", { p0: (lastMaintenance.durationMs / 1000).toFixed(2) })}</Descriptions.Item>
              <Descriptions.Item label="完成时间" span={2}>{formatDate(lastMaintenance.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label="清理临时项">
                {lastMaintenance.temporaryFiles
                  ? `${lastMaintenance.temporaryFiles.removed} 项 / ${formatBytes(lastMaintenance.temporaryFiles.bytes)}`
                  : "未执行"}
              </Descriptions.Item>
              <Descriptions.Item label="派生索引">
                {lastMaintenance.derivativeIndex
                  ? `${lastMaintenance.derivativeIndex.updated} 已校准 / ${lastMaintenance.derivativeIndex.missing} 缺失`
                  : "未执行"}
              </Descriptions.Item>
              <Descriptions.Item label="清理历史任务">
                {lastMaintenance.database?.jobsRemoved ?? "未执行"}
              </Descriptions.Item>
              <Descriptions.Item label="隔离异常播放记录">
                {lastMaintenance.database?.integrityQuarantined ?? "未执行"}
              </Descriptions.Item>
              <Descriptions.Item label="WAL 检查点" span={2}>
                {lastMaintenance.database?.checkpoint
                  ? `${lastMaintenance.database.checkpoint.checkpointed} / ${lastMaintenance.database.checkpoint.log} 页`
                  : "未执行"}
              </Descriptions.Item>
            </Descriptions>
            {lastMaintenance.errors.length > 0 && (
              <Alert
                description={lastMaintenance.errors.map((item) => item.message).join("；")}
                message="部分维护步骤未完成"
                showIcon
                type="warning"
              />
            )}
          </>
        )}
      </section>

      <section className="operations-report-card">
        <div className="maintenance-section-title"><Text strong>调度周期</Text></div>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="数据库维护">{formatInterval(operations.maintenance.schedule?.databaseIntervalMs)}</Descriptions.Item>
          <Descriptions.Item label="派生索引校准">{formatInterval(operations.maintenance.schedule?.derivativeIntervalMs)}</Descriptions.Item>
          <Descriptions.Item label="临时项扫描">{formatInterval(operations.maintenance.schedule?.temporaryFileIntervalMs)}</Descriptions.Item>
          <Descriptions.Item label="过期阈值">{formatInterval(operations.maintenance.schedule?.temporaryFileMaxAgeMs)}</Descriptions.Item>
        </Descriptions>
      </section>

      {operations.maintenance.recentReports.length > 1 && (
        <section className="operations-report-card">
          <div className="maintenance-section-title"><Text strong>近期执行</Text></div>
          <List
            dataSource={operations.maintenance.recentReports.slice(0, 6)}
            renderItem={(report) => (
              <List.Item>
                <List.Item.Meta
                  avatar={<Clock3 color={report.ok ? "#52c41a" : "#ff9900"} size={17} />}
                  description={`${formatDate(report.finishedAt)} · ${(report.durationMs / 1000).toFixed(2)} 秒`}
                  title={<Space size={6}><Text>{maintenanceReasonLabels[report.reason]}</Text><Tag color={report.ok ? "success" : "warning"}>{report.ok ? "成功" : "需关注"}</Tag></Space>}
                />
              </List.Item>
            )}
            size="small"
          />
        </section>
      )}
    </div>
  ) : null;

  return (
    <>
      <Drawer
        className="maintenance-center-drawer"
        destroyOnClose={false}
        onClose={onClose}
        open={open}
        size={860}
        title={(
          <span className="operations-drawer-title">
            <span className="operations-title-icon"><DatabaseBackup size={18} /></span>
            <span>
              <strong>维护中心</strong>
              <small>运行检查、资产校验与备份恢复</small>
            </span>
          </span>
        )}
      >
        <div className="maintenance-safety-strip" role="note">
          <span className="maintenance-safety-icon"><ShieldCheck size={17} /></span>
          <span>
            <strong>安全操作边界</strong>
            <small>优先执行只读检查；恢复前会校验备份，并生成当前数据的回滚副本。</small>
          </span>
          <Tag color="success">可回滚</Tag>
        </div>
        <Tabs
          items={[
            { key: "operations", label: <Space size={6}><Wrench size={15} />运行维护</Space>, children: operationsContent },
            { key: "integrity", label: <Space size={6}><ShieldCheck size={15} />资产完整性</Space>, children: integrityContent },
            { key: "backups", label: <Space size={6}><Archive size={15} />备份与恢复</Space>, children: backupContent }
          ]}
        />
      </Drawer>

      <Modal
        className="maintenance-restore-modal"
        closable={!restoreMutation.isPending}
        footer={null}
        mask={{ closable: false }}
        onCancel={closeRestoreModal}
        open={Boolean(restorePlan && restoreTarget)}
        title={<Space size={8}><TriangleAlert color="#ff4d4f" size={20} /><span>最终恢复确认</span></Space>}
      >
        {restoreResult ? (
          <Result
            status="success"
            title="数据恢复完成"
            subTitle="服务进程已经退出或即将退出。请等待容器按重启策略自动启动；若页面无法恢复连接，请手动重启容器。"
            extra={<Button onClick={closeRestoreModal}>{t("关闭")}</Button>}
          />
        ) : restorePlan && restoreTarget ? (
          <div className="maintenance-restore-body">
            <Alert
              type="error"
              showIcon
              message="这是第二次确认"
              description="执行后会替换当前数据并中断服务，所有正在播放和后台处理的任务都会停止。容器需要随后重启。"
            />
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="恢复来源">{restoreTarget.id}</Descriptions.Item>
              <Descriptions.Item label="替换内容">{restorePlan.replacements.map((item) => item.role).join("、")}</Descriptions.Item>
              <Descriptions.Item label="回滚目录"><Text ellipsis={{ tooltip: restorePlan.rollbackRoot }}>{restorePlan.rollbackRoot}</Text></Descriptions.Item>
            </Descriptions>
            {restorePlan.warnings.length > 0 && <Alert type="warning" showIcon message={restorePlan.warnings.join("；")} />}
            <div className="maintenance-token-block">
              <Text strong>输入以下确认令牌</Text>
              <div className="maintenance-token-value">
                <Text code copyable={false}>{restorePlan.confirmationToken}</Text>
                <Tooltip title="复制确认令牌">
                  <Button
                    aria-label="复制确认令牌"
                    icon={<ClipboardCopy size={15} />}
                    onClick={() => navigator.clipboard.writeText(restorePlan.confirmationToken).then(() => message.success("令牌已复制"))}
                    size="small"
                    type="text"
                  />
                </Tooltip>
              </div>
              <Input
                autoComplete="off"
                onChange={(event) => setConfirmationToken(event.target.value)}
                placeholder="手动输入确认令牌"
                status={confirmationToken && confirmationToken !== restorePlan.confirmationToken ? "error" : undefined}
                value={confirmationToken}
              />
            </div>
            <div className="maintenance-restore-actions">
              <Button disabled={restoreMutation.isPending} onClick={closeRestoreModal}>{t("取消")}</Button>
              <Button
                danger
                disabled={confirmationToken !== restorePlan.confirmationToken}
                loading={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate({ id: restoreTarget.id, token: confirmationToken })}
                type="primary"
              >确认恢复并重启服务</Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
