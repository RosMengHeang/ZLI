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
const GITLAB_ISSUE = {
  ...GITHUB_ISSUE,
  source: "gitlab",
  key: "12",
  reference: "#12",
  url: "https://gitlab.com/a/b/-/issues/12",
};
const ISSUES = { github: GITHUB_ISSUE, gitlab: GITLAB_ISSUE, linear: LINEAR_ISSUE } as const;
const ELSEWHERE = { sources: [], unavailable: { code: "other_host", host: "bitbucket.org" } };

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

async function render(options: { linear?: boolean; sources?: unknown; github?: unknown } = {}) {
  const commands: Record<string, unknown>[] = [];
  const answer = (command: Record<string, unknown>): unknown => {
    const source = command.source as keyof typeof ISSUES;
    if (command.type === "issues.linear.status") {
      return options.linear ? { connected: true, viewer: { name: "Ada" } } : { connected: false };
    }
    if (command.type === "issues.sources") return options.sources ?? { sources: ["github"] };
    if (command.type === "issues.list") {
      return source === "github" && options.github ? options.github : { issues: [ISSUES[source]] };
    }
    return { issue: { ...ISSUES[source], body: "", comments: [] } };
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
  const onStart = vi.fn();
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
          onStart={onStart}
          onStartWithoutIssue={onStartWithoutIssue}
          onConnectLinear={onConnectLinear}
        />
      </RuntimeProvider>,
    );
  });
  await settle();
  const lists = () => commands.filter((command) => command.type === "issues.list").map((command) => command.source);
  return { lists, onStart, onStartWithoutIssue, onConnectLinear };
}

const buttons = (text: string) => [...document.querySelectorAll("button")].filter((item) => item.textContent === text);
const sourceSwitch = () =>
  [...document.querySelectorAll('[aria-label="Source"] button')].map((button) => button.textContent);

describe("IssuesDialog", () => {
  it("lists GitHub issues for a GitHub project", async () => {
    const { lists } = await render();
    expect(document.querySelector('[aria-label="GitHub issues"]')?.textContent).toContain("#42");
    expect(lists()).toEqual(["github"]);
    expect(sourceSwitch()).toEqual([]);
  });

  it("lists GitLab issues for a GitLab project and starts from one", async () => {
    const { lists, onStart } = await render({ sources: { sources: ["gitlab"] } });
    expect(document.querySelector('[aria-label="GitLab issues"]')?.textContent).toContain("#12");
    expect(lists()).toEqual(["gitlab"]);
    await act(async () => buttons("Start agent")[0]?.click());
    expect(onStart).toHaveBeenCalledWith(project, expect.objectContaining({ source: "gitlab", key: "12" }));
    expect(lastIssueSource(project.projectId)).toBe("gitlab");
  });

  it("offers every source that applies", async () => {
    const { lists } = await render({ linear: true, sources: { sources: ["gitlab", "github"] } });
    expect(sourceSwitch()).toEqual(["GitLab", "GitHub", "Linear"]);
    await act(async () => buttons("GitHub")[0]?.click());
    await settle();
    expect(lists()).toEqual(["gitlab", "github"]);
    expect(lastIssueSource(project.projectId)).toBe("github");
  });

  it("explains a project on another host calmly and offers the next steps", async () => {
    const { lists, onStartWithoutIssue, onConnectLinear } = await render({ sources: ELSEWHERE });
    const state = document.querySelector(".empty-state");
    expect(state?.textContent).toContain("This project's remote is on bitbucket.org.");
    expect(state?.textContent).toContain("ZLI can read issues from GitHub, GitLab, and Linear today.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(buttons("Try again")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('[aria-label="Issue details"]')?.hidden).toBe(true);
    expect(lists()).toEqual([]);

    await act(async () => state?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onConnectLinear).toHaveBeenCalled();
    await act(async () => buttons("Start without an issue")[0]?.click());
    expect(onStartWithoutIssue).toHaveBeenCalledWith(project);
  });

  it("says when a project has no remote", async () => {
    await render({ sources: { sources: [], unavailable: { code: "no_remote" } } });
    expect(document.querySelector(".empty-state-title")?.textContent).toBe("This project has no Git remote.");
  });

  it("shows the calm state when gh finds no GitHub repository", async () => {
    await render({ linear: true, github: { issues: [], unavailable: { code: "other_host" } } });
    expect(document.querySelector(".empty-state-title")?.textContent).toBe(
      "This project's remotes are not on GitHub or GitLab.",
    );
    await act(async () => buttons("Show Linear issues")[0]?.click());
    await settle();
    expect(document.querySelector('[aria-label="Linear issues"]')).not.toBeNull();
    expect(lastIssueSource(project.projectId)).toBe("linear");
  });

  it("opens on Linear when no remote is on GitHub or GitLab and Linear is connected", async () => {
    const { lists } = await render({ linear: true, sources: ELSEWHERE });
    expect(document.querySelector('[aria-label="Linear issues"]')?.textContent).toContain("ENG-1");
    expect(lists()).toEqual(["linear"]);
    expect(sourceSwitch()).toEqual([]);
    expect(lastIssueSource(project.projectId)).toBeUndefined();
  });

  it("starts on the source last used in the project", async () => {
    rememberIssueSource(project.projectId, "linear");
    const { lists } = await render({ linear: true });
    expect(lists()).toEqual(["linear"]);
  });

  it("falls back to the remote's forge when the remembered source no longer applies", async () => {
    rememberIssueSource(project.projectId, "linear");
    expect((await render()).lists()).toEqual(["github"]);
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    rememberIssueSource(project.projectId, "github");
    expect((await render({ sources: { sources: ["gitlab"] } })).lists()).toEqual(["gitlab"]);
  });

  it("reads GitHub when the runtime cannot say where the remote is", async () => {
    const { lists } = await render({ sources: "not a result" });
    expect(lists()).toEqual(["github"]);
  });
});
