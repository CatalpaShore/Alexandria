import { config } from "./config.js";
import { inspectExternalAiStorage } from "./externalAiStorage.js";

export type ExternalAiRuntimeStatus = {
  ready: boolean;
  installedModels: string[];
  missingModels: string[];
  reason: string | null;
};

export type AgentChatModelOption = {
  name: string;
  family: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  capabilities: string[];
  isDefault: boolean;
  loaded: boolean;
};

type OllamaTagModel = {
  name?: string;
  model?: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

type OllamaModelDetails = {
  capabilities?: string[];
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
};

let cached: { key: string; expiresAt: number; value: ExternalAiRuntimeStatus } | null = null;
let chatModelsCached: { expiresAt: number; value: AgentChatModelOption[] } | null = null;
const modelLoadPromises = new Map<string, Promise<{ model: string; loadedModels: string[] }>>();
const modelUnloadPromises = new Map<string, Promise<{ model: string; loadedModels: string[] }>>();

export function buildAgentChatModelCatalog(
  tags: OllamaTagModel[],
  detailsByName: Map<string, OllamaModelDetails>,
  defaultModel = config.externalAi.chatModel
): AgentChatModelOption[] {
  return tags.flatMap((tag) => {
    const name = tag.model ?? tag.name ?? "";
    if (!name) return [];
    const modelDetails = detailsByName.get(name);
    const capabilities = modelDetails?.capabilities ?? [];
    if (!capabilities.includes("completion")) return [];
    const details = modelDetails?.details ?? tag.details ?? {};
    return [{
      name,
      family: details.family ?? "unknown",
      parameterSize: details.parameter_size ?? "",
      quantization: details.quantization_level ?? "",
      sizeBytes: typeof tag.size === "number" ? tag.size : 0,
      capabilities,
      isDefault: name === defaultModel,
      loaded: false
    }];
  }).sort((left, right) =>
    Number(right.isDefault) - Number(left.isDefault) || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name, "zh-CN")
  );
}

export async function listAgentChatModels(ttlMs = 15_000): Promise<AgentChatModelOption[]> {
  if (chatModelsCached && chatModelsCached.expiresAt > Date.now()) return chatModelsCached.value;
  const response = await fetch(`${config.externalAi.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json() as { models?: OllamaTagModel[] };
  const tags = payload.models ?? [];
  const detailEntries = await Promise.all(tags.map(async (tag) => {
    const name = tag.model ?? tag.name ?? "";
    if (!name) return null;
    try {
      const detailResponse = await fetch(`${config.externalAi.ollamaUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(2_500)
      });
      if (!detailResponse.ok) return null;
      return [name, await detailResponse.json() as OllamaModelDetails] as const;
    } catch {
      return null;
    }
  }));
  const detailsByName = new Map(detailEntries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)));
  const value = buildAgentChatModelCatalog(tags, detailsByName);
  chatModelsCached = { expiresAt: Date.now() + ttlMs, value };
  return value;
}

export async function listLoadedAgentModels(): Promise<string[]> {
  const response = await fetch(`${config.externalAi.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  return [...new Set((payload.models ?? []).map((item) => item.model ?? item.name ?? "").filter(Boolean))];
}

export function markAgentChatModelsLoaded(
  models: AgentChatModelOption[],
  loadedModels: string[]
): AgentChatModelOption[] {
  const loaded = new Set(loadedModels);
  return models.map((model) => ({ ...model, loaded: loaded.has(model.name) }));
}

export async function listAgentChatModelsWithStatus(): Promise<AgentChatModelOption[]> {
  const models = await listAgentChatModels();
  try {
    return markAgentChatModelsLoaded(models, await listLoadedAgentModels());
  } catch {
    return models;
  }
}

export async function resolveAgentChatModel(requestedModel?: string): Promise<string> {
  const model = requestedModel?.trim() || config.externalAi.chatModel;
  if (model === config.externalAi.chatModel) return model;
  const available = await listAgentChatModels();
  if (available.some((item) => item.name === model)) return model;
  throw Object.assign(new Error(`模型 ${model} 未安装或不支持对话生成，请重新选择`), { status: 400 });
}

function describeOllamaFailure(status: number, detail: string): string {
  if (/failed to create command queue|failed to allocate context|0 MiB free/iu.test(detail)) {
    return "模型运行时无法访问 Metal GPU，请通过项目启动脚本或 macOS LaunchAgent 重启 AI 运行时";
  }
  if (/out[ -]of[ -]memory|failed to allocate buffer|insufficient memory/iu.test(detail)) {
    return "本机可用内存不足，模型暂时无法加载；请关闭占用内存较高的应用后重试";
  }
  const normalized = detail.replace(/\s+/gu, " ").trim().slice(0, 240);
  return normalized ? `模型运行时返回 ${status}：${normalized}` : `模型运行时返回 ${status}`;
}

export async function readOllamaResponseError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const payload = await response.json() as { error?: unknown };
    detail = typeof payload.error === "string" ? payload.error : "";
  } catch {
    // Keep the status-only fallback when Ollama did not return JSON.
  }
  return new Error(describeOllamaFailure(response.status, detail));
}

export async function assertAgentChatModelLoaded(model: string): Promise<void> {
  let loadedModels: string[];
  try {
    loadedModels = await listLoadedAgentModels();
  } catch {
    throw Object.assign(new Error("暂时无法确认馆长模型的加载状态，请重新检测本地运行时"), {
      status: 503,
      code: "AGENT_MODEL_STATUS_UNAVAILABLE"
    });
  }
  if (!loadedModels.includes(model)) {
    throw Object.assign(new Error(`馆长模型 ${model} 尚未加载，请先在页面中手动加载后再使用`), {
      status: 409,
      code: "AGENT_MODEL_NOT_LOADED"
    });
  }
}

export async function loadAgentChatModel(requestedModel?: string): Promise<{ model: string; loadedModels: string[] }> {
  const model = await resolveAgentChatModel(requestedModel);
  const existing = modelLoadPromises.get(model);
  if (existing) return existing;

  const pending = (async () => {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [],
        stream: false,
        think: false,
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? "2m",
        options: { num_ctx: 16_384, num_predict: 1 }
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw await readOllamaResponseError(response);
    await response.arrayBuffer();
    const loadedModels = await listLoadedAgentModels().catch(() => [model]);
    return { model, loadedModels: loadedModels.includes(model) ? loadedModels : [...loadedModels, model] };
  })().finally(() => modelLoadPromises.delete(model));
  modelLoadPromises.set(model, pending);
  return pending;
}

export async function unloadAgentChatModel(requestedModel?: string): Promise<{ model: string; loadedModels: string[] }> {
  const model = await resolveAgentChatModel(requestedModel);
  const existing = modelUnloadPromises.get(model);
  if (existing) return existing;

  const pending = (async () => {
    const loadedBefore = await listLoadedAgentModels();
    if (!loadedBefore.includes(model)) return { model, loadedModels: loadedBefore };

    const response = await fetch(`${config.externalAi.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw await readOllamaResponseError(response);
    await response.arrayBuffer();
    let loadedModels = loadedBefore;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      loadedModels = await listLoadedAgentModels().catch(() => loadedModels);
      if (!loadedModels.includes(model)) return { model, loadedModels };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw Object.assign(new Error(`馆长模型 ${model} 仍在处理请求，暂时无法释放；请稍后重试`), { status: 409 });
  })().finally(() => modelUnloadPromises.delete(model));
  modelUnloadPromises.set(model, pending);
  return pending;
}

export async function inspectExternalAiRuntime(requiredModels: string[], ttlMs = 2_000): Promise<ExternalAiRuntimeStatus> {
  const storage = inspectExternalAiStorage(config.externalAi);
  if (!storage.ready) return { ready: false, installedModels: [], missingModels: requiredModels, reason: storage.message };
  const key = requiredModels.slice().sort().join("\n");
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.value;
  let value: ExternalAiRuntimeStatus;
  try {
    const response = await fetch(`${config.externalAi.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const installedModels = (payload.models ?? []).map((item) => item.model ?? item.name ?? "").filter(Boolean);
    const missingModels = requiredModels.filter((model) => !installedModels.includes(model));
    value = {
      ready: missingModels.length === 0,
      installedModels,
      missingModels,
      reason: missingModels.length > 0 ? `等待模型安装：${missingModels.join("、")}` : null
    };
  } catch {
    value = { ready: false, installedModels: [], missingModels: requiredModels, reason: "外置模型运行时尚未启动" };
  }
  cached = { key, expiresAt: Date.now() + ttlMs, value };
  return value;
}

export function externalAiWaitError(reason: string): Error & { code: string } {
  return Object.assign(new Error(reason), { code: "EXTERNAL_AI_WAIT" });
}
