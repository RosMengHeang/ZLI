// @vitest-environment jsdom

import type { AgentReachAnswer, AgentReachRequest } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { AgentReachDialog } from "./AgentReachDialog.js";
import { useAgentReach } from "./agentReach.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

const request: AgentReachRequest = {
  requestId: "00000000-0000-4000-8000-000000000001",
  agent: "Bob",
  project: "idp-collect",
  target: { agent: "Kim", project: "idp-webclient" },
};

function Harness({ bridge }: { bridge: ZliBridge }) {
  const { request: asking, answer } = useAgentReach(bridge);
  return asking ? <AgentReachDialog request={asking} onAnswer={answer} /> : null;
}

function fakeBridge(
  options: {
    current?: AgentReachRequest;
    /** Resolves current() later, as when the window loads before main answers. */
    late?: Promise<AgentReachRequest | undefined>;
    fail?: string;
    /** Holds the answer until it resolves. */
    hold?: Promise<void>;
  } = {},
) {
  const answers: AgentReachAnswer[] = [];
  let listener: ((value: AgentReachRequest | undefined) => void) | undefined;
  const bridge = {
    agentReach: {
      current: async () => (options.late ? options.late : options.current),
      answer: async (answer: AgentReachAnswer) => {
        await options.hold;
        if (options.fail) throw new Error(options.fail);
        answers.push(answer);
      },
      onRequest: (next: (value: AgentReachRequest | undefined) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  } as unknown as ZliBridge;
  return { bridge, answers, emit: (value: AgentReachRequest | undefined) => listener?.(value) };
}

async function mount(bridge: ZliBridge) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness bridge={bridge} />));
  return { container, root };
}

const buttonNamed = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

describe("AgentReachDialog", () => {
  it("names who wants to reach whom and allows it", async () => {
    const fake = fakeBridge();
    const { container, root } = await mount(fake.bridge);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => fake.emit(request));
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Let Bob message Kim?");
    expect(container.textContent).toContain("Bob in idp-collect is trying to reach Kim, who works in idp-webclient.");
    expect(document.activeElement?.textContent).toBe("Allow every project");
    await act(async () => buttonNamed(container, "Allow every project")?.click());
    expect(fake.answers).toEqual([{ requestId: request.requestId, allow: true }]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("shows a question asked before the window loaded, and declines it", async () => {
    const fake = fakeBridge({ current: { requestId: request.requestId, agent: "Ana", project: "api" } });
    const { container, root } = await mount(fake.bridge);
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Let Ana see your other projects?");
    await act(async () => buttonNamed(container, "Not now")?.click());
    expect(fake.answers).toEqual([{ requestId: request.requestId, allow: false }]);
    await act(async () => root.unmount());
  });

  it("keeps the question up with the problem when the answer fails", async () => {
    const fake = fakeBridge({ current: request, fail: "ZLI's runtime is still starting." });
    const { container, root } = await mount(fake.bridge);
    await act(async () => buttonNamed(container, "Allow every project")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ZLI's runtime is still starting.");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("declines from the close button and from a click outside", async () => {
    const fake = fakeBridge({ current: request });
    const { container, root } = await mount(fake.bridge);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(fake.answers).toEqual([{ requestId: request.requestId, allow: false }]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const next = { ...request, requestId: "00000000-0000-4000-8000-000000000002" };
    await act(async () => fake.emit(next));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Not now"]')?.click());
    expect(fake.answers.at(-1)).toEqual({ requestId: next.requestId, allow: false });
    await act(async () => root.unmount());
  });

  it("sends one answer while it is going through", async () => {
    let release: () => void = () => undefined;
    const fake = fakeBridge({ current: request, hold: new Promise<void>((resolve) => (release = resolve)) });
    const { container, root } = await mount(fake.bridge);
    await act(async () => buttonNamed(container, "Allow every project")?.click());
    expect(buttonNamed(container, "Not now")?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".dialog-scrim")?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    await act(async () => release());
    expect(fake.answers).toEqual([{ requestId: request.requestId, allow: true }]);
    await act(async () => root.unmount());
  });

  it("closes once the question is answered elsewhere, and shows the next one", async () => {
    const fake = fakeBridge({ current: request });
    const { container, root } = await mount(fake.bridge);
    await act(async () => fake.emit(undefined));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      fake.emit({ requestId: "00000000-0000-4000-8000-000000000002", agent: "Ana", project: "api" }),
    );
    expect(container.querySelector(".dialog-title")?.textContent).toBe("Let Ana see your other projects?");
    expect(fake.answers).toEqual([]);
    await act(async () => root.unmount());
  });

  it("keeps newer news over a question the window loaded late", async () => {
    let load: (value: AgentReachRequest | undefined) => void = () => undefined;
    const fake = fakeBridge({ late: new Promise((resolve) => (load = resolve)) });
    const { container, root } = await mount(fake.bridge);
    await act(async () => fake.emit(undefined));
    await act(async () => load(request));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
