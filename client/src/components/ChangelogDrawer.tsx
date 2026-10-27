import { t, useLocale } from "../i18n";
import { Drawer, Tag, Typography } from "antd";
import { CalendarDays, FileDiff, GitCommitHorizontal, History } from "lucide-react";
import changelogData from "../changelog-data.json";
import "../changelog-drawer.css";

type ChangelogDrawerProps = {
  open: boolean;
  onClose: () => void;
};

type ChangeType = "新增" | "优化" | "修复";

type ChangelogEntry = {
  id: string;
  date: string;
  commit: string;
  subject: string;
  title: string;
  stats: {
    files: number;
    additions: number;
    deletions: number;
    total: number;
  };
  changes: Array<{
    type: ChangeType;
    text: string;
  }>;
};

const CHANGELOG = changelogData as ChangelogEntry[];

const typeClassNames: Record<ChangeType, string> = {
  "新增": "is-feature",
  "优化": "is-improvement",
  "修复": "is-fix"
};

const { Text, Title } = Typography;

export function ChangelogDrawer({ open, onClose }: ChangelogDrawerProps) {
  useLocale();
  return (
    <Drawer
      className="changelog-drawer"
      onClose={onClose}
      open={open}
      size={560}
      title={(
        <div className="changelog-title">
          <History aria-hidden="true" size={20} />
          <span>{t("更新日志")}</span>
          <Tag>{CHANGELOG.length} 次提交</Tag>
        </div>
      )}
    >
      <div className="changelog-intro">
        <Text>每次代码提交对应一条功能记录，便于准确追溯产品变化。</Text>
        <Text type="secondary">按本地提交时间由新到旧排列，精确到秒</Text>
      </div>

      <div className="changelog-timeline">
        {CHANGELOG.map((entry, index) => (
          <section
            className={`changelog-entry${index < 8 ? " motion-list-item" : ""}`}
            key={entry.id}
            style={index < 8 ? { animationDelay: `${Math.min(index, 5) * 24}ms` } : undefined}
          >
            <div className="changelog-rail" aria-hidden="true">
              <span className="changelog-dot" />
              {index < CHANGELOG.length - 1 && <span className="changelog-line" />}
            </div>
            <div className="changelog-entry-content">
              <div className="changelog-entry-heading">
                <div>
                  <div className="changelog-entry-meta">
                    <time className="changelog-date" dateTime={entry.date}><CalendarDays size={14} />{entry.date}</time>
                    <span className="changelog-commit"><GitCommitHorizontal size={14} />{entry.commit}</span>
                    <span
                      aria-label={`${entry.stats.files} 个文件，新增 ${entry.stats.additions} 行，删除 ${entry.stats.deletions} 行，共修改 ${entry.stats.total} 行`}
                      className="changelog-stats"
                    >
                      <FileDiff aria-hidden="true" size={14} />
                      <span>{entry.stats.files} {t("个文件")}</span>
                      <span className="changelog-additions">+{entry.stats.additions}</span>
                      <span className="changelog-deletions">-{entry.stats.deletions}</span>
                      <span>共 {entry.stats.total} 行</span>
                    </span>
                  </div>
                  <Title level={4}>{entry.title}</Title>
                </div>
                {index === 0 && <Tag className="changelog-latest">最新</Tag>}
              </div>
              <ul className="changelog-change-list">
                {entry.changes.map((change) => (
                  <li key={`${change.type}:${change.text}`}>
                    <Tag className={`changelog-type ${typeClassNames[change.type]}`}>{change.type}</Tag>
                    <span>{change.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </Drawer>
  );
}
