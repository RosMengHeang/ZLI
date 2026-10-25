import type { ProviderDiscovery, ProviderModelOption } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_REASONING, reasoningLabel, reasoningLevels, reasoningOptions } from "./reasoning.js";

const models: ProviderModelOption[] = [
  { id: "opus", label: "Opus", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" },
  { id: "auto", label: "Auto", reasoningEfforts: [] },
  { id: "plain", label: "Plain" },
];
const discovery: ProviderDiscovery = {
  provider: "droid",
  displayName: "Droid",
  status: "found",
  path: "/bin/droid",
  reasoningEfforts: ["low", "medium"],
};

describe("reasoningLevels", () => {
  it("prefers the model's own levels, including an empty list", () => {
    expect(reasoningLevels(models, "opus", {}, discovery)).toEqual({
      levels: ["low", "high", "max"],
      defaultLevel: "high",
    });
    expect(reasoningLevels(models, "auto", {}, discovery).levels).toEqual([]);
  });

  it("falls back to the session's levels, then the agent's", () => {
    expect(reasoningLevels(models, "plain", { reasoningEfforts: ["think"] }, discovery).levels).toEqual(["think"]);
    expect(reasoningLevels(models, undefined, {}, discovery).levels).toEqual(["low", "medium"]);
    expect(reasoningLevels(undefined, undefined, {}, undefined).levels).toEqual([]);
  });
});

describe("reasoningOptions", () => {
  it("leads with the default and names known levels", () => {
    expect(reasoningOptions(["xhigh", "custom"], "xhigh")).toEqual([
      { value: DEFAULT_REASONING, label: "Default (Extra high)", description: "The model's own level" },
      { value: "xhigh", label: "Extra high" },
      { value: "custom", label: "custom" },
    ]);
    expect(reasoningLabel("MAX")).toBe("Max");
  });
});
