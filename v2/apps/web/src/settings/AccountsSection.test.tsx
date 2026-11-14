// @vitest-environment jsdom

import type { ProviderDiscovery } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAccountsStore } from "../accounts/accounts.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AccountsSection } from "./AccountsSection.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  resetAccountsStore();
});

const at = "2026-11-12T10:00:00.000Z";
const found = (provider: ProviderDiscovery["provider"], displayName: string, extra: object = {}) =>
  ({ provider, displayName, status: "found", path: `/bin/${provider}`, ...extra }) as ProviderDiscovery;

const PROVIDERS: ProviderDiscovery[] = [
  found("codex", "Codex", {
    login: { status: "signed-in", method: "subscription", email: "kim@example.com", plan: "plus" },
  }),
  found("claude-code", "Claude Code", { login: { status: "signed-out" } }),
  found("cursor-agent", "Cursor", {
    login: { status: "signed-in", method: "subscription", email: "kim@example.com" },
    problem: { kind: "no-plan", message: "Upgrade required to use this model", at },
  }),
  found("droid", "Droid", { login: { status: "signed-in", method: "api-key" } }),
  found("opencode", "OpenCode"),
  { provider: "gemini", displayName: "Gemini", status: "missing", reason: "Gemini CLI was not found." },
  { provider: "goose", displayName: "Goose", status: "missing", reason: "Goose CLI was not found." },
];

type Command = { type: string; clearProblem?: string };

async function render(answer: (command: Command) => unknown) {
  const commands: Command[] = [];
  const dispatch = vi.fn(async (request: { commandId: string; command: Command }) => {
    commands.push(request.command);
    if (request.command.type === "accounts.list") {
      return { commandId: request.commandId, accepted: true, result: { accounts: [] } };
    }
    const result = await answer(request.command);
    return result instanceof Error
      ? { commandId: request.commandId, accepted: false, error: { code: "internal", message: result.message } }
      : { commandId: request.commandId, accepted: true, result };
  });
  const bridge = {
    runtime: { getProjection: async () => undefined, onProjection: () => () => undefined, dispatch },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <AccountsSection projection={undefined} />
      </RuntimeProvider>,
    );
  });
  return { container, commands };
}

function group(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("section.settings-group")].find((section) =>
    section.querySelector(".settings-group-title")?.textContent?.includes(name),
  );
}

describe("AccountsSection", () => {
  it("checks every agent when it opens and says what each one is signed in as", async () => {
    const { container, commands } = await render(() => ({ providers: PROVIDERS }));
    expect(commands.filter((command) => command.type === "providers.discover")).toHaveLength(1);

    const status = (name: string) => group(container, name)?.querySelector(".accounts-status")?.textContent;
    expect(status("Codex")).toBe("Signed in as kim@example.com · Plus");
    expect(status("Claude Code")).toBe("Not signed in");
    expect(status("Cursor")).toBe("Signed in as kim@example.com · No active plan");
    expect(status("Droid")).toBe("Signed in with an API key");
    expect(status("OpenCode")).toBe("Sign-in unknown");

    // The signed-out agent says what to run and offers to copy it; a subscription needs no action.
    expect(group(container, "Claude Code")?.textContent).toContain("Run claude in a terminal to sign in");
    expect(
      group(container, "Claude Code")?.querySelector('[aria-label="Copy the sign-in command for Claude Code"]'),
    ).not.toBeNull();
    expect(group(container, "Codex")?.querySelector('[aria-label^="Check again"]')).toBeNull();
    // The failed run is quoted in the agent's own words.
    expect(group(container, "Cursor")?.textContent).toContain("“Upgrade required to use this model”");
    expect(group(container, "Droid")?.textContent).toContain("does not read or show the key");

    // Agents that are not installed share one group, with the install command when there is one.
    const missing = group(container, "Not installed");
    expect(missing?.textContent).toContain("Gemini");
    expect(missing?.textContent).toContain("npm install -g @google/gemini-cli");
    expect(missing?.textContent).toContain("Goose CLI was not found.");
  });

  it("clears the recorded failure when the person tries an agent with no plan again", async () => {
    const { container, commands } = await render(() => ({ providers: PROVIDERS }));
    const retry = group(container, "Cursor")?.querySelector<HTMLButtonElement>('[aria-label="Try again with Cursor"]');
    await act(async () => retry?.click());
    expect(commands.at(-1)).toEqual({ type: "providers.discover", clearProblem: "cursor-agent" });
  });

  it("re-checks on request", async () => {
    const { container, commands } = await render(() => ({ providers: PROVIDERS }));
    const recheck = [...container.querySelectorAll("button")].find((button) => button.textContent === "Re-check");
    await act(async () => recheck?.click());
    expect(commands.filter((command) => command.type === "providers.discover")).toHaveLength(2);
  });

  it("says when the check failed and lets the person try again", async () => {
    let fail = true;
    const { container } = await render(() =>
      fail ? new Error("ZLI could not look for agents. Try again.") : { providers: PROVIDERS },
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ZLI could not look for agents");
    fail = false;
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    await act(async () => retry?.click());
    expect(group(container, "Codex")).toBeDefined();
  });

  it("shows that it is checking until the runtime answers", async () => {
    const { container } = await render(() => new Promise(() => undefined));
    expect(container.textContent).toContain("Checking each agent's sign-in");
  });
});
