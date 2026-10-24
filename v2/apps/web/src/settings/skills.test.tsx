// @vitest-environment jsdom

import { CommandId, type SkillListResult } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { SkillsSection } from "./SkillsSection.js";
import { agentNames, formatBytes, foundLabel, projectSkillGaps, skillFromDraft, skillSyncProblems } from "./skills.js";

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
        { path: "/h/.claude/skills", agents: ["claude-code"], status: "unchanged", conflicts: ["review"] },
        { path: "/h/.agents/skills", agents: ["codex"], status: "failed", conflicts: [], message: "EACCES" },
      ]),
    ).toEqual([
      "/h/.claude/skills already has your own review, so ZLI left it alone.",
      "/h/.agents/skills could not be updated (EACCES).",
    ]);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
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
    expect(container.textContent).toContain("Found in Claude Code");
    expect(container.textContent).toContain("ZLI copies your enabled skills into ~/.agents/skills");

    await act(async () => button(container, "New skill").click());
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
    expect(container.textContent).toContain("code-review");
    expect(container.textContent).toContain("User");

    await act(async () => container.querySelector<HTMLInputElement>('input[role="switch"]')?.click());
    expect(commands.at(-1)).toEqual({ type: "skills.setEnabled", name: "code-review", enabled: false });

    await act(async () => button(container, "Delete code-review").click());
    await act(async () => button(container, "Delete").click());
    expect(commands.at(-1)).toEqual({ type: "skills.delete", scope: { kind: "user" }, name: "code-review" });
    expect(container.textContent).toContain("No skills yet.");
  });
});
