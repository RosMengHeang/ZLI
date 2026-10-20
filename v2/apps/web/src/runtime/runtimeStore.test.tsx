// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { ZliBridge } from "./bridge.js";
import { RuntimeProvider, useRuntimeSelector, useShellProjection } from "./RuntimeProvider.js";
import {
  createRuntimeStore,
  createSelection,
  sameShellProjection,
  shallowArrayEqual,
  shareUnchanged,
} from "./runtimeStore.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const threadId = "00000000-0000-4000-8000-000000000401";

function projection(lastSequence: number, overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/repo", name: "repo" }],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence,
    ...overrides,
  };
}

function message(text: string, role: "user" | "assistant" = "user") {
  return { messageId: `m-${text}`, threadId, role, text } as unknown as NonNullable<
    RuntimeProjection["messages"]
  >[number];
}

function fakeBridge() {
  let emit: (next: RuntimeProjection) => void = () => undefined;
  let resolveInitial: (value: RuntimeProjection | undefined) => void = () => undefined;
  const bridge = {
    runtime: {
      getProjection: () =>
        new Promise<RuntimeProjection | undefined>((resolve) => {
          resolveInitial = resolve;
        }),
      onProjection: (listener: (next: RuntimeProjection) => void) => {
        emit = listener;
        return () => {
          emit = () => undefined;
        };
      },
      dispatch: async () => undefined,
    },
  } as unknown as ZliBridge;
  return {
    bridge,
    emit: (next: RuntimeProjection) => emit(next),
    resolveInitial: (next?: RuntimeProjection) => resolveInitial(next),
  };
}

describe("createRuntimeStore", () => {
  it("keeps a pushed projection when the slower initial fetch returns an older one", async () => {
    const fake = fakeBridge();
    const store = createRuntimeStore(fake.bridge);
    store.start();
    const pushed = projection(5);
    fake.emit(pushed);
    fake.resolveInitial(projection(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(pushed);
  });

  it("applies the initial fetch when it is newer than anything pushed", async () => {
    const fake = fakeBridge();
    const store = createRuntimeStore(fake.bridge);
    store.start();
    fake.emit(projection(2));
    fake.resolveInitial(projection(4));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()?.lastSequence).toBe(4);
  });

  it("stops publishing after the subscription ends", async () => {
    const fake = fakeBridge();
    const store = createRuntimeStore(fake.bridge);
    const stop = store.start();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    fake.emit(projection(1));
    stop();
    fake.resolveInitial(projection(9));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(store.getSnapshot()?.lastSequence).toBe(1);
  });
});

describe("createSelection", () => {
  it("returns the previous value while the comparison says nothing changed", () => {
    let current = projection(1, { terminals: [] });
    const select = createSelection<readonly unknown[]>(() => current, shallowArrayEqual);
    const selectTerminals = (value: RuntimeProjection | undefined) => value?.terminals ?? [];
    const first = select(selectTerminals);
    current = projection(2, { terminals: [] });
    expect(select(selectTerminals)).toBe(first);
  });
});

describe("sameShellProjection", () => {
  it("ignores new chat messages that do not change an agent's first prompt", () => {
    const before = projection(1, { messages: [message("Fix the build")] });
    const after = shareUnchanged(
      before,
      projection(2, { messages: [message("Fix the build"), message("Done", "assistant")] }),
    );
    expect(sameShellProjection(before, after)).toBe(true);
  });

  it("notices a thread's first prompt arriving", () => {
    const before = projection(1);
    expect(sameShellProjection(before, shareUnchanged(before, projection(2, { messages: [message("Hi")] })))).toBe(
      false,
    );
  });

  it("notices changes outside chat state", () => {
    const before = projection(1);
    const after = shareUnchanged(before, projection(2, { attention: [{ threadId } as never] }));
    expect(sameShellProjection(before, after)).toBe(false);
  });
});

describe("shareUnchanged", () => {
  it("reuses unchanged parts of a fresh copy and replaces the parts that changed", () => {
    const before = projection(1, { messages: [message("One")] });
    const after = shareUnchanged(before, projection(2, { messages: [message("One"), message("Two")] }));
    expect(after).not.toBe(before);
    expect(after.environment).toBe(before.environment);
    expect(after.projects).toBe(before.projects);
    expect(after.messages).not.toBe(before.messages);
    expect(after.messages?.[0]).toBe(before.messages?.[0]);
    expect(after.messages?.[1]?.text).toBe("Two");
  });

  it("returns the previous projection when a copy is equal to it", () => {
    const before = projection(1, { messages: [message("One")] });
    expect(shareUnchanged(before, projection(1, { messages: [message("One")] }))).toBe(before);
  });
});

describe("useRuntimeSelector", () => {
  it("re-renders a component only when its slice changes", async () => {
    const fake = fakeBridge();
    let shellRenders = 0;
    let messageRenders = 0;
    const selectMessages = (value: RuntimeProjection | undefined) => value?.messages;
    function Shell() {
      useShellProjection();
      shellRenders += 1;
      return null;
    }
    function Messages() {
      useRuntimeSelector(selectMessages);
      messageRenders += 1;
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={fake.bridge}>
          <Shell />
          <Messages />
        </RuntimeProvider>,
      );
    });
    await act(async () => fake.emit(projection(1, { messages: [message("Fix the build")] })));
    const shellAfterFirst = shellRenders;
    const messagesAfterFirst = messageRenders;
    await act(async () =>
      fake.emit(projection(2, { messages: [message("Fix the build"), message("Working", "assistant")] })),
    );
    expect(shellRenders).toBe(shellAfterFirst);
    expect(messageRenders).toBe(messagesAfterFirst + 1);
    await act(async () => root.unmount());
  });
});
