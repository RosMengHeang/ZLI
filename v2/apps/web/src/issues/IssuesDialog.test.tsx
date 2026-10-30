// @vitest-environment jsdom

import { CommandId, ProjectId, type ProjectProjection, type RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { IssuesDialog } from "./IssuesDialog.js";
import { lastIssueSource, rememberIssueSource } from "./issueStart.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const project = {
  projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
  name: "app",
  path: "/app",
} as unknown as ProjectProjection;
const projection = { projects: [project], worktrees: [], threads: [] } as unknown as RuntimeProjection;
const LINEAR_ISSUE = {
  source: "linear",
  key: "ENG-1",
  reference: "ENG-1",
  title: "Fix sign in",
  state: "open",
  url: "https://linear.app/acme/issue/ENG-1",
  labels: [],
  assignees: [],
};
const GITHUB_ISSUE = {
  ...LINEAR_ISSUE,
  source: "github",
  key: "42",
  reference: "#42",
  url: "https://github.com/a/b/issues/42",
};
const NOT_GITHUB = { issues: [], unavailable: { code: "not_github", host: "gitlab.company.com" } };

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
});

async function settle() {
  for (let index = 0; index < 5; index += 1) await act(async () => undefined);
}

async function render(options: { linear?: boolean; github?: unknown } = {}) {
  const commands: Record<string, unknown>[] = [];
  const answer = (command: Record<string, unknown>): unknown => {
    if (command.type === "issues.linear.status") {
      return options.linear ? { connected: true, viewer: { name: "Ada" } } : { connected: false };
    }
    if (command.type === "issues.list") {
      return command.source === "linear" ? { issues: [LINEAR_ISSUE] } : (options.github ?? { issues: [GITHUB_ISSUE] });
    }
    const issue = command.source === "linear" ? LINEAR_ISSUE : GITHUB_ISSUE;
    return { issue: { ...issue, body: "", comments: [] } };
  };
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: true,
          result: answer(request.command),
        };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const onStartWithoutIssue = vi.fn();
  const onConnectLinear = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <IssuesDialog
          projection={projection}
          initialProject={project}
          onClose={() => undefined}
          onStart={() => undefined}
          onStartWithoutIssue={onStartWithoutIssue}
          onConnectLinear={onConnectLinear}
        />
      </RuntimeProvider>,
    );
  });
  await settle();
  const lists = () => commands.filter((command) => command.type === "issues.list").map((command) => command.source);
  return { lists, onStartWithoutIssue, onConnectLinear };
}

const buttons = (text: string) => [...document.querySelectorAll("button")].filter((item) => item.textContent === text);

describe("IssuesDialog", () => {
  it("lists GitHub issues for a GitHub project", async () => {
    const { lists } = await render();
    expect(document.querySelector('[aria-label="GitHub issues"]')?.textContent).toContain("#42");
    expect(lists()).toEqual(["github"]);
  });

  it("explains a project on another host calmly and offers the next steps", async () => {
    const { onStartWithoutIssue, onConnectLinear } = await render({ github: NOT_GITHUB });
    const state = document.querySelector(".empty-state");
    expect(state?.textContent).toContain("This project's remote is on gitlab.company.com.");
    expect(state?.textContent).toContain("ZLI can read issues from GitHub and Linear today.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(buttons("Try again")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('[aria-label="Issue details"]')?.hidden).toBe(true);

    await act(async () => state?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onConnectLinear).toHaveBeenCalled();
    await act(async () => buttons("Start without an issue")[0]?.click());
    expect(onStartWithoutIssue).toHaveBeenCalledWith(project);
  });

  it("says when a project has no remote", async () => {
    await render({ github: { issues: [], unavailable: { code: "no_remote" } } });
    expect(document.querySelector(".empty-state-title")?.textContent).toBe("This project has no Git remote.");
  });

  it("opens on Linear when the project is not on GitHub and Linear is connected", async () => {
    const { lists } = await render({ linear: true, github: NOT_GITHUB });
    expect(document.querySelector('[aria-label="Linear issues"]')?.textContent).toContain("ENG-1");
    expect(lists()).toEqual(["github", "linear"]);
    expect(lastIssueSource(project.projectId)).toBeUndefined();

    await act(async () => buttons("GitHub")[0]?.click());
    await settle();
    expect(document.querySelector(".empty-state-title")?.textContent).toBe(
      "This project's remote is on gitlab.company.com.",
    );
    expect(lastIssueSource(project.projectId)).toBe("github");
    await act(async () => buttons("Show Linear issues")[0]?.click());
    await settle();
    expect(document.querySelector('[aria-label="Linear issues"]')).not.toBeNull();
    expect(lastIssueSource(project.projectId)).toBe("linear");
  });

  it("starts on the source last used in the project", async () => {
    rememberIssueSource(project.projectId, "linear");
    const { lists } = await render({ linear: true });
    expect(lists()).toEqual(["linear"]);
  });

  it("falls back to GitHub when the remembered Linear is not connected", async () => {
    rememberIssueSource(project.projectId, "linear");
    const { lists } = await render();
    expect(lists()).toEqual(["github"]);
    expect(document.querySelector('[aria-label="GitHub issues"]')).not.toBeNull();
  });
});
