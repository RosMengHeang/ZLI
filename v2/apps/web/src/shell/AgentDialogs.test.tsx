// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RenameAgentDialog } from "./AgentDialogs.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function render(current: string | undefined, onRename: (name: string | null) => Promise<string | undefined>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RenameAgentDialog
        current={current}
        agent="Fix the login bug · Codex"
        problem={(name) => (name.includes("/") ? "No slashes." : undefined)}
        onRename={onRename}
        onCancel={() => undefined}
      />,
    );
  });
  const input = document.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("no input");
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.type === "submit");
  return { input, type, submit };
}

describe("RenameAgentDialog", () => {
  it("starts on the current name and only saves a change", async () => {
    const onRename = vi.fn(async () => undefined);
    const { input, type, submit } = await render("Bob", onRename);
    expect(input.value).toBe("Bob");
    expect(document.activeElement).toBe(input);
    expect(submit()?.disabled).toBe(true);
    await type(" Ann ");
    expect(submit()?.textContent).toContain("Save name");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(onRename).toHaveBeenCalledWith("Ann");
  });

  it("removes the name when the field is cleared", async () => {
    const onRename = vi.fn(async () => undefined);
    const { type, submit } = await render("Bob", onRename);
    await type("");
    expect(submit()?.textContent).toContain("Remove name");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(onRename).toHaveBeenCalledWith(null);
  });

  it("shows why a name was refused", async () => {
    const onRename = vi.fn(async () => "Another agent in this project is already called Ann.");
    const { type, submit } = await render(undefined, onRename);
    await type("a/b");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("No slashes.");
    expect(submit()?.disabled).toBe(true);
    await type("Ann");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Another agent in this project is already called Ann.",
    );
  });
});
