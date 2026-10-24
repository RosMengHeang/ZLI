import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pollDeviceFlow, startDeviceFlow } from "./github.js";
import { McpSignIns } from "./McpSignIns.js";
import type { FetchLike } from "./oauth.js";
import { freshAccessToken } from "./tokenFile.js";

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const GITHUB_MCP = "https://api.githubcopilot.com/mcp/";

function githubFetch(tokenReplies: unknown[] = []): FetchLike {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (url === GITHUB_MCP) {
      return json({}, 401, {
        "www-authenticate":
          'Bearer error="invalid_request", resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"',
      });
    }
    if (url === "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/") {
      return json({
        resource: GITHUB_MCP,
        authorization_servers: ["https://github.com/login/oauth"],
        scopes_supported: ["repo", "read:org"],
      });
    }
    if (url === "https://github.com/.well-known/oauth-authorization-server/login/oauth") {
      return json({
        issuer: "https://github.com/login/oauth",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
      });
    }
    if (url === "https://github.com/login/device/code") {
      return json({
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      return json(tokenReplies.shift() ?? { error: "expired_token" });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    return new Response("not found", { status: 404 });
  }) as FetchLike;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zli-github-"));
  temps.push(dir);
  return dir;
}

describe("GitHub sign-in", () => {
  it("reuses the GitHub CLI login in one step when there is no OAuth App", async () => {
    const signIns = new McpSignIns({
      dir: await tempDir(),
      fetch: githubFetch(),
      githubCliToken: async () => "gho_cli",
    });
    expect(await signIns.start(GITHUB_MCP)).toEqual({ status: "done" });
    expect(signIns.status(GITHUB_MCP)).toMatchObject({ signedIn: true, via: "github-cli", account: "octocat" });
    expect(await freshAccessToken(signIns.tokenFile(GITHUB_MCP))).toBe("gho_cli");
    // A login that cannot be refreshed gives no token once the server turns it down.
    expect(await freshAccessToken(signIns.tokenFile(GITHUB_MCP), { force: true })).toBeUndefined();
  });

  it("explains what to do when the GitHub CLI is not signed in", async () => {
    const signIns = new McpSignIns({
      dir: await tempDir(),
      fetch: githubFetch(),
      githubCliToken: async () => undefined,
    });
    await expect(signIns.start(GITHUB_MCP)).rejects.toThrow("uses the GitHub CLI");
  });

  it("uses the device code flow when an OAuth App client ID is set", async () => {
    const fetchImpl = githubFetch([{ error: "authorization_pending" }, { access_token: "gho_device", scope: "repo" }]);
    const signIns = new McpSignIns({ dir: await tempDir(), fetch: fetchImpl, githubClientId: "Iv1.abc" });
    const start = await signIns.start(GITHUB_MCP);
    expect(start).toMatchObject({ status: "open", url: "https://github.com/login/device", code: "ABCD-1234" });
  });

  it("polls until approved, slowing down when asked", async () => {
    const waits: number[] = [];
    const fetchImpl = githubFetch([
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_device", scope: "repo" },
    ]);
    const code = await startDeviceFlow("Iv1.abc", ["repo"], fetchImpl, () => 0);
    const tokens = await pollDeviceFlow("Iv1.abc", code, new AbortController().signal, {
      fetch: fetchImpl,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(tokens.accessToken).toBe("gho_device");
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("stops polling when the person denies the code", async () => {
    const fetchImpl = githubFetch([{ error: "access_denied" }]);
    const code = await startDeviceFlow("Iv1.abc", [], fetchImpl, () => 0);
    await expect(
      pollDeviceFlow("Iv1.abc", code, new AbortController().signal, {
        fetch: fetchImpl,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("The GitHub sign-in was canceled.");
  });
});
