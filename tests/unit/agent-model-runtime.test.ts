import { describe, expect, it } from "vitest";
import { getAgentModelRuntimeProfile } from "../../server/src/agentModelRuntime";

describe("agent model runtime profiles", () => {
  it("uses the memory-conscious Ornith sampling profile", () => {
    expect(getAgentModelRuntimeProfile("ornith1.5:35b-a3b-q4")).toEqual({
      numCtx: 8_192,
      temperature: 0.6,
      topP: 0.95,
      topK: 20
    });
    expect(getAgentModelRuntimeProfile("ornith-1.5:35b-a3b-q4").numCtx).toBe(8_192);
  });

  it("keeps the existing Qwen defaults", () => {
    expect(getAgentModelRuntimeProfile("qwen3.5:9b")).toEqual({
      numCtx: 16_384,
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5
    });
  });
});
