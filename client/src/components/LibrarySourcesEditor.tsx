import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Collapse, Input, Space, Steps, Typography } from "antd";
import { FolderPlus, Trash2 } from "lucide-react";
import { jsonRequest, requestJson } from "../lib/http";
import { t, useLocale } from "../i18n";

type Source = { category: string; name: string; root: string };
type Preview = { previewId: string; sources: Source[]; retainedRecords: number; targets: Array<Source & { readable: boolean; empty: boolean; sample?: { checked: number; videos: number; subtitles: number; metadata: number; limited: boolean; unreadableDirectories: number } | null }> };
const blankSource = (index: number): Source => ({ category: "LOCAL", name: `Library-${index}`, root: "" });
const validLabel = (value: string) => value.trim().length > 0 && value.trim().length <= 80 && !/[/\\:\r\n\0]/.test(value);

export function LibrarySourcesEditor() {
  useLocale();
  const queryClient = useQueryClient();
  const [sources, setSources] = useState<Source[]>([blankSource(1)]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    requestJson<{ sources: Source[] }>("/api/settings/library-sources")
      .then(value => { if (!cancelled) { setSources(value.sources.length ? value.sources : [blankSource(1)]); setLoaded(true); } })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  const changeSources = (next: Source[]) => {
    setSources(next); setPreview(null); setAllowEmpty(false); setSaved(false); setError("");
  };
  const invalid = sources.length === 0 || sources.some(source => !validLabel(source.category) || !validLabel(source.name) || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(source.root.trim()))
    || new Set(sources.map(source => `${source.category.trim()}/${source.name.trim()}`)).size !== sources.length;

  async function inspect() {
    setBusy(true); setError(""); setSaved(false); setPreview(null); setAllowEmpty(false);
    try {
      const next = await requestJson<Preview>("/api/settings/library-sources/preview", jsonRequest("POST", { sources }));
      setPreview(next);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      await requestJson("/api/settings/library-sources", jsonRequest("PUT", { sources: preview.sources, previewId: preview.previewId, allowEmpty }));
      setSources(preview.sources); setPreview(null); setSaved(true);
      await Promise.all(["library-paths", "health-summary", "media", "facets", "metadata-status"].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setPreview(null); }
    finally { setBusy(false); }
  }

  return <section className="library-connect-form" aria-label={t("接入已有媒体库")}>
    <Typography.Title level={4}>{t("接入已有媒体库")}</Typography.Title>
    <Typography.Paragraph type="secondary">{t("无需移动或重新命名影片。添加目录后，平台读取本地资料并建立索引。")}</Typography.Paragraph>
    <Steps size="small" current={saved ? 2 : preview ? 1 : 0} items={[{ title: t("选择目录") }, { title: t("预览检查") }, { title: t("扫描与观看") }]} />
    <Alert type="info" showIcon title={t("本机、外置盘或已挂载 NAS 均可")}
      description={t("请填写服务所在机器上的绝对路径。Docker 使用容器内挂载路径；SMB / NFS 先在系统中挂载。浏览器不能直接选择服务器文件夹。")}/>
    {sources.map((source, index) => <div className="library-source-card" key={index}>
      <div className="library-source-heading"><strong>{t("媒体源 {{count}}", { count: index + 1 })}</strong>
        <Button aria-label={t("移除媒体源 {{count}}", { count: index + 1 })} disabled={!loaded || busy || sources.length <= 1} icon={<Trash2 size={15} />} size="small" onClick={() => changeSources(sources.filter((_, i) => i !== index))}/></div>
      <label><span>{t("目录路径")}</span><Input aria-label={t("目录路径 {{count}}", { count: index + 1 })} disabled={!loaded || busy} placeholder="/media/library" value={source.root}
        onChange={event => changeSources(sources.map((s, i) => i === index ? { ...s, root: event.target.value } : s))}/></label>
      <div className="library-source-identity">
        <label><span>{t("来源名称")}</span><Input aria-label={t("来源名称 {{count}}", { count: index + 1 })} disabled={!loaded || busy} value={source.name}
          onChange={event => changeSources(sources.map((s, i) => i === index ? { ...s, name: event.target.value } : s))}/></label>
        <label><span>{t("分类")}</span><Input aria-label={t("分类 {{count}}", { count: index + 1 })} disabled={!loaded || busy} value={source.category}
          onChange={event => changeSources(sources.map((s, i) => i === index ? { ...s, category: event.target.value } : s))}/></label>
      </div>
    </div>)}
    <Typography.Text type="secondary">{t("换盘时保留来源名称和分类，有助于继续关联收藏与进度。名称不能重复，也不能包含斜杠或冒号。")}</Typography.Text>
    <Space wrap>
      <Button disabled={!loaded || busy || sources.length >= 32} icon={<FolderPlus size={16} />} onClick={() => {
        let index = sources.length + 1;
        while (sources.some(source => source.category === "LOCAL" && source.name === `Library-${index}`)) index++;
        changeSources([...sources, blankSource(index)]);
      }}>{t("添加目录")}</Button>
      <Button disabled={!loaded || invalid || busy} loading={busy && !preview} onClick={() => void inspect()}>{t("预览导入与迁移")}</Button>
    </Space>
    <Collapse ghost items={[{ key: "sidecars", label: t("如何读取海报、资料和字幕？"), children: <Typography.Paragraph>{t("同名 .nfo / .media.json、poster / folder / cover 图片和 SRT / ASS / SSA / VTT 字幕可一同读取。先测试少量影片的播放和字幕，再接入完整影库。")}</Typography.Paragraph> }]} />
    {preview && <section className="library-source-preview" aria-label={t("媒体源预览")}>
      <Alert showIcon type={preview.targets.some(target => !target.readable || target.empty) ? "warning" : "success"}
        title={t("现有 {{count}} 条馆藏记录将保留", { count: preview.retainedRecords })}
        description={t("保存前自动备份数据库。仅索引媒体，原文件不会移动或改写。")}/>
      {preview.targets.map(target => <div className="source-check" key={`${target.category}/${target.name}`}>
        <strong>{target.name}</strong><span>{t(!target.readable ? "不可读取" : target.empty ? "空目录" : "可读取")}</span><code>{target.root}</code>
        {target.sample && <Typography.Text type="secondary">{t("抽样 {{p0}} 项：视频 {{p1}}、字幕 {{p2}}、资料 {{p3}}", { p0: target.sample.checked, p1: target.sample.videos, p2: target.sample.subtitles, p3: target.sample.metadata })}{target.sample.limited ? ` · ${t("仅抽样，非完整结果")}` : ""}</Typography.Text>}
        {target.sample?.unreadableDirectories ? <Typography.Text type="warning">{t("部分子目录不可读取，请检查权限")}</Typography.Text> : null}
      </div>)}
      {preview.targets.some(target => target.sample && target.sample.checked > 0 && target.sample.videos === 0) && <Alert type="warning" title={t("抽样未发现视频，请确认路径；完整扫描会继续检查子目录。")}/>}
      {preview.targets.some(target => !target.readable) && <Alert type="error" title={t("请检查挂载、路径与读取权限，然后重新预览。")}/>}
      {preview.targets.some(target => target.empty) && <Checkbox checked={allowEmpty} onChange={event => setAllowEmpty(event.target.checked)}>{t("确认使用空目录，保留失联馆藏记录")}</Checkbox>}
      <Button type="primary" loading={busy} disabled={preview.targets.some(target => !target.readable) || (preview.targets.some(target => target.empty) && !allowEmpty)} onClick={() => void save()}>{t("备份并开始扫描")}</Button>
    </section>}
    {saved && <Alert showIcon type="success" title={t("媒体源已保存，正在扫描")}
      description={t("关闭此窗口即可回到媒体墙。首次扫描会读取资料并计算指纹，大型 NAS 可能需要较长时间；可从任务与告警查看进度。")}/>}
    {error && <Alert showIcon type="error" title={t("操作未完成")} description={error}
      action={!loaded ? <Button onClick={() => setLoadAttempt(value => value + 1)}>{t("重新加载")}</Button> : undefined}/>}
  </section>;
}
