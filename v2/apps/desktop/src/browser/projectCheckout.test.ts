import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createBrowserControlActions } from "./BrowserControlActions.js";
import { createProjectCheckout } from "./projectCheckout.js";

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const NESTED = "00000000-0000-4000-8000-0000000000a2";
const CHECKOUT = "00000000-0000-4000-8000-0000000000b1";

function state(worktrees: Record<string, unknown>[] = []): RuntimeProjection {
  return {
    projects: [
      { projectId: PROJECT, path: "/work/notes", name: "notes" },
      { projectId: NESTED, path: "/work/notes/site", name: "site" },
    ],
    worktrees,
  } as unknown as RuntimeProjection;
}

function setup(initial = state()) {
  const commands: Record<string, unknown>[] = [];
  let next = 0;
  let response: RpcResponse = { accepted: true } as RpcResponse;
  const checkoutFor = createProjectCheckout({
    projection: () => initial,
    command: async (request) => {
      commands.push(request.command);
      return response;
    },
    platform: "linux",
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  });
  return {
    checkoutFor,
    commands,
    reject: (message: string) => {
      response = { accepted: false, error: { code: "worktree_exists", message } } as unknown as RpcResponse;
    },
  };
}

describe("createProjectCheckout", () => {
  it("adds the checkout of the deepest project that contains cwd", async () => {
    const { checkoutFor, commands } = setup();
    const checkout = await checkoutFor("/work/notes/site/src");
    expect(checkout).toMatchObject({ path: "/work/notes/site", status: "ready" });
    expect(commands).toEqual([
      {
        type: "worktree.import",
        worktreeId: checkout?.worktreeId,
        projectId: NESTED,
        path: "/work/notes/site",
        branch: "HEAD",
        kind: "checkout",
      },
    ]);
  });

  it("reuses a ready checkout, imports once for concurrent calls, and ignores folders outside projects", async () => {
    const ready = setup(
      state([
        {
          worktreeId: CHECKOUT,
          projectId: PROJECT,
          path: "/work/notes",
          branch: "HEAD",
          status: "ready",
          kind: "checkout",
        },
      ]),
    );
    expect((await ready.checkoutFor("/work/notes/docs"))?.worktreeId).toBe(CHECKOUT);
    expect(ready.commands).toEqual([]);

    const fresh = setup();
    const [first, second] = await Promise.all([fresh.checkoutFor("/work/notes"), fresh.checkoutFor("/work/notes/a")]);
    expect(first?.worktreeId).toBe(second?.worktreeId);
    expect(fresh.commands).toHaveLength(1);

    expect(await fresh.checkoutFor("/work/notesbook")).toBeUndefined();
  });

  it("reports a checkout that failed, is still opening, or was refused", async () => {
    const failed = setup(
      state([
        {
          worktreeId: CHECKOUT,
          projectId: PROJECT,
          path: "/work/notes",
          branch: "HEAD",
          status: "failed",
          errorMessage: "Folder is missing.",
          kind: "checkout",
        },
      ]),
    );
    await expect(failed.checkoutFor("/work/notes")).rejects.toThrow("ZLI could not open notes. Folder is missing.");

    const opening = setup(
      state([
        {
          worktreeId: CHECKOUT,
          projectId: PROJECT,
          path: "/work/notes",
          branch: "HEAD",
          status: "queued",
          kind: "checkout",
        },
      ]),
    );
    await expect(opening.checkoutFor("/work/notes")).rejects.toThrow("still opening notes");

    const refused = setup();
    refused.reject("This project's checkout is already in the workspace.");
    await expect(refused.checkoutFor("/work/notes")).rejects.toMatchObject({ status: 409 });
  });
});

describe("browser open without a worktree", () => {
  it("opens the page in the project's checkout and reveals it there", async () => {
    const created: string[] = [];
    const reveals: unknown[] = [];
    const tab = {
      browserTabId: "00000000-0000-4000-8000-0000000000c1",
      profileId: "p",
      url: "about:blank",
      title: "",
      active: false,
      status: "idle" as const,
      worktreeId: "",
    };
    const manager = {
      list: () => (tab.worktreeId ? [tab] : []),
      create: async (input: { worktreeId: string }) => {
        tab.worktreeId = input.worktreeId;
        created.push(input.worktreeId);
        return tab;
      },
      navigate: async (input: { url: string }) => {
        tab.url = input.url;
        return tab;
      },
    };
    const dispatch = createBrowserControlActions({
      manager: () => manager as never,
      worktrees: () => [],
      reveal: (event) => reveals.push(event),
      checkoutFor: async () => ({ worktreeId: CHECKOUT, path: "/work/notes", status: "ready" }),
      platform: "linux",
    });
    await dispatch("open", { url: "localhost:3000", cwd: "/work/notes" });
    expect(created).toEqual([CHECKOUT]);
    expect(reveals).toEqual([{ browserTabId: tab.browserTabId, worktreeId: CHECKOUT }]);
    await expect(dispatch("open", { url: "localhost:3000", worktreeId: CHECKOUT })).rejects.toThrow(
      "no ready worktree",
    );
  });
});
