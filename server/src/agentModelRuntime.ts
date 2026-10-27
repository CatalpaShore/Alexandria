export type AgentModelRuntimeProfile = {
  numCtx: number;
  temperature: number;
  topP: number;
  topK: number;
  presencePenalty?: number;
};

const defaultProfile: AgentModelRuntimeProfile = {
  numCtx: 16_384,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  presencePenalty: 1.5
};

const ornithProfile: AgentModelRuntimeProfile = {
  numCtx: 8_192,
  temperature: 0.6,
  topP: 0.95,
  topK: 20
};

export function getAgentModelRuntimeProfile(model: string): AgentModelRuntimeProfile {
  return /^ornith-?1\.5:/u.test(model.trim().toLowerCase()) ? ornithProfile : defaultProfile;
}
