// @vitest-environment jsdom

import { CommandId, type SkillListResult } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { SkillsSection } from "./SkillsSection.js";
import {
  agentNames,
  formatBytes,
  foundLabel,
  projectSkillGaps,
  readersLabel,
  skillFromDraft,
  skillMatches,
  skillReaders,
  skillSyncProblems,
} from "./skills.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("skill helpers", () => {
  it("explains what blocks a save", () => {
    expect(skillFromDraft({ name: " Review ", description: "x", instructions: "" })).toEqual({
      problem: "Name: Names use lowercase letters, digits, and hyphens.",
    });
    expect(skillFromDraft({ name: "review", description: " ", instructions: "" })).toEqual({
      problem: "Description: Add a description so agents know when to use the skill.",
    });
    expect(skillFromDraft({ name: " review ", description: " Reviews. ", instructions: "Go." })).toEqual({
      skill: { name: "review", description: "Reviews.", instructions: "Go." },
    });
  });

  it("names the agents behind each folder and the folders ZLI could not change", () => {
    expect(foundLabel({ agents: ["claude-code"], dir: ".claude/skills" })).toBe("Found in Claude Code");
    expect(foundLabel({ agents: ["claude-code", "cursor-agent", "goose"], dir: ".claude/skills" })).toBe(
      "Found in Claude Code +2",
    );
    expect(agentNames(["codex", "droid", "goose"])).toBe("Codex, Droid, and Goose");
    expect(projectSkillGaps()).toEqual([{ agent: "claude-code", dirs: [".claude/skills"] }]);
    expect(
      skillSyncProblems([
        { path: "/w/.claude/skills", agents: ["claude-code"], status: "unchanged", conflicts: ["review"] },
        { path: "/w/.agents/skills", agents: ["codex"], status: "failed", conflicts: [], message: "EACCES" },
      ]),
    ).toEqual([
      "/w/.claude/skills already has a skill named review, so ZLI did not copy yours there.",
      "/w/.agents/skills could not be updated (EACCES).",
    ]);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("says which agents a skill reaches and matches searches word by word", () => {
    expect(readersLabel(skillReaders("user"))).toBe("All agents");
    expect(skillReaders("project")).not.toContain("claude-code");
    expect(readersLabel(skillReaders("project"))).toBe(`${skillReaders("project").length} agents`);
    expect(readersLabel(["codex"])).toBe("1 agent");
    const skill = { name: "commit-message", description: "Writes commit messages." };
    expect(skillMatches(skill, "  COMMIT  writes ")).toBe(true);
    expect(skillMatches(skill, "commit deploy")).toBe(false);
    expect(skillMatches(skill, "")).toBe(true);
  });
});

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

describe("SkillsSection", () => {
  it("creates, turns off, and deletes a skill through the runtime", async () => {
    const commands: Array<Record<string, unknown>> = [];
    let result: SkillListResult = {
      skills: [],
      found: [
        {
          name: "deploy",
          description: "Ship it.",
          scope: "user",
          path: "/h/.claude/skills/deploy",
          dir: ".claude/skills",
          agents: ["claude-code"],
        },
      ],
      libraryPath: "/data/skills",
      sync: { enabled: true, outcomes: [] },
    };
    const bridge = {
      runtime: {
        dispatch: async (request: { commandId: string; command: Record<string, unknown> }) => {
          commands.push(request.command);
          const command = request.command as {
            type: string;
            skill?: { name: string; description: string };
            enabled?: boolean;
          };
          if (command.type === "skills.save" && command.skill) {
            result = {
              ...result,
              skills: [
                {
                  name: command.skill.name,
                  description: command.skill.description,
                  scope: "user",
                  enabled: true,
                  path: `/data/skills/${command.skill.name}`,
                },
              ],
            };
          }
          if (command.type === "skills.setEnabled") {
            result = {
              ...result,
              skills: result.skills.map((skill) => ({ ...skill, enabled: command.enabled ?? true })),
            };
          }
          if (command.type === "skills.delete") result = { ...result, skills: [] };
          return { commandId: CommandId.parse(request.commandId), accepted: true as const, result };
        },
        getProjection: async () => undefined,
        onProjection: () => () => undefined,
      },
    } as unknown as ZliBridge;
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridge}>
          <SkillsSection projection={undefined} />
        </RuntimeProvider>,
      );
    });
    expect(container.textContent).toContain("No skills yet.");
    expect(container.textContent).toContain("ZLI copies the ones that are on");
    expect(container.querySelector('input[aria-label="Search skills"]')).toBeNull();

    // Skills in agents' own folders have a tab of their own.
    const foundTab = button(container, "On this computer1");
    expect(foundTab.getAttribute("aria-selected")).toBe("false");
    expect(container.textContent).not.toContain("Found in Claude Code");
    await act(async () => foundTab.click());
    expect(container.textContent).toContain("Found in Claude Code");
    await act(async () => button(container, "Yours0").click());

    await act(async () => button(container, "Write a skill").click());
    const form = container.querySelector('form[aria-label="New skill"]') as HTMLFormElement;
    const name = form.querySelector("input") as HTMLInputElement;
    const [description, instructions] = [...form.querySelectorAll("textarea")] as HTMLTextAreaElement[];
    await act(async () => {
      setValue(name, "Code Review");
      setValue(description as HTMLTextAreaElement, "Review a diff.");
      setValue(instructions as HTMLTextAreaElement, "Read it.");
    });
    expect(name.value).toBe("code-review");
    await act(async () => form.requestSubmit());
    expect(commands.at(-1)).toEqual({
      type: "skills.save",
      scope: { kind: "user" },
      skill: { name: "code-review", description: "Review a diff.", instructions: "Read it." },
    });
    expect(container.querySelector("form")).toBeNull();
    const card = container.querySelector(".skill-card:not(.is-found)") as HTMLElement;
    expect(card.querySelector(".skill-card-name")?.textContent).toBe("code-review");
    expect(card.textContent).toContain("Yours");
    expect(card.textContent).toContain("All agents");
    expect(container.textContent).not.toContain("No skills yet.");

    await act(async () => card.querySelector<HTMLInputElement>('input[role="switch"]')?.click());
    expect(commands.at(-1)).toEqual({ type: "skills.setEnabled", name: "code-review", enabled: false });
    expect(container.querySelector(".skill-card.is-off")?.textContent).toContain("Off");

    await act(async () => button(container, "Delete code-review").click());
    expect(container.textContent).toContain("Delete code-review?");
    await act(async () => button(container, "Delete").click());
    expect(commands.at(-1)).toEqual({ type: "skills.delete", scope: { kind: "user" }, name: "code-review" });
    expect(container.textContent).toContain("No skills yet.");
  });

  it("teaches with an example skill and a source to install from when there are none", async () => {
    const { container } = await renderSection(listResult([]));
    const empty = container.querySelector(".skill-empty") as HTMLElement;
    expect(empty.textContent).toContain("commit-message");

    await act(async () => button(container, "Start from this example").click());
    const form = container.querySelector('form[aria-label="New skill"]') as HTMLFormElement;
    expect((form.querySelector("input") as HTMLInputElement).value).toBe("commit-message");
    expect(form.querySelector("textarea")?.value).toContain("Use when committing");
    expect(container.querySelector(".skill-empty")).toBeNull();

    await act(async () => button(container, "Cancel").click());
    await act(async () => button(container, "Browse anthropics/skills").click());
    const install = container.querySelector('form[aria-label="Install from GitHub"]') as HTMLFormElement;
    expect((install.querySelector("input") as HTMLInputElement).value).toBe("https://github.com/anthropics/skills");
  });

  it("filters skills by name and description once there are more than six", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const skills = [
      ...names.map((name) => summary(name, `Helps with ${name}.`)),
      summary("commit-message", "Writes commit messages. Use when committing."),
    ];
    const { container } = await renderSection(listResult(skills));
    const search = container.querySelector('input[aria-label="Search skills"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    expect(container.querySelectorAll(".skill-card")).toHaveLength(7);

    await act(async () => setValue(search, "commit"));
    const visible = [...container.querySelectorAll(".skill-card-name")].map((name) => name.textContent);
    expect(visible).toEqual(["commit-message"]);

    await act(async () => setValue(search, "helps foxtrot"));
    expect([...container.querySelectorAll(".skill-card-name")].map((name) => name.textContent)).toEqual(["foxtrot"]);

    await act(async () => setValue(search, "nothing-like-this"));
    expect(container.querySelectorAll(".skill-card")).toHaveLength(0);
    expect(container.textContent).toContain("Nothing matches “nothing-like-this”.");

    await act(async () => setValue(search, ""));
    expect(container.querySelectorAll(".skill-card")).toHaveLength(7);
    expect(button(container, "Write a skill")).toBeDefined();
  });
});

function summary(name: string, description: string): SkillListResult["skills"][number] {
  return { name, description, scope: "user", enabled: true, path: `/data/skills/${name}` };
}

function listResult(skills: SkillListResult["skills"]): SkillListResult {
  return { skills, found: [], libraryPath: "/data/skills", sync: { enabled: true, outcomes: [] } };
}

async function renderSection(result: SkillListResult) {
  const bridge = {
    runtime: {
      dispatch: async (request: { commandId: string }) => ({
        commandId: CommandId.parse(request.commandId),
        accepted: true as const,
        result,
      }),
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <SkillsSection projection={undefined} />
      </RuntimeProvider>,
    );
  });
  return { container };
}
