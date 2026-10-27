import { getIntlLocale } from "../i18n/core";
import { t, useLocale, useLocalizedMemo } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Drawer, Grid, Input, Popconfirm, Progress, Select, Skeleton, Tag, Typography, message as toast } from "antd";
import {
  ArrowDown, Bot, Check, ChevronDown, Clock3, Command, Cpu, Database, Menu, MessageSquareText, Plus,
  PowerOff, RefreshCw, Send, Settings2, Sparkles, Square, Trash2, X
} from "lucide-react";
import {
  createAgentThread,
  cancelAgentAction,
  clearAgentLearning,
  confirmAgentAction,
  deleteAgentThread,
  deleteAgentPreference,
  fetchAgentCapabilities,
  fetchAgentChatModels,
  fetchAgentIndexStatus,
  fetchAgentMentions,
  fetchAgentThread,
  fetchAgentThreads,
  fetchAgentPreferences,
  getAgentRegenerationMentions,
  loadAgentChatModel,
  normalizeAgentRegenerationMessageId,
  replaceAgentRecommendation,
  sendAgentMessageStream,
  startAgentIndex,
  submitAgentFeedback,
  updateAgentPreference,
  type AgentEntryContext,
  type AgentMention,
  type AgentMessage as AgentMessageType,
  type AgentPreference,
  type AgentThreadDetail,
  type AgentStreamEvent
} from "../features/agent/api";
import { unloadAgentChatModel } from "../features/agent/resourceApi";
import type { TopicType } from "../lib/api";
import { getPosterUrl } from "../lib/api";
import { createClientUuid } from "../lib/clientId";
import { AgentMessage } from "./agent/AgentMessage";
import { AgentComposerPicker } from "./agent/AgentComposerPicker";
import { AgentMentionPicker } from "./agent/AgentMentionPicker";
import { applyComposerSuggestion, getComposerSuggestions, matchComposerTrigger, parseAgentComposer, removeComposerToken, type AgentComposerSuggestion } from "./agent/agentComposer";
import { getAgentModelDisplayName, getAgentModelTechnicalLabel } from "./agent/agentModelDisplay";
import { buildAgentFollowUps } from "./agent/buildAgentFollowUps";
import { AgentDemo } from "./agent/AgentDemo";
import "../agent-workspace.css";

const { Text, Title } = Typography;
const { TextArea } = Input;

type AgentWorkspaceProps = {
  onOpenEntity: (entity: { type: TopicType; value: string; label?: string }) => void;
  onOpenMedia: (id: string) => void;
  onOpenViewingDesk: () => void;
  entryContext?: AgentEntryContext | null;
  onClearEntryContext?: () => void;
};

type ActiveTurn = {
  threadId: string;
  prompt: string;
  userMessage: AgentMessageType;
  assistantMessage: AgentMessageType;
  running: boolean;
  controller: AbortController;
};

const starterPrompts = [
  { get title() { return t("从未观看里挑选"); }, get prompt() { return t("推荐几部我还没看过的作品，并说明理由"); } },
  { get title() { return t("今晚轻松观看"); }, get prompt() { return t("找几部适合今晚轻松观看的作品"); } },
  { get title() { return t("延续最近偏好"); }, get prompt() { return t("根据我最近的观看记录，推荐相似题材"); } },
  { get title() { return t("整理收藏片单"); }, get prompt() { return t("帮我从收藏里挑选一个三部片单"); } }
];

const preferenceSourceLabels: Record<AgentPreference["source"], string> = {
  get explicit() { return t("明确设置"); },
  get feedback() { return t("推荐反馈"); },
  get watch_history() { return t("观看历史"); },
  get favorite() { return t("收藏"); },
  get query_history() { return t("提问趋势"); }
};

const MENTION_TRIGGER_PATTERN = /(?:^|[\s，。！？、；：,.!?;:（(])@([^\s@，。！？、；：,.!?;:（）()]*)$/u;
const AGENT_RECENT_PROMPTS_KEY = "alexandria.agent.recent-prompts.v1";
const AGENT_SELECTED_THREAD_KEY = "alexandria.agent.selected-thread.v1";
const AGENT_SELECTED_MODEL_KEY = "alexandria.agent.selected-model.v1";
const AGENT_SELECTED_MODEL_SOURCE_KEY = "alexandria.agent.selected-model-source.v1";
const AGENT_MODEL_DEFAULT_MIGRATION_KEY = "alexandria.agent.model-default-migration.v2";
const AGENT_MODEL_DEFAULT_MIGRATION = "qwen3.5:9b-20260821";
const LEGACY_AGENT_DEFAULT_MODEL = "qwen3.8-ridge:27b";

function initialSelectedAgentModel(): string {
  const savedModel = localStorage.getItem(AGENT_SELECTED_MODEL_KEY) ?? "";
  const selectionSource = localStorage.getItem(AGENT_SELECTED_MODEL_SOURCE_KEY);
  const migration = localStorage.getItem(AGENT_MODEL_DEFAULT_MIGRATION_KEY);
  if (migration !== AGENT_MODEL_DEFAULT_MIGRATION) {
    localStorage.setItem(AGENT_MODEL_DEFAULT_MIGRATION_KEY, AGENT_MODEL_DEFAULT_MIGRATION);
    if (savedModel === LEGACY_AGENT_DEFAULT_MODEL) {
      localStorage.removeItem(AGENT_SELECTED_MODEL_KEY);
      localStorage.removeItem(AGENT_SELECTED_MODEL_SOURCE_KEY);
      return "";
    }
  }
  if (!savedModel || (savedModel === LEGACY_AGENT_DEFAULT_MODEL && selectionSource !== "manual")) {
    localStorage.removeItem(AGENT_SELECTED_MODEL_KEY);
    localStorage.removeItem(AGENT_SELECTED_MODEL_SOURCE_KEY);
    return "";
  }
  return savedModel;
}

function matchMentionTrigger(value: string): RegExpMatchArray | null {
  return value.match(MENTION_TRIGGER_PATTERN);
}

function optimisticMessage(role: "user" | "assistant", content: string): AgentMessageType {
  return {
    id: `optimistic-${role}-${createClientUuid()}`,
    role,
    content,
    citations: [],
    presentation: null,
    presentations: [],
    state: null,
    stateVersion: 0,
    trace: role === "assistant" ? [{
      key: "understand",
      label: t("接收问题"),
      detail: t("正在把问题交给本地智能馆长"),
      status: "active",
      durationMs: null
    }] : [],
    status: role === "assistant" ? "generating" : "completed",
    error: null,
    createdAt: new Date().toISOString()
  };
}

function AgentConsole({ onOpenEntity, onOpenMedia, entryContext, onClearEntryContext }: Pick<AgentWorkspaceProps, "onOpenEntity" | "onOpenMedia" | "entryContext" | "onClearEntryContext">) {
  useLocale();
  const queryClient = useQueryClient();
  const screens = Grid.useBreakpoint();
  const isDesktop = screens.md ?? true;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() =>
    localStorage.getItem(AGENT_SELECTED_THREAD_KEY)
  );
  const [selectedModel, setSelectedModel] = useState(initialSelectedAgentModel);
  const [draft, setDraft] = useState("");
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [mentions, setMentions] = useState<AgentMention[]>([]);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  const [composerActiveIndex, setComposerActiveIndex] = useState(0);
  const [quickPanel, setQuickPanel] = useState<"templates" | "recent" | null>(null);
  const [recentPrompts, setRecentPrompts] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(AGENT_RECENT_PROMPTS_KEY) ?? "[]") as string[]; } catch { return []; }
  });
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const submittingRef = useRef(false);

  const threads = useQuery({
    queryKey: ["agent-threads"],
    queryFn: fetchAgentThreads,
    staleTime: 30_000,
    refetchInterval: 30_000
  });
  const indexStatus = useQuery({
    queryKey: ["agent-index"],
    queryFn: fetchAgentIndexStatus,
    refetchInterval: (query) => query.state.data?.running ? 1_500 : 10_000
  });
  const chatModels = useQuery({
    queryKey: ["agent-models"],
    queryFn: fetchAgentChatModels,
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false
  });
  const thread = useQuery({
    queryKey: ["agent-thread", selectedThreadId],
    queryFn: () => fetchAgentThread(selectedThreadId as string),
    enabled: Boolean(selectedThreadId),
    staleTime: 30_000
  });
  const preferences = useQuery({ queryKey: ["agent-preferences"], queryFn: fetchAgentPreferences, enabled: preferencesOpen });
  const mentionMatch = matchMentionTrigger(draft);
  const mentionQuery = mentionMatch?.[1] ?? "";
  const mentionSuggestions = useQuery({
    queryKey: ["agent-mentions", mentionQuery],
    queryFn: () => fetchAgentMentions(mentionQuery, 16),
    enabled: mentionPickerOpen && Boolean(mentionMatch) && !activeTurn?.running,
    staleTime: 5 * 60_000
  });
  const mentionItems = mentionSuggestions.data?.items ?? [];
  const composerTrigger = matchComposerTrigger(draft);
  const composerSuggestions = getComposerSuggestions(draft);
  const composerParsed = useLocalizedMemo(() => parseAgentComposer(draft), [draft]);
  const exactCode = /^([a-z]{2,12})[- ]?(\d{2,6})$/iu.exec(draft.trim());
  const normalizedExactCode = exactCode ? `${exactCode[1].toUpperCase()}-${exactCode[2]}` : "";
  const exactCodeSuggestions = useQuery({
    queryKey: ["agent-mentions", "exact-code", normalizedExactCode],
    queryFn: () => fetchAgentMentions(normalizedExactCode, 4),
    enabled: Boolean(normalizedExactCode) && !mentionPickerOpen && !composerPickerOpen,
    staleTime: 5 * 60_000
  });
  const exactCodeItem = exactCodeSuggestions.data?.items.find((item) => item.type === "code" && item.value.toUpperCase() === normalizedExactCode) ?? null;
  const activeModel = chatModels.data?.items.some((item) => item.name === selectedModel)
    ? selectedModel
    : chatModels.data?.defaultModel ?? chatModels.data?.items[0]?.name ?? selectedModel;
  const activeModelOption = chatModels.data?.items.find((item) => item.name === activeModel);
  const activeModelLoaded = Boolean(activeModelOption?.loaded);

  useEffect(() => {
    if (!chatModels.data || !activeModel || activeModel === selectedModel) return;
    setSelectedModel(activeModel);
    localStorage.setItem(AGENT_SELECTED_MODEL_KEY, activeModel);
    localStorage.setItem(AGENT_SELECTED_MODEL_SOURCE_KEY, "default");
  }, [activeModel, chatModels.data, selectedModel]);

  useEffect(() => setMentionActiveIndex(0), [mentionQuery]);
  useEffect(() => setComposerActiveIndex(0), [composerTrigger?.raw]);

  function rememberPrompt(prompt: string) {
    setRecentPrompts((current) => {
      const next = [prompt, ...current.filter((item) => item !== prompt)].slice(0, 8);
      localStorage.setItem(AGENT_RECENT_PROMPTS_KEY, JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    if (!threads.data) return;
    const selectedStillExists = selectedThreadId
      ? threads.data.items.some((item) => item.id === selectedThreadId)
      : false;
    if (selectedStillExists) return;
    const nextId = threads.data.items[0]?.id ?? null;
    setSelectedThreadId(nextId);
    if (nextId) localStorage.setItem(AGENT_SELECTED_THREAD_KEY, nextId);
    else localStorage.removeItem(AGENT_SELECTED_THREAD_KEY);
  }, [selectedThreadId, threads.data]);

  useEffect(() => {
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
  }, [selectedThreadId]);

  useEffect(() => {
    if (followLatestRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [activeTurn?.assistantMessage.content, activeTurn?.assistantMessage.trace, thread.data?.messages.length]);

  useEffect(() => () => activeTurn?.controller.abort(), [activeTurn?.controller]);

  const createThread = useMutation({
    mutationFn: () => createAgentThread(entryContext ?? null),
    onSuccess: (created) => {
      setSelectedThreadId(created.id);
      localStorage.setItem(AGENT_SELECTED_THREAD_KEY, created.id);
      queryClient.setQueryData<AgentThreadDetail>(["agent-thread", created.id], { ...created, messages: [] });
      queryClient.setQueryData<{ items: Array<typeof created> }>(["agent-threads"], (current) => ({
        items: [created, ...(current?.items ?? []).filter((item) => item.id !== created.id)]
      }));
      setThreadDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["agent-threads"] });
    }
  });
  const removeThread = useMutation({
    mutationFn: deleteAgentThread,
    onSuccess: async (_value, removedId) => {
      if (activeTurn?.threadId === removedId && activeTurn.running) activeTurn.controller.abort();
      if (selectedThreadId === removedId) setSelectedThreadId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-threads"] }),
        queryClient.removeQueries({ queryKey: ["agent-thread", removedId] })
      ]);
    }
  });
  const startIndex = useMutation({
    mutationFn: startAgentIndex,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["agent-index"] })
  });
  const feedback = useMutation({
    mutationFn: ({ messageId, mediaId, slot, feedbackType }: { messageId: string; mediaId: string; slot: number; feedbackType: "like" | "not_interested" | "more_like_this" }) => submitAgentFeedback(messageId, { mediaId, slot, feedbackType }),
    onSuccess: async () => { toast.success(t("已记录，会用于后续推荐")); await queryClient.invalidateQueries({ queryKey: ["agent-preferences"] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("反馈保存失败"))
  });
  const replaceSlot = useMutation({
    mutationFn: ({ messageId, slot }: { messageId: string; slot: number }) => replaceAgentRecommendation(messageId, slot),
    onSuccess: async (_data, variables) => { await queryClient.invalidateQueries({ queryKey: ["agent-thread", selectedThreadId] }); toast.success(t("第 {{p0}} 个推荐已替换", { p0: variables.slot })); },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("暂时无法替换"))
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: "confirm" | "cancel" }) => mode === "confirm" ? confirmAgentAction(id) : cancelAgentAction(id),
    onSuccess: async (action) => {
      queryClient.setQueryData<AgentThreadDetail>(["agent-thread", selectedThreadId], (current) => current ? ({ ...current, messages: current.messages.map((message) => ({ ...message, presentation: message.presentation?.kind === "action-confirmation" && message.presentation.actionId === action.id ? { ...message.presentation, status: action.status } : message.presentation, presentations: message.presentations.map((presentation) => presentation.kind === "action-confirmation" && presentation.actionId === action.id ? { ...presentation, status: action.status } : presentation) })) }) : current);
      toast.success(action.status === "completed" ? t("操作已完成") : t("操作已取消"));
      await queryClient.invalidateQueries({ queryKey: ["agent-thread", selectedThreadId] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("操作失败"))
  });
  const loadModel = useMutation({
    mutationFn: loadAgentChatModel,
    onSuccess: async (_result, model) => {
      await queryClient.invalidateQueries({ queryKey: ["agent-models"] });
      const option = chatModels.data?.items.find((item) => item.name === model);
      toast.success(t("{{p0}} 已加载，可以开始使用馆长", { p0: option ? getAgentModelDisplayName(option) : model }));
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("馆长模型加载失败"))
  });
  const unloadModel = useMutation({
    mutationFn: unloadAgentChatModel,
    onSuccess: async (_result, model) => {
      await queryClient.invalidateQueries({ queryKey: ["agent-models"] });
      const option = chatModels.data?.items.find((item) => item.name === model);
      toast.success(t("{{p0}} 已从内存释放", { p0: option ? getAgentModelDisplayName(option) : model }));
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("馆长模型释放失败"))
  });

  function applyStreamEvent(event: AgentStreamEvent) {
    setActiveTurn((current) => {
      if (!current) return current;
      if (event.type === "accepted") {
        return {
          ...current,
          userMessage: event.userMessage,
          assistantMessage: { ...event.assistantMessage, trace: event.trace }
        };
      }
      if (event.type === "evidence") {
        return { ...current, assistantMessage: { ...current.assistantMessage, citations: event.citations, trace: event.trace } };
      }
      if (event.type === "trace") {
        return { ...current, assistantMessage: { ...current.assistantMessage, trace: event.trace } };
      }
      if (event.type === "presentation") {
        return { ...current, assistantMessage: { ...current.assistantMessage, presentations: event.presentations, presentation: event.presentations[0] ?? null, stateVersion: event.stateVersion } };
      }
      if (event.type === "delta") {
        return {
          ...current,
          assistantMessage: { ...current.assistantMessage, content: current.assistantMessage.content + event.delta }
        };
      }
      if (event.type === "completed") {
        return { ...current, userMessage: event.userMessage, assistantMessage: event.assistantMessage, running: false };
      }
      return {
        ...current,
        running: false,
        assistantMessage: {
          ...current.assistantMessage,
          content: event.partialContent || current.assistantMessage.content,
          trace: event.trace,
          status: event.interrupted ? "interrupted" : "failed",
          error: event.error
        }
      };
    });
  }

  async function submit(value = draft, selectedMentions = mentions, regenerateFromMessageId?: string) {
    const prompt = value.trim();
    if (!prompt || activeTurn?.running || submittingRef.current) return;
    if (!activeModelLoaded) {
      toast.warning(t("请先手动加载当前选择的馆长模型"));
      return;
    }
    submittingRef.current = true;
    let id = selectedThreadId;
    const controller = new AbortController();
    const pendingThreadId = id ?? `pending-${createClientUuid()}`;
    const context = entryContext ?? thread.data?.context ?? null;
    const baseStateVersion = thread.data?.messages.at(-1)?.stateVersion;
    const optimisticTurn: ActiveTurn = {
      threadId: pendingThreadId,
      prompt,
      userMessage: optimisticMessage("user", prompt),
      assistantMessage: optimisticMessage("assistant", ""),
      running: true,
      controller
    };
    setDraft("");
    rememberPrompt(prompt);
    setMentions([]);
    setMentionPickerOpen(false);
    setComposerPickerOpen(false);
    setQuickPanel(null);
    setActiveTurn(optimisticTurn);
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    try {
      if (!id) {
        const created = await createThread.mutateAsync();
        id = created.id;
        setActiveTurn((current) => current?.controller === controller ? { ...current, threadId: created.id } : current);
      }
      await sendAgentMessageStream(id, prompt, {
        requestId: createClientUuid(),
        model: activeModel || undefined,
        signal: controller.signal,
        context,
        baseStateVersion,
        mentions: selectedMentions,
        composerContext: parseAgentComposer(prompt).context,
        regenerateFromMessageId,
        onEvent: applyStreamEvent
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-thread", id] }),
        queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
      ]);
      setActiveTurn((current) => current?.controller === controller && !current.running ? null : current);
    } catch (error) {
      const interrupted = controller.signal.aborted;
      setActiveTurn((current) => current?.controller !== controller ? current : {
        ...current,
        running: false,
        assistantMessage: {
          ...current.assistantMessage,
          status: interrupted ? "interrupted" : "failed",
          error: interrupted ? t("生成已停止，可以重新发送这条问题") : error instanceof Error ? error.message : t("发送失败")
        }
      });
    } finally {
      submittingRef.current = false;
    }
  }

  function stopGeneration() {
    if (activeTurn?.running) activeTurn.controller.abort();
  }

  function selectThread(id: string) {
    setSelectedThreadId(id);
    localStorage.setItem(AGENT_SELECTED_THREAD_KEY, id);
    setThreadDrawerOpen(false);
  }

  const status = indexStatus.data;
  const progress = status?.total ? Math.round((status.processed / status.total) * 100) : 0;
  const indexPhaseLabel = status?.phase === "preparing" ? t("正在整理最新馆藏结构")
    : status?.phase === "embedding" ? t("正在生成内容向量")
    : status?.phase === "cleaning" ? t("正在清理失效条目")
    : status?.status === "interrupted" ? t("上次任务已中断，可继续")
    : status?.status === "failed" ? status.error ?? t("索引失败")
    : status?.status === "ready" ? t("media-v{{p0}} · 已同步", { p0: status.documentVersion })
    : t("等待建立索引");
  const persistedMessages = useLocalizedMemo(() => thread.data?.messages ?? [], [thread.data?.messages]);
  const persistedIds = useLocalizedMemo(() => new Set(persistedMessages.map((message) => message.id)), [persistedMessages]);
  const pendingThreadVisible = Boolean(activeTurn?.threadId.startsWith("pending-") && !thread.data);
  const activeTurnVisible = Boolean(activeTurn && (activeTurn.threadId === selectedThreadId || pendingThreadVisible));
  const transientMessages = activeTurnVisible && activeTurn
    ? [activeTurn.userMessage, activeTurn.assistantMessage].filter((message) => !persistedIds.has(message.id))
    : [];
  const visibleMessages = [...persistedMessages, ...transientMessages];
  const currentThreadTitle = thread.data?.title ?? threads.data?.items.find((item) => item.id === selectedThreadId)?.title ?? t("新对话");
  const selectedTurnRunning = Boolean(activeTurn?.running && activeTurnVisible);
  const backgroundTurnRunning = Boolean(activeTurn?.running && !activeTurnVisible);
  const latestVisibleMessage = visibleMessages.at(-1);
  const followUpMessageId = !selectedTurnRunning && latestVisibleMessage?.role === "assistant" && latestVisibleMessage.status === "completed"
    ? latestVisibleMessage.id
    : undefined;

  function selectMention(mention: AgentMention) {
    const atIndex = draft.lastIndexOf("@");
    if (atIndex < 0) return;
    setDraft(`${draft.slice(0, atIndex)}@${mention.label} `);
    setMentions((current) => [...current.filter((item) => !(item.type === mention.type && item.value === mention.value)), mention]);
    setMentionPickerOpen(false);
  }

  function removeMention(mention: AgentMention) {
    const escaped = mention.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    setDraft((current) => current.replace(new RegExp(`@${escaped}\\s?`, "u"), ""));
    setMentions((current) => current.filter((item) => !(item.type === mention.type && item.value === mention.value)));
  }

  function selectComposerSuggestion(item: AgentComposerSuggestion) {
    setDraft((current) => applyComposerSuggestion(current, item.token));
    setComposerPickerOpen(false);
  }

  function applyPrompt(prompt: string) {
    setDraft(prompt);
    setQuickPanel(null);
  }

  const threadNavigation = (
    <>
      <div className="agent-thread-heading">
        <div><strong>{t("智能馆长")}</strong><small>{threads.data?.items.length ?? 0} {t("个对话")}</small></div>
        <Button aria-label={t("新建对话")} icon={<Plus size={15} />} loading={createThread.isPending} onClick={() => createThread.mutate()} size="small" />
      </div>
      <div className="agent-thread-list">
        {(threads.data?.items ?? []).map((item) => (
          <div className={`agent-thread-item ${item.id === selectedThreadId ? "is-active" : ""}`} key={item.id}>
            <button onClick={() => selectThread(item.id)} type="button">
              <MessageSquareText size={14} />
              <span><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString(getIntlLocale(), { month: "numeric", day: "numeric" })}</small></span>
            </button>
            <Popconfirm
              cancelText={t("取消")}
              description={t("删除后无法恢复这段 Agent 对话。")}
              okButtonProps={{ danger: true }}
              okText={t("删除")}
              onConfirm={() => removeThread.mutate(item.id)}
              title={t("删除对话？")}
            >
              <Button aria-label={t("删除对话 {{p0}}", { p0: item.title })} className="agent-thread-delete" icon={<Trash2 size={13} />} size="small" type="text" />
            </Popconfirm>
          </div>
        ))}
        {!threads.isLoading && (threads.data?.items.length ?? 0) === 0 && <small>{t("还没有对话，提出第一个问题吧")}</small>}
      </div>
      <div className="agent-index-card">
        <div><Database size={15} /><strong>{t("馆藏索引")}</strong><Tag color={status?.status === "ready" ? "success" : status?.status === "failed" ? "error" : "gold"}>{status?.status ?? t("读取中")}</Tag></div>
        <Progress percent={progress} showInfo={false} size="small" />
        <small>{status?.documents.toLocaleString(getIntlLocale()) ?? 0} {t("条向量 ·")} {progress}% · {indexPhaseLabel}</small>
        <Button block disabled={!activeModelLoaded || status?.running} loading={startIndex.isPending} onClick={() => startIndex.mutate()} size="small">
          {status?.running ? t("正在增量索引") : status?.documents ? t("更新索引") : t("建立索引")}
        </Button>
      </div>
    </>
  );

  return (
    <main className="agent-console">
      {isDesktop && <aside className="agent-thread-rail">{threadNavigation}</aside>}
      {!isDesktop && (
        <Drawer
          className="agent-thread-drawer"
          onClose={() => setThreadDrawerOpen(false)}
          open={threadDrawerOpen}
          placement="left"
          styles={{ body: { padding: 0 } }}
          title={t("Agent 对话")}
          size={310}
        >
          <aside className="agent-thread-rail">{threadNavigation}</aside>
        </Drawer>
      )}

      <section className="agent-chat-panel">
        <header className="agent-chat-header">
          <div className="agent-chat-title">
            {!isDesktop && <Button aria-label={t("打开对话列表")} icon={<Menu size={18} />} onClick={() => setThreadDrawerOpen(true)} type="text" />}
            <Bot size={20} />
            <div><strong>{currentThreadTitle}</strong><small>{t("本地 RAG · 回答实时生成")}</small></div>
          </div>
          <div className="agent-chat-actions">
            <Select
              aria-label={t("选择馆长模型")}
              className="agent-model-select"
              classNames={{ popup: { root: "agent-model-popup" } }}
              disabled={Boolean(activeTurn?.running) || loadModel.isPending || unloadModel.isPending}
              labelRender={() => activeModelOption ? (
                <span className="agent-model-select-label">
                  <Cpu aria-hidden="true" size={14} />
                  <span>{getAgentModelDisplayName(activeModelOption)}</span>
                </span>
              ) : t("选择模型")}
              loading={chatModels.isLoading}
              onChange={(value) => {
                setSelectedModel(value);
                localStorage.setItem(AGENT_SELECTED_MODEL_KEY, value);
                localStorage.setItem(AGENT_SELECTED_MODEL_SOURCE_KEY, "manual");
                const nextModel = chatModels.data?.items.find((item) => item.name === value);
                toast.info(nextModel?.loaded
                  ? t("已切换到 {{p0}}，模型已在内存中", { p0: getAgentModelDisplayName(nextModel) })
                  : t("已切换到 {{p0}}，使用前请手动加载", { p0: nextModel ? getAgentModelDisplayName(nextModel) : value }));
              }}
              options={(chatModels.data?.items ?? []).map((item) => ({
                label: getAgentModelDisplayName(item),
                value: item.name,
                title: getAgentModelTechnicalLabel(item)
              }))}
              optionRender={(option) => {
                const model = chatModels.data?.items.find((item) => item.name === option.value);
                if (!model) return option.label;
                const selected = model.name === activeModel;
                return (
                  <span className="agent-model-option">
                    <span className="agent-model-option-icon"><Cpu aria-hidden="true" size={15} /></span>
                    <span className="agent-model-option-copy">
                      <strong>{getAgentModelDisplayName(model)}</strong>
                      <small>{[model.name, model.quantization].filter(Boolean).join(" · ")}</small>
                    </span>
                    {model.loaded
                      ? <span className="agent-model-loaded-badge">{t("已加载")}</span>
                      : model.isDefault && <span className="agent-model-default-badge">{t("默认")}</span>}
                    {selected && <Check aria-hidden="true" className="agent-model-option-check" size={15} />}
                  </span>
                );
              }}
              placeholder={t("选择模型")}
              popupMatchSelectWidth={false}
              showSearch
              size="small"
              suffixIcon={<ChevronDown aria-hidden="true" size={14} />}
              value={activeModel || undefined}
            />
            <Tag color={activeTurn?.running ? "processing" : activeModelLoaded ? "success" : undefined}>
              {selectedTurnRunning ? t("生成中") : backgroundTurnRunning ? t("后台生成中") : unloadModel.isPending ? t("正在释放") : activeModelLoaded ? t("模型已加载") : t("等待加载")}
            </Tag>
            {activeModelLoaded && (
              <Popconfirm
                description={t("释放后不会删除模型文件；下次使用时需要再次手动加载。")}
                disabled={Boolean(activeTurn?.running) || unloadModel.isPending}
                onConfirm={() => activeModel ? unloadModel.mutateAsync(activeModel) : undefined}
                okText={t("释放模型")}
                title={t("释放当前馆长模型占用的内存？")}
              >
                <Button
                  aria-label={t("释放馆长模型")}
                  className="agent-model-release"
                  disabled={Boolean(activeTurn?.running) || unloadModel.isPending}
                  icon={<PowerOff size={14} />}
                  loading={unloadModel.isPending}
                  size="small"
                  type="text"
                >
                  {t("释放")} </Button>
              </Popconfirm>
            )}
            <Button aria-label={t("Agent 偏好")} icon={<Settings2 size={15} />} onClick={() => setPreferencesOpen(true)} size="small" type="text" />
          </div>
        </header>

        <div
          aria-busy={Boolean(activeTurn?.running && activeTurn.threadId === selectedThreadId)}
          aria-live="polite"
          className="agent-message-list"
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
            followLatestRef.current = nearBottom;
            setShowJumpToLatest(!nearBottom);
          }}
          ref={messageListRef}
          role="log"
        >
          {!activeModelLoaded && (
            <section className="agent-model-load-gate" aria-label={t("馆长模型加载提示")} role="status">
              <span className="agent-model-load-icon"><Cpu aria-hidden="true" size={20} /></span>
              <div>
                <strong>{activeModelOption ? t("{{p0}} 尚未加载", { p0: getAgentModelDisplayName(activeModelOption) }) : t("馆长模型尚未加载")}</strong>
                <small>{t("默认不占用模型内存。点击后才把当前模型加载到本地缓存，空闲后会按配置自动释放。")}</small>
              </div>
              <Button
                disabled={!activeModel}
                icon={<Sparkles size={14} />}
                loading={loadModel.isPending}
                onClick={() => activeModel && loadModel.mutate(activeModel)}
                type="primary"
              >
                {loadModel.isPending ? t("正在加载") : t("加载馆长模型")}
              </Button>
            </section>
          )}
          {thread.isLoading && selectedThreadId && visibleMessages.length === 0 ? (
            <div className="agent-thread-loading"><Skeleton active paragraph={{ rows: 6 }} /></div>
          ) : thread.isError ? (
            <div className="agent-thread-error">
              <Title level={4}>{t("对话暂时无法读取")}</Title>
              <Text type="secondary">{thread.error instanceof Error ? thread.error.message : t("请检查 配置的存储目录与本地模型服务")}</Text>
              <Button icon={<RefreshCw size={14} />} onClick={() => void thread.refetch()}>{t("重新加载")}</Button>
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="agent-empty-chat">
              <span><Bot size={32} /></span>
              <Title level={2}>{t("想从馆藏里发现什么？")}</Title>
              <div className="agent-starter-grid">
                {starterPrompts.map((item) => (
                  <button disabled={!activeModelLoaded} key={item.prompt} onClick={() => void submit(item.prompt)} type="button">
                    <strong>{item.title}</strong><span>{item.prompt}</span><Send size={13} />
                  </button>
                ))}
              </div>
            </div>
          ) : visibleMessages.map((item, index) => {
            const previousUser = [...visibleMessages.slice(0, index)].reverse().find((message) => message.role === "user");
            return (
              <AgentMessage
                animate={transientMessages.some((message) => message.id === item.id)}
                clarificationAnswered={item.role === "assistant" && item.presentations.some((presentation) => presentation.kind === "clarification-question")
                  && visibleMessages.slice(index + 1).some((message) => message.role === "user")}
                item={item}
                key={item.id}
                onOpenEntity={onOpenEntity}
                onOpenMedia={onOpenMedia}
                onFeedback={(messageId, mediaId, slot, type) => feedback.mutate({ messageId, mediaId, slot, feedbackType: type })}
                onReplace={(messageId, slot) => replaceSlot.mutate({ messageId, slot })}
                onConfirmAction={(id) => actionMutation.mutate({ id, mode: "confirm" })}
                onCancelAction={(id) => actionMutation.mutate({ id, mode: "cancel" })}
                onRetry={item.role === "assistant" && previousUser
                  ? () => void submit(
                    previousUser.content,
                    getAgentRegenerationMentions(item),
                    normalizeAgentRegenerationMessageId(item.id)
                  )
                  : undefined}
                onStop={item.id === activeTurn?.assistantMessage.id && activeTurn.running ? stopGeneration : undefined}
                followUps={item.id === followUpMessageId
                  ? buildAgentFollowUps(item, { history: visibleMessages.slice(0, index) })
                  : []}
                onFollowUp={(value) => void submit(value, [])}
                onClarificationAnswer={(question, answer) => void submit(t("继续完成上一条请求。针对馆长的问题“{{p0}}”，我的选择是“{{p1}}”。", { p0: question, p1: answer }), [])}
              />
            );
          })}
          <div ref={bottomRef} />
          {showJumpToLatest && (
            <Button
              className="agent-jump-latest"
              icon={<ArrowDown size={14} />}
              onClick={() => {
                followLatestRef.current = true;
                setShowJumpToLatest(false);
                bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
              }}
              shape="round"
              size="small"
            >
              {t("回到最新")} </Button>
          )}
        </div>

        <footer className="agent-composer">
          {!activeModelLoaded && (
            <section className="agent-composer-model-cta" aria-label={t("馆长模型未加载")} role="status">
              <span><Cpu aria-hidden="true" size={15} /></span>
              <div>
                <strong>{t("模型未加载")}</strong>
                <small>{t("问题可以先编辑；只有点击加载后才会占用本机内存。")}</small>
              </div>
              <Button
                disabled={!activeModel || unloadModel.isPending}
                icon={<Sparkles size={13} />}
                loading={loadModel.isPending}
                onClick={() => activeModel && loadModel.mutate(activeModel)}
                size="small"
                type="primary"
              >
                {t("加载模型")} </Button>
            </section>
          )}
          {(entryContext || mentions.length > 0 || composerParsed.chips.length > 0) && <div className="agent-query-interpretation" aria-live="polite">
            <strong>{t("我理解为")}</strong>
            {entryContext && <span className="is-scope">{t("范围 ·")} {entryContext.label}<button aria-label={t("移除页面上下文")} onClick={onClearEntryContext} type="button"><X size={10} /></button></span>}
            {composerParsed.chips.map((chip) => <span className={`is-${chip.kind}`} key={chip.id}>{chip.kind === "intent" ? "动作 · " : chip.kind === "exclude" ? "排除 · " : "条件 · "}{chip.label}<button aria-label={t("移除 {{p0}}", { p0: chip.label })} onClick={() => setDraft((current) => removeComposerToken(current, chip.raw))} type="button"><X size={10} /></button></span>)}
            {mentions.map((mention) => <span className="is-entity" key={`${mention.type}:${mention.value}`}>{t("实体 ·")} {mention.label}<button aria-label={t("移除 {{p0}}", { p0: mention.label })} onClick={() => removeMention(mention)} type="button"><X size={10} /></button></span>)}
          </div>}
          <div className="agent-composer-tools">
            <button className={quickPanel === "templates" ? "is-active" : ""} onClick={() => setQuickPanel((current) => current === "templates" ? null : "templates")} type="button"><Command size={12} />{t("常用指令")}</button>
            <button className={quickPanel === "recent" ? "is-active" : ""} disabled={recentPrompts.length === 0} onClick={() => setQuickPanel((current) => current === "recent" ? null : "recent")} type="button"><Clock3 size={12} />{t("最近查询")}</button>
            <span><kbd>/</kbd> {t("动作")} <kbd>#</kbd> {t("条件")} <kbd>-#</kbd> {t("排除")} <kbd>@</kbd> {t("实体")}</span>
          </div>
          {quickPanel && <div className="agent-quick-panel" aria-label={quickPanel === "templates" ? t("常用指令") : t("最近查询")}>
            {(quickPanel === "templates" ? starterPrompts.map((item) => item.prompt) : recentPrompts).map((prompt) => <button key={prompt} onClick={() => applyPrompt(prompt)} type="button">{prompt}</button>)}
          </div>}
          <div className="agent-composer-input">
            {mentionPickerOpen && mentionMatch && <AgentMentionPicker activeIndex={mentionActiveIndex} items={mentionItems} loading={mentionSuggestions.isLoading} query={mentionQuery} onActiveIndexChange={setMentionActiveIndex} onSelect={selectMention} />}
            {composerPickerOpen && composerTrigger && <AgentComposerPicker activeIndex={composerActiveIndex} items={composerSuggestions} onActiveIndexChange={setComposerActiveIndex} onSelect={selectComposerSuggestion} type={composerTrigger.type} />}
            {exactCodeItem && <div className="agent-exact-code">
              {exactCodeItem.mediaId && <img alt="" src={getPosterUrl(exactCodeItem.mediaId, "card")} />}
              <div><small>{t("精确番号")}</small><strong>{exactCodeItem.label}</strong><span>{exactCodeItem.latestReleaseDate?.slice(0, 10) || t("馆藏已有此作品")}</span></div>
              {exactCodeItem.mediaId && <Button onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenMedia(exactCodeItem.mediaId as string)} size="small">{t("打开影片")}</Button>}
            </div>}
            <TextArea
              aria-autocomplete="list"
              aria-controls={mentionPickerOpen ? "agent-mention-options" : composerPickerOpen ? "agent-composer-options" : undefined}
              aria-expanded={(mentionPickerOpen && Boolean(mentionMatch)) || (composerPickerOpen && Boolean(composerTrigger))}
              autoSize={{ minRows: 1, maxRows: 6 }}
              disabled={Boolean(activeTurn?.running && activeTurn.threadId !== selectedThreadId)}
              onBlur={() => { setMentionPickerOpen(false); setComposerPickerOpen(false); }}
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                const hasMention = Boolean(matchMentionTrigger(next));
                const hasComposer = Boolean(matchComposerTrigger(next));
                setMentionPickerOpen(hasMention);
                setComposerPickerOpen(hasComposer);
                setQuickPanel(null);
                setMentions((current) => current.filter((mention) => next.includes(`@${mention.label}`)));
              }}
              onKeyDown={(event) => {
                if (mentionPickerOpen && mentionMatch) {
                  if (event.key === "Escape") { event.preventDefault(); setMentionPickerOpen(false); return; }
                  if (!mentionItems.length) return;
                  if (event.key === "ArrowDown") { event.preventDefault(); setMentionActiveIndex((current) => (current + 1) % mentionItems.length); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); setMentionActiveIndex((current) => (current - 1 + mentionItems.length) % mentionItems.length); }
                  else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectMention(mentionItems[mentionActiveIndex]); }
                  return;
                }
                if (composerPickerOpen && composerTrigger) {
                  if (event.key === "Escape") { event.preventDefault(); setComposerPickerOpen(false); return; }
                  if (!composerSuggestions.length) return;
                  if (event.key === "ArrowDown") { event.preventDefault(); setComposerActiveIndex((current) => (current + 1) % composerSuggestions.length); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); setComposerActiveIndex((current) => (current - 1 + composerSuggestions.length) % composerSuggestions.length); }
                  else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectComposerSuggestion(composerSuggestions[composerActiveIndex]); }
                }
              }}
              onPressEnter={(event) => {
                if ((mentionPickerOpen && mentionMatch) || (composerPickerOpen && composerTrigger)) return;
                if (!event.shiftKey) { event.preventDefault(); void submit(); }
              }}
              placeholder={!activeModelLoaded ? t("可先输入问题，使用前请手动加载馆长模型") : selectedTurnRunning ? t("当前回答生成中…") : backgroundTurnRunning ? t("另一对话正在生成，可先停止后再提问") : t("询问馆藏，试试 /推荐、#未观看 或 @演员")}
              value={draft}
            />
            {activeTurn?.running ? (
              <Button aria-label={t("停止生成")} danger icon={<Square fill="currentColor" size={12} />} onClick={stopGeneration}>{t("停止")}</Button>
            ) : (
              <Button aria-label={t("发送")} disabled={!activeModelLoaded || !draft.trim()} icon={<Send size={16} />} onClick={() => void submit()} type="primary">{t("发送")}</Button>
            )}
          </div>
          <div className="agent-composer-meta">
            <span>{t("Enter 发送 · Shift + Enter 换行")}</span>
            <span>{t("回答仅基于本地馆藏证据")}</span>
          </div>
        </footer>
      </section>
      <Drawer title={t("Agent 对我的了解")} open={preferencesOpen} onClose={() => setPreferencesOpen(false)} size={420}>
        <p className="agent-preference-intro">{t("画像综合推荐反馈、近期观看、收藏和提问趋势；新提问会即时增量学习，并每 6 小时基于最近 400 条提问重新校准。你可以暂停或删除，画像只保存在配置的馆长数据目录，不会写入主馆藏数据库。")}</p>
        <div className="agent-preference-list">{(preferences.data?.items ?? []).map((item) => <article key={item.id}>
          <div><Tag>{item.dimension}</Tag><strong>{item.value}</strong><small>{item.weight >= 0 ? t("偏好") : t("回避")} · {preferenceSourceLabels[item.source]} {t("· 置信度")} {Math.round(item.confidence * 100)}%</small></div>
          <span><Button onClick={() => void updateAgentPreference(item.id, { status: item.status === "active" ? "muted" : "active" }).then(() => preferences.refetch())} size="small">{item.status === "active" ? t("暂停") : t("启用")}</Button><Button danger onClick={() => void deleteAgentPreference(item.id).then(() => preferences.refetch())} size="small" type="text">{t("删除")}</Button></span>
        </article>)}</div>
        {!preferences.isLoading && !(preferences.data?.items.length) && <Text type="secondary">{t("还没有可解释的偏好信号。提问、收藏、观看或推荐反馈后会逐步形成画像。")}</Text>}
        <Popconfirm title={t("清除全部 Agent 学习记录？")} description={t("不会删除观看历史和收藏。")} onConfirm={() => void clearAgentLearning().then(() => preferences.refetch())}><Button danger block>{t("清除 Agent 学习记录")}</Button></Popconfirm>
      </Drawer>
    </main>
  );
}

export function AgentWorkspace({ onOpenEntity, onOpenMedia, onOpenViewingDesk, entryContext, onClearEntryContext }: AgentWorkspaceProps) {
  useLocale();
  const capabilities = useQuery({
    queryKey: ["agent-capabilities"],
    queryFn: () => fetchAgentCapabilities(),
    staleTime: 30_000,
    refetchInterval: (query) => query.state.data?.agentAvailable ? 30_000 : 3_000,
    refetchOnWindowFocus: false
  });

  const data = capabilities.data;
  if (capabilities.isLoading) return <Skeleton active className="agent-workspace-skeleton" />;
  if (data?.agentAvailable) return <AgentConsole onOpenEntity={onOpenEntity} onOpenMedia={onOpenMedia} entryContext={entryContext} onClearEntryContext={onClearEntryContext} />;

  return <AgentDemo reason={data?.unavailableReason ?? t("无法连接馆长服务")} onRetry={() => void capabilities.refetch()} onOpenViewingDesk={onOpenViewingDesk} onOpenMedia={onOpenMedia} />;
}
