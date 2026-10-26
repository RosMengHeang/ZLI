import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCursorLimits } from "./cursorLimits.js";
import {
  findGeminiOAuthClient,
  forgetGeminiTokens,
  type GeminiLimitDeps,
  modelName,
  parseOAuthClient,
  readGeminiLimits,
} from "./geminiLimits.js";
import { kimiEndpoint, readKimiLimits } from "./kimiLimits.js";
import { DatabaseSync } from "node:sqlite";

import { openCodeCredentials, type OpenCodeLimitDeps, readOpenCodeLimits } from "./openCodeLimits.js";

const NOW = Date.parse("2026-01-10T12:00:00.000Z");

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** Fake files, Keychain, and network. Nothing here can write a file. */
function fakeDeps(options: {
  files?: Record<string, string>;
  keychain?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  reply?: (call: Call) => Reply;
}) {
  const calls: Call[] = [];
  const deps = {
    platform: options.platform ?? "linux",
    home: "/home/me",
    env: options.env ?? {},
    now: () => NOW,
    readFile: async (path: string) => {
      const file = options.files?.[path];
      if (file === undefined) throw new Error("ENOENT");
      return file;
    },
    keychain: async (service: string) => options.keychain?.[service],
    fetch: (async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === "string" ? init.body : "",
      };
      calls.push(call);
      const reply = options.reply?.(call) ?? {};
      return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: reply.headers ?? { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
  return { deps, calls };
}

describe("readGeminiLimits", () => {
  afterEach(() => forgetGeminiTokens());
  const credsPath = "/home/me/.gemini/oauth_creds.json";
  const creds = (expiry: number) =>
    JSON.stringify({ access_token: "old-token", refresh_token: "refresh-1", expiry_date: expiry });
  const google = (call: Call): Reply => {
    if (call.url.endsWith(":loadCodeAssist")) {
      return {
        body: { cloudaicompanionProject: "proj-1", currentTier: { id: "free-tier", name: "Gemini Code Assist" } },
      };
    }
    if (call.url.endsWith(":retrieveUserQuota")) {
      return {
        body: {
          buckets: [
            { modelId: "gemini-2.5-flash", remainingFraction: 1, resetTime: "2026-01-11T00:00:00Z" },
            { modelId: "gemini-2.5-pro", remainingFraction: 0.42, resetTime: "2026-01-11T00:00:00Z" },
            { modelId: "gemini-2.5-pro_vertex", remainingFraction: 0.5, resetTime: "2026-01-11T00:00:00Z" },
            { modelId: "gemini-2.0-flash", tokenType: "REQUESTS" },
          ],
        },
      };
    }
    if (call.url === "https://oauth2.googleapis.com/token")
      return { body: { access_token: "new-token", expires_in: 3600 } };
    return { status: 404 };
  };
  const geminiDeps = (files: Record<string, string>, client = true) => {
    const fake = fakeDeps({ files, reply: google });
    let lookups = 0;
    const deps: GeminiLimitDeps = {
      ...fake.deps,
      oauthClient: async () => {
        lookups += 1;
        return client ? { clientId: "cli-id", clientSecret: "cli-secret" } : undefined;
      },
    };
    return { deps, calls: fake.calls, lookups: () => lookups };
  };

  it("reads each model's quota, with its project and plan", async () => {
    const { deps, calls } = geminiDeps({ [credsPath]: creds(NOW + 3_600_000) });
    const read = await readGeminiLimits(undefined, deps);
    expect(read).toEqual({
      state: "ok",
      plan: "Gemini Code Assist",
      windows: [
        { scope: "2.5 Pro", usedPercent: 58, resetsAt: "2026-01-11T00:00:00.000Z" },
        { scope: "2.5 Flash", usedPercent: 0, resetsAt: "2026-01-11T00:00:00.000Z" },
      ],
    });
    expect(calls.map((call) => call.url.split(":").pop())).toEqual(["loadCodeAssist", "retrieveUserQuota"]);
    expect(calls[1]?.headers.Authorization).toBe("Bearer old-token");
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ project: "proj-1" });
  });

  it("refreshes an expired token in memory with Gemini CLI's client, once", async () => {
    const { deps, calls } = geminiDeps({ [credsPath]: creds(NOW - 1) });
    expect((await readGeminiLimits(undefined, deps)).state).toBe("ok");
    expect((await readGeminiLimits(undefined, deps)).state).toBe("ok");
    const refreshes = calls.filter((call) => call.url.includes("oauth2"));
    expect(refreshes).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(refreshes[0]?.body))).toEqual({
      client_id: "cli-id",
      client_secret: "cli-secret",
      refresh_token: "refresh-1",
      grant_type: "refresh_token",
    });
    expect(
      calls
        .filter((call) => call.url.includes("cloudcode"))
        .every((call) => call.headers.Authorization === "Bearer new-token"),
    ).toBe(true);
  });

  it("waits for Gemini CLI when the token expired and its client cannot be found", async () => {
    const { deps, calls } = geminiDeps({ [credsPath]: creds(NOW - 1) }, false);
    expect((await readGeminiLimits(undefined, deps)).state).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("hides an API key login without calling Google, even with an old sign-in on disk", async () => {
    const { deps, calls } = geminiDeps({
      [credsPath]: creds(NOW + 3_600_000),
      "/home/me/.gemini/settings.json": JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
    });
    expect((await readGeminiLimits(undefined, deps)).state).toBe("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("reads a saved account from its own GEMINI_CLI_HOME", async () => {
    const { deps } = geminiDeps({ "/accounts/work/.gemini/oauth_creds.json": creds(NOW + 3_600_000) });
    expect((await readGeminiLimits("/accounts/work", deps)).state).toBe("ok");
    expect((await readGeminiLimits(undefined, deps)).state).toBe("signed-out");
  });

  it("names models the way Gemini CLI does", () => {
    expect(
      [
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite-preview-06-17",
        "gemini-3-pro-preview_vertex",
        "gemini-1.5-flash-002",
      ].map(modelName),
    ).toEqual(["2.5 Pro", "2.5 Flash Lite", "3 Pro", "1.5 Flash"]);
  });
});

describe("findGeminiOAuthClient", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("finds the client in a bundled npm global install through the bin link", async () => {
    root = await mkdtemp(join(tmpdir(), "zli-gemini-"));
    const pkg = join(root, "lib", "node_modules", "@google", "gemini-cli");
    await mkdir(join(pkg, "bundle"), { recursive: true });
    await mkdir(join(root, "bin"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@google/gemini-cli" }));
    await writeFile(join(pkg, "bundle", "gemini.js"), "import './chunk-1.js';");
    await writeFile(
      join(pkg, "bundle", "chunk-1.js"),
      'var OAUTH_CLIENT_ID = "id-1.apps";\nvar OAUTH_CLIENT_SECRET = "secret-1";',
    );
    await symlink(join(pkg, "bundle", "gemini.js"), join(root, "bin", "gemini"));
    expect(await findGeminiOAuthClient(join(root, "bin", "gemini"))).toEqual({
      clientId: "id-1.apps",
      clientSecret: "secret-1",
    });
  });

  it("reads both constants or none", () => {
    expect(parseOAuthClient("const OAUTH_CLIENT_ID = 'a';")).toBeUndefined();
  });
});

describe("readCursorLimits", () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ sub: "auth0|1", exp })).toString("base64url")}.y`;
  const usage = {
    billingCycleEnd: "1768694400000",
    planUsage: { totalPercentUsed: 44, autoPercentUsed: 20, apiPercentUsed: 71 },
  };

  it("reads the month and its pools with the Keychain login on macOS", async () => {
    const token = jwt(NOW / 1000 + 3_600);
    const { deps, calls } = fakeDeps({
      platform: "darwin",
      keychain: { "cursor-access-token": token },
      reply: () => ({ body: usage }),
    });
    const resetsAt = new Date(1_768_694_400_000).toISOString();
    expect(await readCursorLimits(undefined, deps)).toEqual({
      state: "ok",
      windows: [
        { durationMinutes: 43_200, usedPercent: 44, resetsAt },
        { scope: "Auto", durationMinutes: 43_200, usedPercent: 20, resetsAt },
        { scope: "API", durationMinutes: 43_200, usedPercent: 71, resetsAt },
      ],
    });
    expect(calls[0]).toMatchObject({
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "connect-protocol-version": "1" },
    });
  });

  it("does not send an expired token", async () => {
    const { deps, calls } = fakeDeps({
      files: { "/home/me/.config/cursor/auth.json": JSON.stringify({ accessToken: jwt(NOW / 1000 - 1) }) },
    });
    expect((await readCursorLimits(undefined, deps)).state).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("hides API keys, and saved macOS accounts whose login is in the shared Keychain item", async () => {
    expect((await readCursorLimits(undefined, fakeDeps({ env: { CURSOR_API_KEY: "key" } }).deps)).state).toBe(
      "unavailable",
    );
    expect((await readCursorLimits("/accounts/work", fakeDeps({ platform: "darwin" }).deps)).state).toBe("unavailable");
    expect((await readCursorLimits("/accounts/work", fakeDeps({}).deps)).state).toBe("signed-out");
  });
});

describe("readKimiLimits", () => {
  const credentials = (expiresAt: number) =>
    JSON.stringify({ access_token: "kimi-token", refresh_token: "r", expires_at: expiresAt });

  it("reads the weekly window and the 5-hour one from limits[]", async () => {
    const { deps, calls } = fakeDeps({
      files: { "/home/me/.kimi-code/credentials/kimi-code.json": credentials(NOW / 1000 + 600) },
      reply: () => ({
        body: {
          usage: { limit: "100", used: "35", resetTime: "2026-01-15T00:00:00Z" },
          limits: [
            {
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
              detail: { limit: 50, remaining: 39, resetTime: "2026-01-10T15:00:00Z" },
            },
          ],
        },
      }),
    });
    expect(await readKimiLimits(undefined, deps)).toEqual({
      state: "ok",
      windows: [
        { durationMinutes: 300, usedPercent: 22, resetsAt: "2026-01-10T15:00:00.000Z" },
        { durationMinutes: 10_080, usedPercent: 35, resetsAt: "2026-01-15T00:00:00.000Z" },
      ],
    });
    expect(calls[0]?.url).toBe("https://api.kimi.com/coding/v1/usages");
  });

  it("leaves an expired token to Kimi Code", async () => {
    const { deps, calls } = fakeDeps({
      files: { "/accounts/k/credentials/kimi-code.json": credentials(NOW / 1000 + 2) },
    });
    expect((await readKimiLimits("/accounts/k", deps)).state).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("follows a custom host to its own credentials file", () => {
    const toml = '[providers."managed:kimi-code"]\nbase_url = "https://kimi.example/v1/"\n';
    const custom = kimiEndpoint(toml, {});
    expect(custom.usageUrl).toBe("https://kimi.example/v1/usages");
    expect(custom.tokenName).toMatch(/^kimi-code-env-[0-9a-f]{16}$/u);
    expect(kimiEndpoint(toml, { KIMI_CODE_BASE_URL: "https://api.kimi.com/coding/v1" }).tokenName).toBe("kimi-code");
  });
});

describe("readOpenCodeLimits", () => {
  const go = {
    usage: {
      rolling: { percent: 8, resetsAt: "2026-01-10T16:00:00Z" },
      weekly: { percent: 27, resetsAt: "2026-01-16T00:00:00Z" },
      monthly: { percent: 51, resetsAt: "2026-02-01T00:00:00Z" },
    },
  };
  const openCodeDeps = (options: Parameters<typeof fakeDeps>[0], rows: Array<[string, string]> = []) => {
    const fake = fakeDeps(options);
    const deps: OpenCodeLimitDeps = { ...fake.deps, credentials: async () => rows };
    return { deps, calls: fake.calls };
  };

  it("tries the next key when one has no Go subscription", async () => {
    const { deps, calls } = openCodeDeps(
      {
        files: {
          "/home/me/.local/share/opencode/auth.json": JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
        },
        reply: (call) =>
          call.headers.Authorization === "Bearer go-key"
            ? { body: go }
            : { status: 403, body: { error: { type: "EntitlementError" } } },
      },
      [
        [
          "opencode",
          JSON.stringify({ type: "key", key: "zen-key", metadata: { server: "https://opencode.ai/console" } }),
        ],
      ],
    );
    expect(await readOpenCodeLimits(deps)).toEqual({
      state: "ok",
      windows: [
        { durationMinutes: 300, usedPercent: 8, resetsAt: "2026-01-10T16:00:00.000Z" },
        { durationMinutes: 10_080, usedPercent: 27, resetsAt: "2026-01-16T00:00:00.000Z" },
        { durationMinutes: 43_200, usedPercent: 51, resetsAt: "2026-02-01T00:00:00.000Z" },
      ],
    });
    expect(calls.map((call) => call.headers.Authorization)).toEqual(["Bearer zen-key", "Bearer go-key"]);
  });

  it("reads Go and Console keys from OpenCode's database, Go first, skipping switched-off ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zli-opencode-"));
    try {
      const path = join(dir, "opencode.db");
      const database = new DatabaseSync(path);
      database.exec(
        "CREATE TABLE credential (id TEXT, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)",
      );
      const insert = database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)");
      insert.run("1", "opencode", "console", 1, 3);
      insert.run("2", "opencode-go", "old", 0, 1);
      insert.run("3", "opencode-go", "go", 1, 2);
      insert.run("4", "anthropic", "other", 1, 4);
      database.close();
      expect(await openCodeCredentials(path)).toEqual([
        ["opencode-go", "go"],
        ["opencode", "console"],
      ]);
      expect(await openCodeCredentials(join(dir, "missing.db"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never sends a self-hosted server's key to opencode.ai", async () => {
    const { deps, calls } = openCodeDeps({}, [
      ["opencode", JSON.stringify({ type: "key", key: "own", metadata: { server: "https://oc.example.com" } })],
    ]);
    expect((await readOpenCodeLimits(deps)).state).toBe("signed-out");
    expect(calls).toHaveLength(0);
  });

  it("hides a shared key that is not for Go, and asks to reconnect a rejected Go key", async () => {
    const rejected = () => ({ status: 401, body: { error: { type: "AuthError" } } });
    const shared = openCodeDeps({ env: { OPENCODE_API_KEY: "other" }, reply: rejected });
    expect((await readOpenCodeLimits(shared.deps)).state).toBe("unavailable");
    const stored = openCodeDeps({ reply: rejected }, [["opencode-go", JSON.stringify({ type: "key", key: "go" })]]);
    expect((await readOpenCodeLimits(stored.deps)).state).toBe("expired");
  });
});
