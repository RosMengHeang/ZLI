import type { ThreadMessageProjection, ThreadProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "../sessions/sessions.js";
import { mergeRoomTimeline, missedBy, roomBrief, roomGuests } from "./room.js";

const message = (messageId: string, threadId: string, role: ThreadMessageProjection["role"], text: string) =>
  ({ messageId, threadId, role, text }) as ThreadMessageProjection;

describe("room", () => {
  it("finds the agents brought into any thread of the chat", () => {
    const threads = [
      { threadId: "h" },
      { threadId: "g", joins: "h" },
      { threadId: "x", joins: "other" },
    ] as ThreadProjection[];
    expect(roomGuests(new Set(["h"]), threads).map((thread) => thread.threadId)).toEqual(["g"]);
  });

  it("puts each guest message before the first host message written after it", () => {
    const own: TimelineItem[] = [
      { kind: "message", message: message("h1", "h", "user", "one") },
      { kind: "work", key: "w", turnId: "t", activities: [], changedFiles: [] },
      { kind: "message", message: message("h2", "h", "assistant", "two") },
      { kind: "message", message: message("h3", "h", "user", "three") },
    ];
    const guest = [message("g1", "g", "user", "@Owl look"), message("g2", "g", "assistant", "seen")];
    const order = new Map([
      ["h1", 0],
      ["h2", 1],
      ["g1", 2],
      ["g2", 3],
      ["h3", 4],
    ]);
    const merged = mergeRoomTimeline(own, guest, order).map((item) =>
      item.kind === "work" ? "work" : item.message.messageId,
    );
    expect(merged).toEqual(["h1", "work", "h2", "g1", "g2", "h3"]);
  });

  it("tells a member only what the others said since it last spoke", () => {
    const messages = [
      message("1", "h", "user", "Add login"),
      message("2", "g", "assistant", "Earlier note"),
      message("3", "h", "assistant", "Done"),
      message("4", "g", "user", "@Owl review"),
      message("5", "g", "assistant", "Two bugs"),
      message("6", "g", "system", "ignored"),
    ];
    expect(missedBy(new Set(["h"]), messages).map((entry) => entry.messageId)).toEqual(["4", "5"]);
    const brief = roomBrief({
      name: "Fox",
      joining: false,
      others: ["Owl"],
      branch: "main",
      missed: missedBy(new Set(["h"]), messages),
      nameOf: () => "Owl",
    });
    expect(brief).toContain("Since your last reply, this was said in the chat with Owl:");
    expect(brief).toContain("## Owl\n\nTwo bugs");
    expect(roomBrief({ name: "Fox", joining: false, others: [], branch: "main", missed: [], nameOf: () => "" })).toBe(
      undefined,
    );
  });
});
