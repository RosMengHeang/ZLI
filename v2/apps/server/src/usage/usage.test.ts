import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { priceFor, requestCost } from "./pricing.js";
import { initialCodexState, parseClaudeLine, parseCodexLine, type UsageEntry } from "./transcripts.js";
import { aggregate, mergeCopies, UsageLog } from "./UsageLog.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function claudeLine(options: {
  id?: string;
  request?: string;
  at?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  speed?: string;
  type?: string;
}): string {
  return JSON.stringify({
    type: options.type ?? "assistant",
    timestamp: options.at ?? "2026-11-21T10:00:00.000Z",
    requestId: options.request ?? "req_1",
    sessionId: "s1",
    message: {
      id: options.id ?? "msg_1",
      model: options.model ?? "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      usage: {
        input_tokens: options.input ?? 10,
        output_tokens: options.output ?? 1_000,
        cache_read_input_tokens: options.cacheRead ?? 100_000,
        cache_creation_input_tokens: options.cacheWrite ?? 2_000,
        cache_creation: {
          ephemeral_5m_input_tokens: (options.cacheWrite ?? 2_000) - (options.cacheWrite1h ?? 1_000),
          ephemeral_1h_input_tokens: options.cacheWrite1h ?? 1_000,
        },
        ...(options.speed ? { speed: options.speed } : {}),
      },
    },
  });
}

type CodexUsageJson = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cache_write_input_tokens?: number;
};

function usage(input: number, cached: number, output: number, reasoning = 0): CodexUsageJson {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

const codex = {
  meta: (at = "2026-11-21T09:00:00.000Z", extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      timestamp: at,
      type: "session_meta",
      payload: { id: "sess-1", model_provider: "openai", ...extra },
    }),
  turn: (model: string, at = "2026-11-21T09:00:01.000Z") =>
    JSON.stringify({ timestamp: at, type: "turn_context", payload: { turn_id: "t1", model } }),
  tier: (tier: string, at = "2026-11-21T09:00:01.500Z") =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } },
    }),
  record: (responseId: string, value: CodexUsageJson, at = "2026-11-21T09:00:05.000Z") =>
    JSON.stringify({ timestamp: at, type: "token_usage_record", payload: { response_id: responseId, usage: value } }),
  count: (last: CodexUsageJson, total: CodexUsageJson | undefined, at = "2026-11-21T09:00:06.000Z") =>
    JSON.stringify({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: last, ...(total ? { total_token_usage: total } : {}) },
      },
    }),
};

describe("pricing", () => {
  it("prices every token kind at its own rate, with 1-hour cache writes at the higher rate", () => {
    const cost = requestCost("claude-opus-5-5", {
      input: 10,
      output: 1_000,
      cacheRead: 100_000,
      cacheWrite: 2_000,
      cacheWrite1h: 1_000,
      fast: false,
    });
    // 10 x $4 + 100,000 x $0.20 + 1,000 x $5 + 1,000 x $8 + 1,000 x $20, per million.
    expect(cost).toBeCloseTo(0.05304, 10);
  });

  it("finds dated and variant names, and leaves unknown and synthetic models unpriced", () => {
    expect(priceFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(priceFor("claude-opus-4-6[1m]")?.output).toBe(25);
    expect(priceFor("anthropic/claude-sonnet-5")?.cacheRead).toBe(0.2);
    expect(priceFor("gpt-6-luna")?.input).toBe(0.1);
    expect(priceFor("gpt-9-mystery")).toBeUndefined();
    expect(priceFor("<synthetic>")).toBeUndefined();
    expect(
      requestCost("gpt-9-mystery", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, fast: false }),
    ).toBeUndefined();
  });

  it("bills fast mode and long prompts at their multiples", () => {
    const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, fast: true };
    expect(requestCost("claude-opus-5-5", tokens)).toBeCloseTo(8, 10);
    // Past 272K tokens of prompt, GPT-6 input bills at twice the rate, and priority doubles that again.
    expect(requestCost("gpt-6-luna", tokens)).toBeCloseTo(0.4, 10);
    expect(requestCost("gpt-6-luna", { ...tokens, input: 100_000, fast: false })).toBeCloseTo(0.01, 10);
  });
});

describe("Claude Code transcripts", () => {
  it("reads assistant usage and skips other lines, synthetic replies, and bad JSON", () => {
    const [entry] = parseClaudeLine(claudeLine({}));
    expect(entry).toMatchObject({
      provider: "claude-code",
      model: "claude-opus-5-5",
      input: 10,
      output: 1_000,
      cacheRead: 100_000,
      cacheWrite: 2_000,
      cacheWrite1h: 1_000,
      fast: false,
      key: "claude:msg_1:req_1",
    });
    expect(parseClaudeLine(claudeLine({ type: "user" }))).toEqual([]);
    expect(parseClaudeLine(claudeLine({ model: "<synthetic>" }))).toEqual([]);
    expect(parseClaudeLine("{not json")).toEqual([]);
    expect(parseClaudeLine(claudeLine({ speed: "fast" }))[0]?.fast).toBe(true);
  });

  it("counts advisor calls under their own model", () => {
    const line = JSON.parse(claudeLine({}));
    line.message.usage.iterations = [
      { type: "advisor_message", model: "claude-fable-5-2", input_tokens: 5, output_tokens: 7 },
    ];
    const entries = parseClaudeLine(JSON.stringify(line));
    expect(entries.map((entry) => entry.model)).toEqual(["claude-opus-5-5", "claude-fable-5-2"]);
    expect(entries[1]).toMatchObject({ input: 5, output: 7, key: "claude:msg_1:req_1:advisor:0" });
  });

  it("merges copies of one request, keeping each count's largest value", () => {
    const entries = [
      ...parseClaudeLine(claudeLine({ output: 3 })),
      ...parseClaudeLine(claudeLine({ output: 1_000 })),
      ...parseClaudeLine(claudeLine({ id: "msg_2", request: "req_2", output: 50 })),
    ];
    const merged = mergeCopies(entries);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.output).toBe(1_000);
  });
});

describe("Codex rollouts", () => {
  function run(lines: string[]): UsageEntry[] {
    const state = initialCodexState();
    return lines.flatMap((line) => parseCodexLine(line, state));
  }

  it("counts each identified request once and ignores the snapshots that follow it", () => {
    const entries = run([
      codex.meta(),
      codex.turn("gpt-6-luna"),
      codex.record("resp_1", usage(1_000, 800, 100, 50)),
      codex.count(usage(1_000, 800, 100, 50), usage(1_000, 800, 100, 50)),
      codex.record("resp_2", usage(500, 0, 20), "2026-11-21T09:00:09.000Z"),
      codex.count(usage(500, 0, 20), usage(1_500, 800, 120, 50), "2026-11-21T09:00:10.000Z"),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      provider: "codex",
      model: "gpt-6-luna",
      input: 200,
      cacheRead: 800,
      output: 100,
      reasoning: 50,
      key: "codex:sess-1:resp_1",
    });
  });

  it("uses snapshot deltas in older rollouts and skips repeated snapshots", () => {
    const entries = run([
      codex.meta(),
      codex.turn("gpt-5.1-codex"),
      codex.count(usage(100, 0, 10), usage(100, 0, 10)),
      codex.count(usage(100, 0, 10), usage(100, 0, 10), "2026-11-21T09:00:07.000Z"),
      codex.count(usage(50, 20, 5), usage(150, 20, 15), "2026-11-21T09:00:20.000Z"),
      // Context-size markers after compaction carry no request.
      codex.count(usage(0, 0, 0), usage(0, 0, 0), "2026-11-21T09:00:30.000Z"),
    ]);
    expect(entries.map((entry) => entry.input)).toEqual([100, 30]);
    expect(entries.map((entry) => entry.cacheRead)).toEqual([0, 20]);
  });

  it("waits for a model, follows the priority tier, and skips a fork's copied history", () => {
    expect(run([codex.meta(), codex.count(usage(10, 0, 1), usage(10, 0, 1))])).toEqual([]);
    const priority = run([
      codex.meta(),
      codex.turn("gpt-6-luna"),
      codex.tier("priority"),
      codex.record("r", usage(10, 0, 1)),
    ]);
    expect(priority[0]?.fast).toBe(true);
    const forked = run([
      codex.meta("2026-11-21T09:00:00.000Z", { forked_from_id: "parent" }),
      codex.turn("gpt-6-luna", "2026-11-21T09:00:00.010Z"),
      codex.count(usage(10, 0, 1), usage(10, 0, 1), "2026-11-21T09:00:00.020Z"),
      codex.count(usage(20, 0, 2), usage(30, 0, 3), "2026-11-21T09:00:15.000Z"),
    ]);
    expect(forked.map((entry) => entry.input)).toEqual([20]);
  });
});

describe("aggregate", () => {
  const entry = (at: string, model: string, provider: UsageEntry["provider"] = "claude-code"): UsageEntry => ({
    provider,
    at: Date.parse(at),
    model,
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    fast: false,
  });

  it("counts days in the asked time zone and fills quiet days", () => {
    const report = aggregate([entry("2026-11-20T20:00:00.000Z", "claude-opus-5-5")], {
      range: "7d",
      timeZone: "Asia/Phnom_Penh",
      now: NOW,
      files: 1,
    });
    expect(report.from).toBe("2026-11-15");
    expect(report.to).toBe("2026-11-21");
    expect(report.days).toHaveLength(7);
    expect(report.days.at(-1)).toMatchObject({ date: "2026-11-21", tokens: 1_000_000, costUsd: 4 });
    expect(report.days[0]).toMatchObject({ date: "2026-11-15", tokens: 0, providers: [] });
  });

  it("keeps older use out of short ranges and splits by provider and model", () => {
    const entries = [
      entry("2026-11-21T08:00:00.000Z", "claude-opus-5-5"),
      entry("2026-11-10T08:00:00.000Z", "claude-sonnet-5"),
      entry("2026-11-21T09:00:00.000Z", "gpt-9-mystery", "codex"),
    ];
    const week = aggregate(entries, { range: "7d", timeZone: "UTC", now: NOW, files: 2 });
    expect(week.totals).toMatchObject({ costUsd: 4, unpricedTokens: 1_000_000, requests: 2 });
    expect(week.providers.map((row) => row.provider)).toEqual(["claude-code", "codex"]);
    expect(week.models.find((row) => row.model === "gpt-9-mystery")).toMatchObject({ priced: false, costUsd: 0 });

    const all = aggregate(entries, { range: "all", timeZone: "UTC", now: NOW, files: 2 });
    expect(all.from).toBe("2026-11-10");
    expect(all.days).toHaveLength(12);
    expect(all.totals.costUsd).toBeCloseTo(6, 10);
    expect(aggregate([], { range: "all", timeZone: "UTC", now: NOW, files: 0 })).toMatchObject({
      days: [],
      to: "2026-11-21",
    });
    expect(aggregate([], { range: "all", timeZone: "UTC", now: NOW, files: 0 }).from).toBeUndefined();
  });
});

describe("UsageLog", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "zli-usage-"));
    dirs.push(root);
    const claude = join(root, "claude", "projects", "proj");
    const codexDir = join(root, "codex", "sessions", "2026", "11", "21");
    await mkdir(claude, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    const log = new UsageLog({
      now: () => NOW,
      sources: () => [
        { provider: "claude-code", dir: join(root, "claude", "projects") },
        { provider: "codex", dir: join(root, "codex", "sessions") },
        // Listed twice, as when an account shares the usual home; read once.
        { provider: "codex", dir: join(root, "codex", "sessions") },
      ],
    });
    return { log, claude, codexDir };
  }

  it("reads both agents, merges copies across files, and picks up appended lines", async () => {
    const { log, claude, codexDir } = await setup();
    const session = join(claude, "a.jsonl");
    await writeFile(session, `${claudeLine({})}\n${claudeLine({ output: 3 })}\n`);
    // A resumed session copies the earlier reply.
    await writeFile(join(claude, "b.jsonl"), `${claudeLine({})}\n`);
    await writeFile(
      join(codexDir, "rollout-1.jsonl"),
      `${[codex.meta(), codex.turn("gpt-6-luna"), codex.record("resp_1", usage(1_000, 800, 100, 50))].join("\n")}\n`,
    );

    const first = await log.read("7d", "UTC");
    expect(first.files).toBe(3);
    expect(first.totals.requests).toBe(2);
    expect(first.totals.tokens).toEqual({
      input: 210,
      output: 1_100,
      cacheRead: 100_800,
      cacheWrite: 2_000,
      reasoning: 50,
    });
    expect(first.totals.costUsd).toBeCloseTo(0.05304 + 0.000078, 10);

    await appendFile(
      session,
      `${claudeLine({ id: "msg_2", request: "req_2", output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })}\n`,
    );
    const second = await log.read("7d", "UTC");
    expect(second.totals.requests).toBe(3);
    expect(second.totals.tokens.output).toBe(1_110);

    // A file rewritten in place is read again from the start.
    await writeFile(
      session,
      `${claudeLine({ id: "msg_9", request: "req_9", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })}\n`,
    );
    const third = await log.read("7d", "UTC");
    expect(third.totals.requests).toBe(3);
    expect(third.models.find((row) => row.provider === "claude-code")?.requests).toBe(2);
  });

  it("counts a last line still being written without losing it later", async () => {
    const { log, claude } = await setup();
    const session = join(claude, "a.jsonl");
    await writeFile(session, claudeLine({}));
    expect((await log.read("all")).totals.requests).toBe(1);
    await appendFile(session, `\n${claudeLine({ id: "msg_2", request: "req_2" })}\n`);
    expect((await log.read("all")).totals.requests).toBe(2);
  });

  it("reports nothing when there are no logs", async () => {
    const log = new UsageLog({
      now: () => NOW,
      sources: () => [{ provider: "claude-code", dir: join(tmpdir(), "zli-usage-missing") }],
    });
    const report = await log.read("30d", "Not/AZone");
    expect(report.totals.requests).toBe(0);
    expect(report.days).toHaveLength(30);
    expect(report.timeZone).not.toBe("Not/AZone");
  });
});
