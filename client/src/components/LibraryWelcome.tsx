import { Button, Typography } from "antd";
import { FolderPlus } from "lucide-react";
import { t, useLocale } from "../i18n";

export function LibraryWelcome({ onConnect, scanning }: { onConnect: () => void; scanning: boolean }) {
  useLocale();
  return <section className="library-welcome" aria-label={t("开始使用")}>
    <div><span className="library-welcome-kicker">Alexandria 18+</span>
      <Typography.Title level={2}>{t(scanning ? "正在建立你的媒体库" : "把已有影库接进来")}</Typography.Title>
      <Typography.Paragraph>{t(scanning ? "扫描完成后作品会出现在媒体墙。你可以先查看任务进度，或继续添加其他目录。" : "保留现有文件夹，读取海报、资料和字幕。从一个目录开始，无需模型或外部服务。")}</Typography.Paragraph>
      <ol><li>{t("添加本机或已挂载的目录")}</li><li>{t("预览可读性并确认扫描")}</li><li>{t("打开作品，检查播放和字幕")}</li></ol>
      <Button type="primary" icon={<FolderPlus size={17}/>} onClick={onConnect}>{t("接入媒体库")}</Button>
      <Typography.Text type="secondary">{t("只想先体验？在终端运行 pnpm demo:start 查看独立 Demo。")}</Typography.Text>
    </div>
  </section>;
}
