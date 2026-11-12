import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jwtClaims, parseCursorStatus, readAgentLogin } from "./agentLogin.js";

const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("readAgentLogin", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zli-login-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads Claude Code's account email and plan, and says signed out when there is none", async () => {
    expect(await readAgentLogin("claude-code", { home, env: {} })).toEqual({ status: "signed-out" });
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "kim@example.com" } }));
    await writeFile(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "secret", subscriptionType: "max" } }),
    );
    const login = await readAgentLogin("claude-code", { home, env: {} });
    expect(login).toEqual({ status: "signed-in", method: "subscription", email: "kim@example.com", plan: "max" });
    expect(JSON.stringify(login)).not.toContain("secret");
  });

  it("takes an Anthropic API key as signed in", async () => {
    expect(await readAgentLogin("claude-code", { home, env: { ANTHROPIC_API_KEY: "k" } })).toEqual({
      status: "signed-in",
      method: "api-key",
    });
  });

  it("reads Codex's ChatGPT account from its id token, and an API key without one", async () => {
    const codex = join(home, ".codex");
    await mkdir(codex);
    expect(await readAgentLogin("codex", { home, env: {} })).toEqual({ status: "signed-out" });
    await writeFile(
      join(codex, "auth.json"),
      JSON.stringify({
        tokens: {
          id_token: jwt({ email: "kim@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
          access_token: "secret",
        },
      }),
    );
    expect(await readAgentLogin("codex", { home, env: {} })).toEqual({
      status: "signed-in",
      method: "subscription",
      email: "kim@example.com",
      plan: "plus",
    });
    await writeFile(join(codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-1" }));
    expect(await readAgentLogin("codex", { home, env: {} })).toEqual({ status: "signed-in", method: "api-key" });
  });

  it("does not guess when Codex keeps its login in the keychain or CODEX_HOME moves it", async () => {
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(await readAgentLogin("codex", { home, env: { CODEX_HOME: elsewhere } })).toBeUndefined();
  });

  it("reads Gemini's active Google account and leaves other agents unknown", async () => {
    expect(await readAgentLogin("gemini", { home, env: {} })).toBeUndefined();
    await mkdir(join(home, ".gemini"));
    await writeFile(join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active: "kim@example.com" }));
    expect(await readAgentLogin("gemini", { home, env: {} })).toEqual({
      status: "signed-in",
      email: "kim@example.com",
    });
    expect(await readAgentLogin("copilot", { home, env: {} })).toBeUndefined();
  });

  it("reads Droid, OpenCode, and Kimi Code from the files they keep", async () => {
    expect(await readAgentLogin("droid", { home, env: {} })).toEqual({ status: "signed-out" });
    await mkdir(join(home, ".factory"));
    await writeFile(join(home, ".factory", "auth.v2.keyring"), "x");
    expect(await readAgentLogin("droid", { home, env: {} })).toEqual({ status: "signed-in", method: "subscription" });

    expect(await readAgentLogin("opencode", { home, env: {} })).toBeUndefined();
    const data = join(home, ".local", "share", "opencode");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "auth.json"), JSON.stringify({ openrouter: { type: "api", key: "secret" } }));
    expect(await readAgentLogin("opencode", { home, env: {} })).toEqual({ status: "signed-in", method: "api-key" });
    await writeFile(join(data, "auth.json"), "{}");
    expect(await readAgentLogin("opencode", { home, env: {} })).toEqual({ status: "signed-out" });

    expect(await readAgentLogin("kimi", { home, env: {} })).toEqual({ status: "signed-out" });
    const credentials = join(home, ".kimi-code", "credentials");
    await mkdir(credentials, { recursive: true });
    await writeFile(join(credentials, "kimi-code.json"), JSON.stringify({ access_token: "secret" }));
    const kimi = await readAgentLogin("kimi", { home, env: {} });
    expect(kimi).toEqual({ status: "signed-in", method: "subscription" });
    expect(JSON.stringify(kimi)).not.toContain("secret");
  });

  it("reads what cursor-agent status prints", () => {
    expect(parseCursorStatus("\u001b[32m✓ Login successful!\nLogged in as kim@example.com\n")).toEqual({
      status: "signed-in",
      method: "subscription",
      email: "kim@example.com",
    });
    expect(parseCursorStatus("Logged in (unable to fetch user details)")).toEqual({
      status: "signed-in",
      method: "subscription",
    });
    expect(parseCursorStatus("Not logged in. Run cursor-agent login.")).toEqual({ status: "signed-out" });
    expect(parseCursorStatus("something else")).toBeUndefined();
  });

  it("ignores a malformed token", () => {
    expect(jwtClaims("not-a-jwt")).toBeUndefined();
    expect(jwtClaims("a.%%%.c")).toBeUndefined();
  });
});
