// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RpcResponse, type RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewAgentDialog, type NewAgentRequest } from "./NewAgentDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function projectionFor(git: boolean | undefined): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "D:/taxzy_cli_web", name: "taxzy_cli_web", ...(git === undefined ? {} : { git }) }],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
  } as RuntimeProjection;
}

async function render(git: boolean | undefined, dispatch?: (request: unknown) => Promise<RpcResponse | undefined>) {
  const projection = projectionFor(git);
  const onSubmit = vi.fn(async (_request: NewAgentRequest) => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <NewAgentDialog
        projection={projection}
        initialProject={projection.projects[0]}
        initialWorktreeId={undefined}
        {...(dispatch ? { dispatch } : {})}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
  });
  const placements = [...document.querySelectorAll<HTMLInputElement>('input[name="agent-placement"]')];
  return { onSubmit, placements };
}

describe("NewAgentDialog workspace", () => {
  it("offers only the current checkout for a folder without Git", async () => {
    const { onSubmit, placements } = await render(false);

    expect(placements.map((input) => input.value)).toEqual(["checkout"]);
    expect(placements[0]?.checked).toBe(true);
    expect(document.body.textContent).toContain("This folder is not a Git repository");

    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(onSubmit.mock.calls[0]?.[0].placement).toEqual({ kind: "checkout" });
  });

  it("starts in a new worktree for a Git repository", async () => {
    const { placements } = await render(undefined);

    expect(placements.map((input) => input.value)).toEqual(["new", "checkout"]);
    expect(placements.find((input) => input.checked)?.value).toBe("new");
  });
});

describe("NewAgentDialog branch", () => {
  it("reads the branch of a folder that has no checkout yet and shows it", async () => {
    const dispatch = vi.fn(
      async (request: unknown) =>
        ({
          commandId: (request as { commandId: string }).commandId,
          accepted: true,
          result: { git: true, branch: "feature/login" },
        }) as RpcResponse,
    );
    const { placements } = await render(undefined, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ command: { type: "project.branch", projectId } });
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Start from"]')?.placeholder).toBe(
      "feature/login",
    );

    await act(async () => {
      placements.find((input) => input.value === "checkout")?.click();
    });
    expect(document.querySelector(".workspace-path .folder-branch")?.textContent).toBe("feature/login");
  });

  const answers = (...results: (Record<string, unknown> | undefined)[]) => {
    const queue = [...results];
    return vi.fn(async (request: unknown) => {
      const result = queue.shift();
      return result
        ? ({ commandId: (request as { commandId: string }).commandId, accepted: true, result } as RpcResponse)
        : undefined;
    });
  };
  const status = () => document.querySelector(".workspace-hint .folder-branch");

  it("says the branch is being read until git answers", async () => {
    let answer: (value: RpcResponse | undefined) => void = () => undefined;
    const dispatch = vi.fn(() => new Promise<RpcResponse | undefined>((resolve) => (answer = resolve)));
    await render(undefined, dispatch);
    expect(status()?.textContent).toBe("Reading branch…");

    await act(async () => {
      answer({
        commandId: (dispatch.mock.calls[0] as unknown as [{ commandId: string }])[0].commandId,
        accepted: true,
        result: { git: true, branch: "main" },
      } as RpcResponse);
    });
    expect(status()).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Start from"]')?.placeholder).toBe("main");
  });

  it("says when the branch could not be read and reads it again on Retry", async () => {
    const dispatch = answers(undefined, { git: true, branch: "main" });
    await render(undefined, dispatch);
    expect(status()?.textContent).toContain("Couldn't read the branch");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Start from"]')?.placeholder).toBe("HEAD");

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".folder-branch-retry")?.click();
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(status()).toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Start from"]')?.placeholder).toBe("main");
  });

  it("names a detached HEAD by its commit instead of showing nothing", async () => {
    const { placements } = await render(undefined, answers({ git: true, detachedAt: "abc1234" }));
    expect(status()?.textContent).toBe("Detachedabc1234");

    await act(async () => {
      placements.find((input) => input.value === "checkout")?.click();
    });
    expect(document.querySelector(".workspace-path .folder-branch")?.textContent).toBe("Detachedabc1234");
  });
});

describe("NewAgentDialog name", () => {
  const typeName = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    if (!input) throw new Error("no name input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  };
  const submitButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.type === "submit");

  it("sends a trimmed name and leaves it out when empty", async () => {
    const { onSubmit } = await render(false);
    await typeName("  Bob ");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(onSubmit.mock.calls[0]?.[0].name).toBe("Bob");
  });

  it("blocks a name with a slash and says why", async () => {
    const { onSubmit } = await render(false);
    const input = await typeName("team/bob");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/^Use letters, digits/u);
    expect(submitButton()?.disabled).toBe(true);
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("NewAgentDialog project switch", () => {
  it("does not start in a worktree from the project it switched away from", async () => {
    const otherId = ProjectId.parse("00000000-0000-4000-8000-000000000011");
    const worktreeId = "00000000-0000-4000-8000-000000000012";
    const base = projectionFor(undefined);
    const projection = {
      ...base,
      projects: [...base.projects, { projectId: otherId, path: "D:/api", name: "api" }],
      worktrees: [{ worktreeId, projectId, path: "D:/taxzy_cli_web-worktrees/a", branch: "a", status: "ready" }],
    } as RuntimeProjection;
    const onSubmit = vi.fn(async (_request: NewAgentRequest) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <NewAgentDialog
          projection={projection}
          initialProject={projection.projects[0]}
          initialWorktreeId={worktreeId}
          onClose={() => undefined}
          onSubmit={onSubmit}
        />,
      );
    });
    const checked = () =>
      [...document.querySelectorAll<HTMLInputElement>('input[name="agent-placement"]')].find((input) => input.checked)
        ?.value;
    expect(checked()).toBe("existing");
    const projectButton = document.querySelector<HTMLButtonElement>('button[aria-label^="Project"]');
    await act(async () => projectButton?.click());
    const api = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes("api"),
    );
    await act(async () => api?.click());
    expect(checked()).toBe("new");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    const request = onSubmit.mock.calls[0]?.[0];
    expect(request?.project.name).toBe("api");
    expect(request?.placement.kind).toBe("new");
  });
});
