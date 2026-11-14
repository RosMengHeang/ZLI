// @vitest-environment jsdom

import { CommandId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Composer, seedComposerDraft } from "../chat/Composer.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { type ChatFolder, NoProjectChat } from "./NoProjectChat.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

function bridge(): ZliBridge {
  return {
    runtime: {
      dispatch: async (request: { commandId: string; command: { type: string } }) => ({
        commandId: CommandId.parse(request.commandId),
        accepted: true as const,
        result: request.command.type === "history.scan" ? { folders: [] } : {},
      }),
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
    app: { getVersion: async () => "0", quit: async () => undefined },
  } as unknown as ZliBridge;
}

const folder: ChatFolder = { path: "/code/api", name: "api" };

async function render(onOpenChat: (folder: ChatFolder, typed: string) => Promise<boolean>) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge()}>
        <NoProjectChat
          agent={{ provider: "claude-code", name: "Claude Code" }}
          onPickFolder={async () => folder}
          onOpenChat={onOpenChat}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickFolder(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Choose a project"]')?.click();
  });
  const browse = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.querySelector(".picker-option-label")?.textContent === "Open a folder…",
  );
  await act(async () => {
    browse?.click();
  });
}

describe("NoProjectChat", () => {
  it("opens the full chat as soon as a folder is picked, carrying what was typed", async () => {
    const opened: [ChatFolder, string][] = [];
    const container = await render(async (picked, typed) => {
      opened.push([picked, typed]);
      return true;
    });
    type(container, "Fix the login bug");
    await pickFolder(container);
    expect(opened).toEqual([[folder, "Fix the login bug"]]);
  });

  it("tries again from the send button when the chat could not open", async () => {
    let attempts = 0;
    const container = await render(async () => {
      attempts += 1;
      return attempts > 1;
    });
    await pickFolder(container);
    expect(attempts).toBe(1);
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Open the chat"]');
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
    });
    expect(attempts).toBe(2);
  });
});

describe("seedComposerDraft", () => {
  it("puts the text in the message box of the chat that opens with that key", async () => {
    seedComposerDraft("session-1", "Fix the login bug");
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge()}>
          <Composer
            displayName="Claude Code"
            provider="claude-code"
            branch="main"
            disabled={false}
            models={undefined}
            model={undefined}
            modelLocked={false}
            onModelChange={() => undefined}
            permissionMode="supervised"
            projectId={undefined}
            onSubmit={async () => true}
            draftKey="session-1"
          />
        </RuntimeProvider>,
      );
    });
    expect(container.querySelector("textarea")?.value).toBe("Fix the login bug");
    expect(container.querySelector('[aria-label="Attach files"]')).not.toBeNull();
  });
});
