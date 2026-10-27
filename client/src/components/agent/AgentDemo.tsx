import { t, useLocale } from "../../i18n";
import { useState } from "react";
import { Button, Tag } from "antd";
import { Bot, Database, RefreshCw, Search, Sparkles } from "lucide-react";
import { AgentRecommendationCards } from "./AgentRecommendationCards";
import { useDemoStatus } from "../DemoNotice";
import { useDemoFilms } from "../../features/demo/api";
import type { AgentCitation } from "../../features/agent/api";

const samples = [
  { get title() { return t("给今晚一点松弛感"); }, get prompt() { return t("推荐三部适合今晚放松的作品"); }, get answer() { return t("下面是固定示例片单，用来展示馆长的推荐卡片与引用方式。它们是虚构的演示条目，没有调用模型，也没有读取你的馆藏。"); } },
  { get title() { return t("按主题整理片单"); }, get prompt() { return t("帮我整理一个自然与旅行主题片单"); }, get answer() { return t("示例将海岸、山谷与日落归入同一主题。接入本地模型并完成索引后，馆长才会根据你的真实元数据检索和解释。"); } },
  { get title() { return t("查看推荐依据"); }, get prompt() { return t("为什么推荐这些作品？"); }, get answer() { return t("这里展示的是预先编写的推荐理由：海岸的留白、山谷的层次和日落的暖色。示例不代表模型能力评测，也不推断你的观看偏好。"); } }
];
const titles = ["海岸线的清晨", "穿过山谷的风", "一场缓慢的日落"];
function demoCitations(): AgentCitation[] { return titles.map((title, index) => ({
  mediaId: `curator-demo-${index + 1}`, code: `DEMO ${String(index + 1).padStart(2, "0")}`, title: t(title),
  summary: [t("海岸与晨光的抽象练习 · 固定展示文案"), t("以山谷的形状与层次为灵感 · 固定展示文案"), t("暖色渐变与几何构图 · 固定展示文案")][index],
  actors: [t("虚构创作者")], genres: [t("原创示例"), index === 1 ? t("旅行") : t("自然")], series: t("演示"),
  favorite: false, completed: false, lastPlayedAt: "", score: 0
})); }

export function AgentDemo({ reason, onRetry, onOpenViewingDesk, onOpenMedia }: { reason?: string | null; onRetry: () => void; onOpenViewingDesk: () => void; onOpenMedia: (id: string) => void }) {
  useLocale();
  const [selected, setSelected] = useState(0);
  const status = useDemoStatus();
  const isFilmDemo = status.data?.demo === true;
  const catalog = useDemoFilms(isFilmDemo);
  const selectedSlugs = selected === 1 ? ["sintel", "spring", "caminandes-3"] : selected === 2 ? ["coffee-run", "charge", "glass-half"] : ["big-buck-bunny", "wing-it", "glass-half"];
  const filmCitations: AgentCitation[] = selectedSlugs.flatMap(slug => {
    const film = catalog.data?.films.find(film => film.slug === slug);
    return film?.mediaId ? [{ mediaId: film.mediaId, code: String(film.year), title: film.title, summary: film.summary, actors: film.actors, genres: film.tags, series: film.collection, director: film.director, favorite: film.favorite, completed: film.completed, lastPlayedAt: film.lastPlayedAt, score: 0 }] : [];
  });
  const citations = isFilmDemo ? filmCitations : demoCitations();
  const filmAnswers = [t("这份固定片单选取了三部真实开放动画短片，适合展示轻松选片的界面。推荐文案预先编写，没有调用模型；卡片可查看 Demo 中的作品详情。"), t("这份示例按奇幻、自然和冒险组织真实电影，演示跨人物、导演与题材的关联。分组和推荐理由由 Demo 预设。"), t("Coffee Run 与 Charge 的导演均为 Hjalti Hjálmarsson；Glass Half 的配音名单也包含他。这里展示可核对的主创关系，推荐仍为固定示例。")];
  const demoSamples = isFilmDemo ? [
    { title: t("给今晚一点松弛感"), prompt: t("推荐三部适合今晚放松的作品"), answer: filmAnswers[0] },
    { title: t("按主题整理片单"), prompt: t("找几部奇幻与自然题材的动画短片"), answer: filmAnswers[1] },
    { title: t("查看推荐依据"), prompt: t("为什么推荐这些作品？"), answer: filmAnswers[2] }
  ] : samples;
  return <main className="agent-console agent-demo-console">
    <aside className="agent-thread-rail">
      <div className="agent-thread-heading"><strong>{t("智能馆长")}</strong><Tag color="gold">{t("演示模式")}</Tag></div>
      <div className="agent-thread-list">{demoSamples.map((sample, index) => <button className={selected === index ? "is-active" : ""} key={sample.title} onClick={() => setSelected(index)} type="button"><Search size={14} /><span>{t(sample.title)}</span></button>)}</div>
      <div className="agent-index-card"><div><Database size={14} /><strong>{t("尚未接入本地模型")}</strong></div><small>{t("当前为固定占位数据。不会启动模型、发送请求或保存对话。")}</small><Button icon={<RefreshCw size={13} />} onClick={onRetry} size="small">{t("重新检测连接")}</Button></div>
    </aside>
    <section className="agent-chat-panel">
      <header className="agent-chat-header"><div className="agent-chat-title"><Bot size={20} /><div><strong>{t("先认识你的智能馆长")}</strong><small>{t("无需配置模型，也能预览界面")}</small></div></div><Tag color="gold">{t("固定示例 · 非 AI 回答")}</Tag></header>
      <div className="agent-message-list">
        <section className="agent-model-load-gate" role="status"><Sparkles size={22} /><div><strong>{t("当前未接入可用的本地模型")}</strong><small>{isFilmDemo ? t("当前展示真实开放电影的固定推荐示例，不会调用模型。配置本地模型后，自部署环境可使用真实馆长。") : t("以下对话和三张卡片均为虚构示例。配置 Ollama、启用馆长并安装模型后，可重新检测切换到真实对话。")}</small></div></section>
        <article className="agent-message is-user is-completed"><div className="agent-message-role">{t("你")}</div><div className="agent-message-body"><p>{t(demoSamples[selected].prompt)}</p></div></article>
        <article className="agent-message is-assistant is-completed"><div className="agent-message-role"><Bot size={16} /></div><div className="agent-message-body"><p>{t(demoSamples[selected].answer)}</p><AgentRecommendationCards citations={citations} presentation={{ kind: "media-cards", title: isFilmDemo ? t("真实电影 · 固定示例片单") : t("示例片单 · 点击可前往观影台"), citationNumbers: [1, 2, 3], layout: "gallery", showMotionPreview: false }} onOpenMedia={isFilmDemo ? onOpenMedia : onOpenViewingDesk} /></div></article>
      </div>
      <footer className="agent-composer"><div className="agent-demo-hint"><strong>{t("如何启用真实馆长")}</strong><span>{t("在私有环境配置 AMW_AGENT_ENABLED、Ollama 地址、聊天模型和嵌入模型。示例不会混入真实会话。")}</span>{reason && <small>{t("连接状态：")}{reason}</small>}</div><Button onClick={onOpenViewingDesk}>{t("浏览当前观影台")}</Button></footer>
    </section>
  </main>;
}
