// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { defaultSendTarget, lastSendTarget, rememberSendTarget, type SendTarget, sentNotice } from "./sendToAgent.js";

const chat: SendTarget = {
  key: "s1:chat",
  sessionId: "s1",
  mode: "chat",
  threadId: "t1",
  agent: "Codex",
  title: "Fix the login form",
  detail: "Codex chat · Ready",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const terminal: SendTarget = {
  key: "s2:terminal",
  sessionId: "s2",
  mode: "terminal",
  terminalId: "x2",
  agent: "Claude Code",
  title: "Claude Code",
  detail: "Claude Code terminal · Working",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => window.localStorage.clear());

describe("defaultSendTarget", () => {
  it("uses the agent picked last while it can still take messages, else the only one", () => {
    expect(defaultSendTarget([], undefined)).toBeUndefined();
    expect(defaultSendTarget([chat], undefined)).toBe(chat);
    expect(defaultSendTarget([chat, terminal], undefined)).toBeUndefined();
    expect(defaultSendTarget([chat, terminal], terminal.key)).toBe(terminal);
    expect(defaultSendTarget([chat], terminal.key)).toBe(chat);
    expect(defaultSendTarget([chat, { ...terminal, key: "s3:terminal" }], terminal.key)).toBeUndefined();
  });
});

describe("rememberSendTarget", () => {
  it("keeps the last agent for each worktree and drops the oldest worktrees", () => {
    rememberSendTarget("w1", chat.key);
    rememberSendTarget("w2", terminal.key);
    rememberSendTarget("w1", terminal.key);
    expect(lastSendTarget("w1")).toBe(terminal.key);
    expect(lastSendTarget("w2")).toBe(terminal.key);
    for (let index = 0; index < 50; index += 1) rememberSendTarget(`other-${index}`, chat.key);
    expect(lastSendTarget("w2")).toBeUndefined();
    expect(lastSendTarget("other-49")).toBe(chat.key);
  });

  it("ignores stored values it cannot read", () => {
    window.localStorage.setItem("zli.sendTarget.v1", "{");
    expect(lastSendTarget("w1")).toBeUndefined();
    window.localStorage.setItem("zli.sendTarget.v1", JSON.stringify({ w1: 3, w2: "s1:chat" }));
    expect(lastSendTarget("w1")).toBeUndefined();
    expect(lastSendTarget("w2")).toBe("s1:chat");
  });
});

describe("sentNotice", () => {
  it("says where the message went and what is left to do in a terminal", () => {
    expect(sentNotice(chat)).toBe("Sent to Codex.");
    expect(sentNotice(terminal)).toBe("Pasted in Claude Code. Press Enter there to send it.");
    expect(sentNotice(terminal, [{ name: "a.png", mimeType: "image/png", dataBase64: "" }])).toBe(
      "Pasted in Claude Code without the images. Press Enter there to send it.",
    );
  });
});
