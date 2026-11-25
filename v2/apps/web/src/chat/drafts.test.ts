// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { moveDraft, readDraft, resetDraftsForTests, writeDraft } from "./drafts.js";

beforeEach(() => {
  localStorage.clear();
  resetDraftsForTests();
});

describe("drafts", () => {
  it("keeps unsent text across a restart and forgets it once cleared", () => {
    writeDraft("thread-1", "half a thought");
    resetDraftsForTests();
    expect(readDraft("thread-1")).toBe("half a thought");
    writeDraft("thread-1", "");
    resetDraftsForTests();
    expect(readDraft("thread-1")).toBe("");
  });

  it("keeps the newest fifty and still works when storage is unreadable", () => {
    for (let index = 0; index < 55; index += 1) writeDraft(`thread-${index}`, `draft ${index}`);
    expect(readDraft("thread-0")).toBe("");
    expect(readDraft("thread-54")).toBe("draft 54");
    localStorage.setItem("zli.drafts", "{not json");
    resetDraftsForTests();
    expect(readDraft("thread-54")).toBe("");
    writeDraft("thread-1", "still here");
    expect(readDraft("thread-1")).toBe("still here");
  });

  it("moves a draft to its new key and leaves no copy under the old one", () => {
    writeDraft("thread-1", "half a thought");
    moveDraft("thread-1", "session-1", "half a thought");
    resetDraftsForTests();
    expect(readDraft("thread-1")).toBe("");
    expect(readDraft("session-1")).toBe("half a thought");
  });

  it("keeps the old key when it holds different text", () => {
    writeDraft("thread-1", "another chat's text");
    moveDraft("thread-1", "session-1", "this box's text");
    expect(readDraft("thread-1")).toBe("another chat's text");
    expect(readDraft("session-1")).toBe("this box's text");
  });
});
