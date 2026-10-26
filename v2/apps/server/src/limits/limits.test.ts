import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CLAUDE_BACKOFF_MS, type ClaudeLimitDeps, claudeLimitRead, readClaudeLimits } from "./claudeLimits.js";
import { codexLimitRead, readCodexLimits } from "./codexLimits.js";
import { LIMITS_FRESH_MS, LIMITS_MIN_REFRESH_MS, type LimitRead, type LimitTarget, PlanLimits } from "./PlanLimits.js";

describe("codexLimitRead", () => {
  it("reads the current camelCase answer, sorted by window length", () => {
    const read = codexLimitRead({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_768_000_000 },
        secondary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1_767_000_000 },
      },
    });
    expect(read).toEqual({
      state: "ok",
      plan: "plus",
      windows: [
        { usedPercent: 34, durationMinutes: 300, resetsAt: new Date(1_767_000_000_000).toISOString() },
        { usedPercent: 12, durationMinutes: 10_080, resetsAt: new Date(1_768_000_000_000).toISOString() },
      ],
    });
  });

  it("prefers the codex limit when several are listed", () => {
    const read = codexLimitRead({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 7, windowDurationMins: 300 } } },
    });
    expect(read.windows).toEqual([{ usedPercent: 7, durationMinutes: 300 }]);
  });

  it("reads the older snake_case answer", () => {
    const read = codexLimitRead({
      rate_limits: { primary: { used_percent: 140, window_minutes: 300, resets_at: 1_767_000_000 } },
    });
    expect(read.windows).toEqual([
      { usedPercent: 100, durationMinutes: 300, resetsAt: new Date(1_767_000_000_000).toISOString() },
    ]);
  });

  it("says when a login has no plan limits", () => {
    expect(codexLimitRead({ rateLimits: { primary: null, secondary: null } }).state).toBe("unavailable");
  });
});

describe("readCodexLimits", () => {
  it("closes the app server after reading", async () => {
    let closed = false;
    const read = await readCodexLimits(async () => ({
      readRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } }),
      close: async () => {
        closed = true;
      },
    }));
    expect(read.state).toBe("ok");
    expect(closed).toBe(true);
  });

  it("turns a login error into signed out", async () => {
    const read = await readCodexLimits(async () => ({
      readRateLimits: async () => {
        throw new Error("Not logged in");
      },
      close: async () => undefined,
    }));
    expect(read.state).toBe("signed-out");
  });

  it("turns any other failure into an error without details", async () => {
    const read = await readCodexLimits(async () => {
      throw new Error("socket hang up");
    });
    expect(read).toMatchObject({ state: "error", windows: [] });
  });
});

describe("claudeLimitRead", () => {
  it("reads the 5-hour and weekly windows", () => {
    expect(
      claudeLimitRead({
        five_hour: { utilization: 86, resets_at: "2026-01-10T12:47:00+00:00" },
        seven_day: { utilization: 41.5, resets_at: null },
        seven_day_opus: null,
      }),
    ).toEqual({
      state: "ok",
      windows: [
        { durationMinutes: 300, usedPercent: 86, resetsAt: "2026-01-10T12:47:00.000Z" },
        { durationMinutes: 10_080, usedPercent: 41.5 },
      ],
    });
  });

  it("says when there are no windows", () => {
    expect(claudeLimitRead({}).state).toBe("unavailable");
  });
});

describe("readClaudeLimits", () => {
  const credentials = JSON.stringify({ claudeAiOauth: { accessToken: " token-1 ", subscriptionType: "max" } });

  function deps(overrides: Partial<ClaudeLimitDeps> & { status?: number; body?: unknown } = {}) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const value: ClaudeLimitDeps = {
      platform: "linux",
      home: "/home/me",
      readFile: async (path) => {
        if (path === join("/home/me/.claude", ".credentials.json")) return credentials;
        throw new Error("ENOENT");
      },
      keychain: async () => undefined,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify(overrides.body ?? { five_hour: { utilization: 10 } }), {
          status: overrides.status ?? 200,
        });
      }) as typeof fetch,
      ...overrides,
    };
    return { value, calls };
  }

  it("sends the saved token only to Anthropic, with Claude Code's headers", async () => {
    const { value, calls } = deps();
    const read = await readClaudeLimits(undefined, value);
    expect(read).toMatchObject({ state: "ok", plan: "max" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0]?.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": expect.stringMatching(/^claude-code\//u),
    });
  });

  it("is signed out without a saved token and never calls Anthropic", async () => {
    const { value, calls } = deps();
    const read = await readClaudeLimits("/accounts/work", value);
    expect(read.state).toBe("signed-out");
    expect(calls).toHaveLength(0);
  });

  it("looks in the Keychain on macOS under the account's own name", async () => {
    const found: string[] = [];
    const { value } = deps({
      platform: "darwin",
      keychain: async (service) => {
        found.push(service);
        return credentials;
      },
    });
    const read = await readClaudeLimits("/accounts/work", value);
    const hash = createHash("sha256").update("/accounts/work").digest("hex").slice(0, 8);
    expect(found).toEqual([`Claude Code-credentials-${hash}`]);
    expect(read.state).toBe("ok");
  });

  it("reports an expired sign-in", async () => {
    const { value } = deps({ status: 401 });
    expect((await readClaudeLimits(undefined, value)).state).toBe("expired");
  });

  it("backs off when Anthropic limits the checks", async () => {
    const { value } = deps({ status: 429 });
    expect(await readClaudeLimits(undefined, value)).toMatchObject({
      state: "error",
      retryAfterMs: CLAUDE_BACKOFF_MS,
    });
  });
});

describe("PlanLimits", () => {
  const usual: LimitTarget = { provider: "codex", accountId: "usual" };
  const ok = (usedPercent: number): LimitRead => ({
    state: "ok",
    windows: [{ durationMinutes: 300, usedPercent }],
  });

  function service(reads: LimitRead[], targets: LimitTarget[] = [usual]) {
    let clock = 1_000_000;
    let calls = 0;
    const limits = new PlanLimits({
      targets: async () => targets,
      read: async () => reads[Math.min(calls++, reads.length - 1)] as LimitRead,
      now: () => clock,
    });
    return {
      limits,
      calls: () => calls,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("reuses a fresh reading", async () => {
    const { limits, calls, advance } = service([ok(10), ok(20)]);
    expect((await limits.read()).readings[0]?.windows[0]?.usedPercent).toBe(10);
    advance(LIMITS_FRESH_MS - 1);
    await limits.read();
    expect(calls()).toBe(1);
    advance(1);
    expect((await limits.read()).readings[0]?.windows[0]?.usedPercent).toBe(20);
  });

  it("lets a refresh read again only after a minute", async () => {
    const { limits, calls, advance } = service([ok(10), ok(20)]);
    await limits.read();
    await limits.read(true);
    expect(calls()).toBe(1);
    advance(LIMITS_MIN_REFRESH_MS);
    await limits.read(true);
    expect(calls()).toBe(2);
  });

  it("keeps the last windows when a read fails", async () => {
    const { limits, advance } = service([ok(10), { state: "error", message: "Down.", windows: [] }]);
    await limits.read();
    advance(LIMITS_FRESH_MS);
    const [reading] = (await limits.read()).readings;
    expect(reading).toMatchObject({ state: "error", message: "Down.", windows: [{ usedPercent: 10 }] });
    expect(reading?.checkedAt).toBe(new Date(1_000_000).toISOString());
  });

  it("waits out a backoff even on refresh", async () => {
    const { limits, calls, advance } = service([{ state: "error", windows: [], retryAfterMs: 15 * 60_000 }, ok(1)]);
    await limits.read();
    advance(LIMITS_MIN_REFRESH_MS * 2);
    await limits.read(true);
    expect(calls()).toBe(1);
  });

  it("shares one read between callers and survives a reader that throws", async () => {
    let calls = 0;
    const limits = new PlanLimits({
      targets: async () => [usual],
      read: async () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const [first, second] = await Promise.all([limits.read(), limits.read()]);
    expect(calls).toBe(1);
    expect(first.readings[0]?.state).toBe("error");
    expect(second.readings[0]?.state).toBe("error");
  });
});
