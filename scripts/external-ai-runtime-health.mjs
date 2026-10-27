function normalizeOllamaUrl(value) {
  return value.replace(/\/+$/, "");
}

export async function inspectOllamaApi(ollamaUrl, requiredModels = [], timeoutMs = 1_500) {
  const baseUrl = normalizeOllamaUrl(ollamaUrl);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ready: false, installedModels: [], reason: `Ollama 返回 ${response.status}` };
    const payload = await response.json();
    const installedModels = (payload.models ?? [])
      .map((item) => item?.model ?? item?.name ?? "")
      .filter(Boolean);
    const missingModels = requiredModels.filter((model) => !installedModels.includes(model));
    return {
      ready: missingModels.length === 0,
      installedModels,
      reason: missingModels.length > 0 ? `缺少模型：${missingModels.join("、")}` : null
    };
  } catch (error) {
    return { ready: false, installedModels: [], reason: error instanceof Error ? error.message : "无法连接 Ollama" };
  }
}
