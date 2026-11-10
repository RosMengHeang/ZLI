import { describe, expect, it } from "vitest";

import type { SessionStatus } from "../sessions/sessions.js";
import { nextUnread } from "./unread.js";

const session = (sessionId: string, status: SessionStatus) => ({ sessionId, status });
const before = (entries: Record<string, SessionStatus>) => new Map(Object.entries(entries));

describe("nextUnread", () => {
  it("marks a chat whose turn ended, or failed, while another chat was open", () => {
    const unread = nextUnread(
      new Set(),
      before({ a: "working", b: "waiting", c: "working", d: "starting" }),
      [session("a", "ready"), session("b", "failed"), session("c", "ready"), session("d", "failed")],
      "c",
    );
    expect([...unread]).toEqual(["a", "b", "d"]);
  });

  it("leaves a chat alone when it only started, was stopped, or is seen for the first time", () => {
    const unread = nextUnread(
      new Set(),
      before({ a: "starting", b: "working" }),
      [session("a", "ready"), session("b", "ended"), session("c", "ready")],
      undefined,
    );
    expect(unread.size).toBe(0);
  });

  it("keeps a mark until the chat is opened, deleted, or set to work again", () => {
    const marked = new Set(["a", "b", "c", "gone"]);
    const unread = nextUnread(
      marked,
      before({ a: "ready", b: "ready", c: "ready" }),
      [session("a", "ready"), session("b", "ready"), session("c", "working")],
      "b",
    );
    expect([...unread]).toEqual(["a"]);
  });

  it("returns the same set when nothing changed", () => {
    const marked = new Set(["a"]);
    expect(nextUnread(marked, before({ a: "ready" }), [session("a", "ready")], undefined)).toBe(marked);
  });
});
