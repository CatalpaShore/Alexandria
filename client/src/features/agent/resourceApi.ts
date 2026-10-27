import { requestJson } from "../../lib/http";

export type AgentModelResourceResult = {
  model: string;
  loadedModels: string[];
};

export function unloadAgentChatModel(model: string): Promise<AgentModelResourceResult> {
  return requestJson("/api/agent/models/unload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model })
  }, () => "无法释放馆长模型");
}
