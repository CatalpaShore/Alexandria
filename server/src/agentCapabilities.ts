import { config } from "./config.js";
import { inspectExternalAiStorage, type ExternalAiStorageOptions } from "./externalAiStorage.js";
import { listLoadedAgentModels } from "./externalAiRuntime.js";
import { closeAgentStore } from "./agentStore.js";

export function getAgentCapabilities(
  storageOptions: ExternalAiStorageOptions = config.externalAi
) {
  const storage = inspectExternalAiStorage(storageOptions);
  const storageReady = storage.ready;
  if (!storageReady) closeAgentStore();

  return {
    implementationStage: storageReady ? "phase-2-runtime" as const : "phase-1-foundation" as const,
    agentAvailable: storageReady,
    unavailableCode: storageReady ? null : "AGENT_STORAGE_UNAVAILABLE" as const,
    unavailableReason: storageReady
      ? null
      : storage.message,
    storage,
    isolation: {
      internalFallbackAllowed: false,
      existingPlatformUnaffected: true,
      currentTranslationMode: config.externalAi.translationExternalized
        ? "external-t7-wait-when-missing" as const
        : "legacy-unchanged" as const,
      completedSubtitlesRemainInternal: true
    },
    models: {
      chat: config.externalAi.chatModel,
      embedding: config.externalAi.embeddingModel,
      translation: config.externalAi.translationModel,
      ollamaUrl: config.externalAi.ollamaUrl
    },
    plannedCapabilities: [
      "自然语言检索本地媒体库",
      "基于元数据、收藏和观看记录的 RAG 问答",
      "可解释推荐与智能片单草拟",
      "通过证据卡打开真实媒体详情"
    ]
  };
}

export async function getAgentRuntimeStatus() {
  const capabilities = getAgentCapabilities();
  if (!capabilities.agentAvailable) return {
    ...capabilities,
    runtimeReady: false,
    installedModels: [] as string[],
    loadedModels: [] as string[],
    chatModelLoaded: false
  };
  try {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const installedModels = (payload.models ?? []).map((item) => item.model ?? item.name ?? "").filter(Boolean);
    const required = [config.externalAi.chatModel, config.externalAi.embeddingModel];
    const missingModels = required.filter((model) => !installedModels.includes(model));
    const loadedModels = await listLoadedAgentModels().catch(() => [] as string[]);
    const runtimeReady = missingModels.length === 0;
    return {
      ...capabilities,
      agentAvailable: runtimeReady,
      runtimeReady,
      installedModels,
      loadedModels,
      chatModelLoaded: loadedModels.includes(config.externalAi.chatModel),
      missingModels,
      unavailableCode: missingModels.length > 0
        ? "AGENT_MODELS_UNAVAILABLE" as const
        : null,
      unavailableReason: runtimeReady ? null : `等待模型安装：${missingModels.join("、")}`
    };
  } catch {
    return {
      ...capabilities,
      agentAvailable: false,
      runtimeReady: false,
      installedModels: [] as string[],
      loadedModels: [] as string[],
      chatModelLoaded: false,
      missingModels: [config.externalAi.chatModel, config.externalAi.embeddingModel],
      unavailableCode: "AGENT_RUNTIME_UNAVAILABLE" as const,
      unavailableReason: "外置模型运行时尚未启动"
    };
  }
}
