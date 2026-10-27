import { describe, expect, it } from "vitest";
import { getAgentModelDisplayName, getAgentModelTechnicalLabel } from "../../client/src/components/agent/agentModelDisplay";

describe("agent model display", () => {
  it("uses the product name for the community Qwen model", () => {
    expect(getAgentModelDisplayName({ name: "qwen3.8-ridge:27b", parameterSize: "27.3B" }))
      .toBe("Qwen3.8 27B · 社区优化");
  });

  it("does not duplicate parameter sizes already present in model tags", () => {
    expect(getAgentModelDisplayName({ name: "qwen3.5:9b", parameterSize: "9.7B" })).toBe("Qwen3.5 9B");
    expect(getAgentModelDisplayName({ name: "hy-mt1.5:7b-q4", parameterSize: "7.5B" })).toBe("Hunyuan-MT 1.5 7B");
  });

  it("describes the Ornith MoE model without exposing its runtime tag as the title", () => {
    expect(getAgentModelDisplayName({ name: "ornith1.5:35b-a3b-q4", parameterSize: "35.5B" }))
      .toBe("Ornith 1.5 35B-A3B · MoE");
    expect(getAgentModelDisplayName({ name: "ornith-1.5:35b-a3b-q4", parameterSize: "35.5B" }))
      .toBe("Ornith 1.5 35B-A3B · MoE");
  });

  it("keeps the runtime identifier in the technical label", () => {
    expect(getAgentModelTechnicalLabel({
      name: "qwen3.8-ridge:27b",
      family: "qwen35",
      parameterSize: "27.3B",
      quantization: "IQ2_M",
      sizeBytes: 12_599_187_431,
      capabilities: ["tools"],
      isDefault: true
    })).toContain("qwen3.8-ridge:27b · IQ2_M");
  });
});
