import { describe, expect, it } from "vitest";

import { modelMaker } from "./ModelMark.js";

describe("modelMaker", () => {
  it("finds the maker in direct, routed, and labelled model ids", () => {
    expect(modelMaker("claude-opus-4-5-20251101")).toBe("claude-code");
    expect(modelMaker("github-copilot/claude-sonnet-4")).toBe("claude-code");
    expect(modelMaker("openai/gpt-5")).toBe("openai");
    expect(modelMaker("gpt-5.1-codex")).toBe("openai");
    expect(modelMaker("o3")).toBe("openai");
    expect(modelMaker("o4-mini")).toBe("openai");
    expect(modelMaker("gemini-3-pro-preview")).toBe("gemini");
    expect(modelMaker("openrouter/x-ai/grok-4")).toBe("xai");
    expect(modelMaker("glm-4.6")).toBe("zai");
    expect(modelMaker("kimi-k2-thinking")).toBe("kimi");
    expect(modelMaker("qwen3-coder-plus")).toBe("qwen");
    expect(modelMaker("deepseek-v3.2")).toBe("deepseek");
    expect(modelMaker("devstral-medium")).toBe("mistral");
    expect(modelMaker("llama-4-maverick")).toBe("meta");
    expect(modelMaker("MiniMax-M2")).toBe("minimax");
    expect(modelMaker("composer-1")).toBe("cursor-agent");
    expect(modelMaker("custom-1", "Sonnet 4.5 via proxy")).toBe("claude-code");
  });

  it("leaves unknown models and the auto router without a maker", () => {
    expect(modelMaker("auto")).toBeUndefined();
    expect(modelMaker("house-model", "House model")).toBeUndefined();
    expect(modelMaker("pro4-turbo")).toBeUndefined();
  });
});
