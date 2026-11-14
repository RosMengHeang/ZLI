// @vitest-environment jsdom

import type { ThreadActivityTodo } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanCard } from "./ChatExtras.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());

const todos = [
  { text: "Read the routes", status: "completed" },
  { text: "Add the handler", status: "pending" },
] as ThreadActivityTodo[];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

describe("PlanCard", () => {
  it("shows the steps and, while the plan waits, its go-ahead in the same card", async () => {
    const onApprove = vi.fn();
    const onChange = vi.fn();
    const container = await render(
      <PlanCard
        todos={todos}
        working={false}
        approval={{ canSwitch: true, onApprove, onChange }}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(container.textContent).toContain("Add the handler");
    expect(button(container, "Hide the plan")).toBeUndefined();
    await act(async () => button(container, "Approve plan")?.click());
    await act(async () => button(container, "Change plan")?.click());
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("is only the go-ahead when the plan has no steps of its own", async () => {
    const container = await render(
      <PlanCard
        todos={[]}
        working={false}
        approval={{ canSwitch: false, onApprove: vi.fn(), onChange: vi.fn() }}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector(".plan-card.is-approval")).not.toBeNull();
    expect(button(container, "Approve plan")).toBeDefined();
    expect(container.querySelector(".plan-card-list")).toBeNull();
  });

  it("can be hidden once the turn is over and nothing waits", async () => {
    const onDismiss = vi.fn();
    const container = await render(<PlanCard todos={todos} working={false} onDismiss={onDismiss} />);
    expect(button(container, "Approve plan")).toBeUndefined();
    await act(async () => button(container, "Hide the plan")?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
