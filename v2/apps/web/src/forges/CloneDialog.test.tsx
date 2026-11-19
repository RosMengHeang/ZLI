// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { CloneDialog, folderName, isShortName } from "./CloneDialog.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
  localStorage.clear();
});

describe("CloneDialog helpers", () => {
  it("guesses the folder from what was pasted", () => {
    expect(folderName("https://github.com/acme/app/tree/main/src")).toBe("app");
    expect(folderName("git@gitlab.com:group/sub/app.git")).toBe("app");
    expect(folderName("https://gitlab.com/group/sub/app/-/tree/main")).toBe("app");
    expect(folderName("acme/app")).toBe("app");
  });

  it("knows owner/repo from a URL", () => {
    expect(isShortName("acme/app")).toBe(true);
    expect(isShortName("https://github.com/acme/app")).toBe(false);
    expect(isShortName("git@github.com:acme/app.git")).toBe(false);
  });
});

describe("CloneDialog", () => {
  it("asks for the forge for owner/repo, clones into the chosen folder, and hands back the path", async () => {
    const onCloned = vi.fn();
    const commands = await renderWithRuntime(
      <CloneDialog nearProject="C:/code/other" onClose={() => undefined} onCloned={onCloned} />,
      () => ({
        result: { path: "C:/code/app" },
      }),
    );
    const input = document.querySelector<HTMLInputElement>(".clone-source input");
    if (!input) throw new Error("No repository box");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "acme/app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Forge");
    const gitlab = [...document.querySelectorAll("button")].find((button) => button.textContent === "GitLab");
    await act(async () => gitlab?.click());
    expect(document.querySelector(".clone-path")?.textContent).toBe("C:/code/app");
    const clone = [...document.querySelectorAll("button")].find((button) => button.textContent === "Clone");
    await act(async () => clone?.click());
    expect(commands.at(-1)).toEqual({ type: "project.clone", source: "acme/app", parent: "C:/code", forge: "gitlab" });
    expect(onCloned).toHaveBeenCalledWith("C:/code/app");
  });
});
