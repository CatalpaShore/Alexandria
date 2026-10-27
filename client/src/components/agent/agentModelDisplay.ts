import type { AgentChatModelOption } from "../../features/agent/api";

function parameterSizeFromTag(name: string): string | null {
  const match = /:(\d+(?:\.\d+)?)b(?:-|$)/iu.exec(name);
  return match ? `${match[1]}B` : null;
}

export function getAgentModelDisplayName(model: Pick<AgentChatModelOption, "name" | "parameterSize">): string {
  const normalizedName = model.name.trim();
  const lowerName = normalizedName.toLowerCase();
  const tagSize = parameterSizeFromTag(normalizedName);

  if (lowerName.startsWith("qwen3.8-ridge:")) {
    return `Qwen3.8 ${tagSize ?? "27B"} · 社区优化`;
  }
  if (/^ornith-?1\.5:/u.test(lowerName)) {
    return `Ornith 1.5 ${tagSize ?? "35B"}-A3B · MoE`;
  }
  if (lowerName.startsWith("qwen3.5:")) {
    return `Qwen3.5 ${tagSize ?? model.parameterSize}`.trim();
  }
  if (lowerName.startsWith("hy-mt1.5:")) {
    return `Hunyuan-MT 1.5 ${tagSize ?? model.parameterSize}`.trim();
  }

  if (!model.parameterSize || lowerName.includes(model.parameterSize.toLowerCase())) return normalizedName;
  return `${normalizedName} · ${model.parameterSize}`;
}

export function getAgentModelTechnicalLabel(model: AgentChatModelOption): string {
  return [getAgentModelDisplayName(model), model.name, model.quantization]
    .filter(Boolean)
    .join(" · ");
}
