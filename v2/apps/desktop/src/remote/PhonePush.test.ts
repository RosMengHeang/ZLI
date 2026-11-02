import { RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DevicePush, StoredDevice } from "./MobileAccessStore.js";
import { EXPO_PUSH_URL, PhonePush, type PushFetch } from "./PhonePush.js";

const threadId = "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f";
const worktreeId = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";

function projection(patch: { status?: string; provider?: string; requests?: unknown[] } = {}): RuntimeProjection {
  return RuntimeProjection.parse({
    environment: {
      environmentId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      label: "Studio",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId: "0d3c1f8a-6b1e-4a35-9c2f-4f6e2c1a9b10", path: "/home/dev/app", name: "app" }],
    worktrees: [
      {
        worktreeId,
        projectId: "0d3c1f8a-6b1e-4a35-9c2f-4f6e2c1a9b10",
        path: "/home/dev/app-worktrees/feature-login",
        branch: "feature/login",
        status: "ready",
      },
    ],
    threads: [
      {
        threadId,
        worktreeId,
        provider: patch.provider ?? "codex",
        status: patch.status ?? "working",
        capabilities: {},
      },
    ],
    providers: [
      { provider: "codex", displayName: "Codex", status: "found", path: "/bin/codex" },
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "/bin/claude" },
    ],
    messages: [{ messageId: "m1", threadId, role: "assistant", text: "Tests pass.\nPushed the fix" }],
    requests: patch.requests ?? [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  });
}

function device(deviceId: string, push?: DevicePush): StoredDevice {
  return {
    deviceId,
    name: deviceId,
    publicKey: "k",
    credentialHash: "h",
    pairedAt: "2026-01-01T00:00:00.000Z",
    ...(push ? { push } : {}),
  };
}

function fakeStore(devices: StoredDevice[], enabled = true) {
  const list = devices.map((entry) => ({ ...entry }));
  return {
    enabled,
    devices: () => list.map((entry) => ({ ...entry })),
    device: (deviceId: string) => list.find((entry) => entry.deviceId === deviceId),
    setPush: vi.fn(async (deviceId: string, push: DevicePush | undefined) => {
      const entry = list.find((candidate) => candidate.deviceId === deviceId);
      if (!entry) return false;
      if (push) entry.push = push;
      else delete entry.push;
      return true;
    }),
  };
}

function fakeFetch(
  answer: (messages: { to: string }[]) => unknown = (messages) => ({
    data: messages.map(() => ({ status: "ok", id: "ticket" })),
  }),
) {
  const calls: { url: string; init: Parameters<PushFetch>[1]; messages: { to: string }[] }[] = [];
  const fetch = vi.fn<PushFetch>(async (url, init) => {
    const messages = JSON.parse(init.body) as { to: string }[];
    calls.push({ url, init, messages });
    return { ok: true, status: 200, json: async () => answer(messages) };
  });
  return { fetch, calls };
}

const iphone = { token: "ExponentPushToken[iphone]", platform: "ios" } as const;
const pixel = { token: "ExponentPushToken[pixel]", platform: "android" } as const;

describe("PhonePush", () => {
  it("pushes what the phone would show, only to phones that are not watching", async () => {
    const store = fakeStore([device("away", iphone), device("watching", pixel), device("no-token")]);
    const { fetch, calls } = fakeFetch();
    const push = new PhonePush({ store, attentive: () => new Set(["watching"]), fetch });
    push.update(projection());
    push.update(projection({ status: "idle" }));
    await push.settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPO_PUSH_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.messages).toEqual([
      {
        to: iphone.token,
        title: "Codex",
        subtitle: "Finished",
        body: "Tests pass. Pushed the fix",
        data: { threadId },
        channelId: "agents",
        priority: "high",
      },
    ]);
  });

  it("plays a sound for a request, with the same words as the phone's own alert", async () => {
    const store = fakeStore([device("away", iphone)]);
    const { fetch, calls } = fakeFetch();
    const push = new PhonePush({ store, attentive: () => new Set(), fetch });
    push.update(projection({ provider: "claude-code" }));
    push.update(
      projection({
        provider: "claude-code",
        requests: [
          {
            requestId: "r1",
            threadId,
            kind: "approval",
            payload: { toolName: "Bash", input: { command: "rm -rf build" } },
          },
        ],
      }),
    );
    await push.settled();
    expect(calls[0]?.messages).toEqual([
      expect.objectContaining({
        title: "Claude Code",
        subtitle: "Asks to continue",
        body: "Run a command: rm -rf build",
        sound: "default",
      }),
    ]);
  });

  it("sends nothing for the first projection, without tokens, or with phone access off", async () => {
    const { fetch } = fakeFetch();
    const first = new PhonePush({ store: fakeStore([device("away", iphone)]), attentive: () => new Set(), fetch });
    first.update(projection({ status: "idle" }));

    const noTokens = new PhonePush({ store: fakeStore([device("plain")]), attentive: () => new Set(), fetch });
    const off = new PhonePush({ store: fakeStore([device("away", iphone)], false), attentive: () => new Set(), fetch });
    for (const push of [noTokens, off]) {
      push.update(projection());
      push.update(projection({ status: "idle" }));
      await push.settled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forgets a token Expo says is no longer registered", async () => {
    const store = fakeStore([device("gone", iphone), device("here", pixel)]);
    const { fetch } = fakeFetch((messages) => ({
      data: messages.map((message) =>
        message.to === iphone.token
          ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }
          : { status: "error", message: "too big", details: { error: "MessageTooBig" } },
      ),
    }));
    const onChange = vi.fn();
    const log = vi.fn();
    const push = new PhonePush({ store, attentive: () => new Set(), fetch, onChange, log });
    push.update(projection());
    push.update(projection({ status: "failed" }));
    await push.settled();

    expect(store.device("gone")?.push).toBeUndefined();
    expect(store.device("here")?.push).toEqual(pixel);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("phone push not delivered", { deviceId: "here", reason: "MessageTooBig" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("ExponentPushToken");
  });

  it("keeps working when Expo cannot be reached or refuses the request", async () => {
    const log = vi.fn();
    const store = fakeStore([device("away", iphone)]);
    const fetch = vi
      .fn<PushFetch>()
      .mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"))
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    const push = new PhonePush({ store, attentive: () => new Set(), fetch, log });
    push.update(projection());
    push.update(projection({ status: "idle" }));
    push.update(projection({ status: "working" }));
    push.update(projection({ status: "idle" }));
    await push.settled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([message]) => message)).toEqual(["phone push failed", "phone push refused"]);
    expect(store.setPush).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("ExponentPushToken");
  });

  it("sends at most 100 messages per request", async () => {
    const devices = Array.from({ length: 101 }, (_, index) =>
      device(`d${index}`, { token: `ExponentPushToken[t${index}]`, platform: "android" }),
    );
    const { fetch, calls } = fakeFetch();
    const push = new PhonePush({ store: fakeStore(devices), attentive: () => new Set(), fetch });
    push.update(projection());
    push.update(projection({ status: "idle" }));
    await push.settled();
    expect(calls.map((call) => call.messages.length)).toEqual([100, 1]);
  });
});
