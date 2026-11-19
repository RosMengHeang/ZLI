import type { ProviderDiscovery, TaskProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { candidatesFor, modelTier, pickEngine, profileJob, trackRecords } from "./autopick.js";

const providers: ProviderDiscovery[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "claude",
    models: [
      { id: "claude-haiku-5-5", label: "Haiku" },
      { id: "claude-sonnet-5-5", label: "Sonnet", reasoningEfforts: ["low", "medium", "high"] },
      { id: "claude-opus-5-5", label: "Opus", reasoningEfforts: ["low", "medium", "high"] },
    ],
  },
  {
    provider: "codex",
    displayName: "Codex",
    status: "found",
    path: "codex",
    models: [{ id: "gpt-5.2-codex", label: "GPT" }],
  },
  { provider: "gemini", displayName: "Gemini", status: "missing", reason: "not installed" },
];
const auto = { engine: { mode: "auto" as const }, permissionMode: "full-access" as const };
const now = "2026-11-15T09:00:00.000Z";

describe("profileJob", () => {
  it("reads the kind, size and risk of a job", () => {
    expect(profileJob({ goal: "Fix the typo in README.md" })).toMatchObject({ kind: "docs", size: "s", risk: "low" });
    expect(profileJob({ goal: "Fix the login crash" })).toMatchObject({ kind: "bugfix", risk: "high" });
    expect(profileJob({ goal: "Refactor every API route to the new client" })).toMatchObject({
      kind: "refactor",
      size: "l",
    });
    expect(profileJob({ goal: "anything", kind: "review" }).kind).toBe("review");
    expect(profileJob({ goal: "Make the settings page layout tidy" })).toMatchObject({
      kind: "ui",
      needsBrowser: true,
    });
  });
});

describe("pickEngine", () => {
  const candidates = candidatesFor(providers, auto);

  it("leaves out agents that are missing", () => {
    expect(candidates.some((candidate) => candidate.provider === "gemini")).toBe(false);
    expect(modelTier("claude-opus-5-5")).toBe(3);
    expect(modelTier("claude-haiku-5-5")).toBe(1);
  });

  it("uses a strong model for a big risky job and a light one for a typo", () => {
    const big = pickEngine({
      buddy: auto,
      profile: profileJob({ goal: "Rewrite the whole auth flow" }),
      candidates,
      records: new Map(),
      quality: "balanced",
      now,
    });
    expect(modelTier(big?.model)).toBe(3);
    expect(big?.effort).toBe("high");
    const small = pickEngine({
      buddy: auto,
      profile: profileJob({ goal: "Fix a typo in docs" }),
      candidates,
      records: new Map(),
      quality: "balanced",
      now,
    });
    expect(modelTier(small?.model)).toBe(1);
    expect(small?.reason).toMatch(/^Small docs/u);
  });

  it("drops an agent near its limit and excludes one past 95%", () => {
    const profile = profileJob({ goal: "Rewrite the whole auth flow" });
    const near = pickEngine({
      buddy: auto,
      profile,
      candidates,
      records: new Map(),
      quality: "balanced",
      used: new Map([["claude-code", 85]]),
      now,
    });
    expect(near?.provider).toBe("codex");
    const past = pickEngine({
      buddy: auto,
      profile,
      candidates,
      records: new Map(),
      quality: "balanced",
      used: new Map([
        ["claude-code", 96],
        ["codex", 96],
      ]),
      now,
    });
    expect(past).toBeUndefined();
  });

  it("lets a track record outweigh the starting table", () => {
    const profile = profileJob({ goal: "Add a settings toggle for dark mode" });
    const done = (index: number, model: string, status: TaskProjection["status"]): TaskProjection => ({
      taskId: `t${index}`,
      buddyId: "b",
      projectId: "p",
      kind: "job",
      goal: "x",
      origin: { kind: "chat" },
      picks: [],
      handoffDepth: 0,
      status,
      questions: [],
      revisions: [],
      reviews: [],
      profile,
      pick: { provider: "claude-code", model, permissionMode: "full-access", reason: "r", source: "auto", at: now },
      createdAt: now,
      updatedAt: now,
    });
    const tasks = [
      ...Array.from({ length: 8 }, (_, index) => done(index, "claude-sonnet-5-5", "failed")),
      ...Array.from({ length: 8 }, (_, index) => done(index + 10, "claude-haiku-5-5", "ready")),
    ];
    const pick = pickEngine({
      buddy: auto,
      profile,
      candidates,
      records: trackRecords(tasks),
      quality: "balanced",
      now,
    });
    expect(pick?.model).not.toBe("claude-sonnet-5-5");
  });

  it("keeps a locked buddy on its model and never raises the permission", () => {
    const locked = {
      engine: { mode: "locked" as const, provider: "codex" as const },
      permissionMode: "supervised" as const,
    };
    const pick = pickEngine({
      buddy: locked,
      profile: profileJob({ goal: "Rewrite the whole auth flow" }),
      candidates: candidatesFor(providers, locked),
      records: new Map(),
      quality: "best",
      now,
    });
    expect(pick).toMatchObject({ provider: "codex", source: "locked", permissionMode: "supervised" });
    const review = pickEngine({
      buddy: auto,
      profile: profileJob({ goal: "x", kind: "review" }),
      candidates,
      records: new Map(),
      quality: "balanced",
      now,
    });
    expect(review?.permissionMode).toBe("read-only");
  });
});
