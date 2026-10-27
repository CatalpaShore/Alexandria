import { useState } from "react";
import { t, useLocale } from "../i18n";
import { useQuery } from "@tanstack/react-query";
import { Button, Modal, Tag } from "antd";
import { requestJson } from "../lib/http";
import { useDemoFilms } from "../features/demo/api";

export function useDemoStatus() {
  useLocale();
  return useQuery({ queryKey: ["demo-status"], queryFn: () => requestJson<{ demo: boolean; readOnly: boolean; content: string; staticDemo?: boolean }>("/api/demo/status"), staleTime: Infinity, retry: false });
}

export function DemoNotice() {
  useLocale();
  const { data } = useDemoStatus();
  const [creditsOpen, setCreditsOpen] = useState(false);
  const catalog = useDemoFilms(data?.demo === true && creditsOpen);
  if (!data?.demo) return null;
  return <>
    <aside className="public-demo-notice" role="status"><Tag color="gold">DEMO</Tag><span>{t("真实开放电影资料 · 播放为测试片 · 收藏与观看记录为模拟数据 · 只读体验")}</span><Button size="small" type="link" onClick={() => setCreditsOpen(true)}>{t("素材来源与演示说明")}</Button></aside>
    <Modal title={t("素材来源与演示说明")} open={creditsOpen} onCancel={() => setCreditsOpen(false)} footer={null} width={760}>
      <p>{t("片名、年份与演职员来自真实开放电影；题材分组、片单、收藏和观看轨迹用于模拟体验，不代表真实用户行为。播放按钮打开 12 秒原创兼容测试片，并非电影正片。")}</p>
      <p>{t("在线演示不提供资源导入、转码、文件管理、备份或模型服务；请自行部署体验完整功能。")}</p>
      <p>{t("电影图片按各自 CC BY 授权展示，与项目代码的 MIT 许可分别适用；不代表出品方对本项目的背书。")}</p>
      <p>{t("人物与导演节点使用代表作配图，不是人物肖像。")}</p>
      <div className="demo-film-credits">{catalog.data?.films.map(film => <article key={film.slug}>
        <img src={`/demo/films/${film.artwork.file}`} alt="" loading="lazy" width="144" height="81" />
        <div><strong>{film.title} · {film.year}</strong><p>{film.artwork.attribution} · <a href={film.artwork.licenseUrl} target="_blank" rel="noreferrer">{film.artwork.license}</a></p><small>{t("图片经缩放与格式转换，部分图片裁去标题标识。")}</small><p><a href={film.source} target="_blank" rel="noreferrer">{t("官方资料与原始作品")}</a></p></div>
      </article>)}</div>
    </Modal>
  </>;
}
