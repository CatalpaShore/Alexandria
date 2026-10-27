import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAgentChatModelLoaded,
  buildAgentChatModelCatalog,
  loadAgentChatModel,
  markAgentChatModelsLoaded,
  readOllamaResponseError
} from "../../server/src/externalAiRuntime.js";
import { config } from "../../server/src/config.js";

describe("external AI runtime errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers only installed completion models and keeps the configured default first", () => {
    const catalog = buildAgentChatModelCatalog([
      { name: "qwen3-embedding:0.6b", size: 600 },
      { name: "qwen3.5:9b", size: 9_000 },
      { name: "qwen3.8-ridge:27b", size: 27_000 }
    ], new Map([
      ["qwen3-embedding:0.6b", { capabilities: ["embedding"] }],
      ["qwen3.5:9b", { capabilities: ["completion"], details: { family: "qwen35", parameter_size: "9.7B", quantization_level: "Q4_K_M" } }],
      ["qwen3.8-ridge:27b", { capabilities: ["completion", "tools"], details: { family: "qwen35", parameter_size: "27.3B", quantization_level: "IQ2_M" } }]
    ]), "qwen3.8-ridge:27b");

    expect(catalog.map((item) => item.name)).toEqual(["qwen3.8-ridge:27b", "qwen3.5:9b"]);
    expect(catalog[0]).toMatchObject({ isDefault: true, loaded: false, parameterSize: "27.3B", quantization: "IQ2_M" });
  });

  it("marks only models reported by Ollama as loaded", () => {
    const catalog = buildAgentChatModelCatalog([
      { name: "qwen3.5:9b", size: 9_000 },
      { name: "qwen3.8-ridge:27b", size: 27_000 }
    ], new Map([
      ["qwen3.5:9b", { capabilities: ["completion"] }],
      ["qwen3.8-ridge:27b", { capabilities: ["completion"] }]
    ]), "qwen3.5:9b");

    expect(markAgentChatModelsLoaded(catalog, ["qwen3.8-ridge:27b"]).map(({ name, loaded }) => ({ name, loaded }))).toEqual([
      { name: "qwen3.5:9b", loaded: false },
      { name: "qwen3.8-ridge:27b", loaded: true }
    ]);
  });

  it("loads a chat model only after the explicit load action", async () => {
    const model = config.externalAi.chatModel;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { role: "assistant", content: "" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: model }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadAgentChatModel(model)).resolves.toEqual({
      model,
      loadedModels: [model]
    });
    const loadRequest = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(loadRequest[0]).toContain("/api/chat");
    expect(JSON.parse(String(loadRequest[1].body))).toMatchObject({
      model,
      messages: [],
      stream: false
    });
  });

  it("rejects curator requests when the selected model is not loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(assertAgentChatModelLoaded("qwen3.5:9b")).rejects.toMatchObject({
      status: 409,
      code: "AGENT_MODEL_NOT_LOADED"
    });
  });

  it("turns a Metal sandbox failure into an actionable message", async () => {
    const error = await readOllamaResponseError(new Response(JSON.stringify({
      error: "failed to create command queue; failed to allocate context; device has 0 MiB free"
    }), { status: 500, headers: { "Content-Type": "application/json" } }));

    expect(error.message).toContain("无法访问 Metal GPU");
    expect(error.message).toContain("LaunchAgent");
  });

  it("keeps a bounded Ollama detail for unknown failures", async () => {
    const error = await readOllamaResponseError(new Response(JSON.stringify({
      error: `unexpected runner failure ${"x".repeat(400)}`
    }), { status: 500, headers: { "Content-Type": "application/json" } }));

    expect(error.message).toContain("模型运行时返回 500");
    expect(error.message.length).toBeLessThan(280);
  });
});
