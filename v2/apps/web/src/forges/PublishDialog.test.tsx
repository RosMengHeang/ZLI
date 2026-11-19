// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime, worktree } from "../review/testRuntime.js";
import { PublishDialog, repositoryName } from "./PublishDialog.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

describe("PublishDialog", () => {
  it("names the repository after the folder", () => {
    expect(repositoryName("C:/code/My App")).toBe("My-App");
    expect(repositoryName("/home/o/shop-web/")).toBe("shop-web");
  });

  it("publishes privately to the picked forge and shows where it went", async () => {
    const onPublished = vi.fn();
    const commands = await renderWithRuntime(
      <PublishDialog worktree={worktree} onClose={() => undefined} onPublished={onPublished} />,
      () => ({ result: { url: "https://gitlab.com/octo/app" } }),
    );
    const gitlab = [...document.querySelectorAll<HTMLButtonElement>(".publish-forge")].find((button) =>
      button.textContent?.includes("GitLab"),
    );
    await act(async () => gitlab?.click());
    const publish = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Publish to GitLab",
    );
    await act(async () => publish?.click());
    expect(commands.at(-1)).toEqual({
      type: "project.publish",
      worktreeId: worktree.worktreeId,
      forge: "gitlab",
      name: "app",
      private: true,
    });
    expect(onPublished).toHaveBeenCalledWith("https://gitlab.com/octo/app");
    expect(document.body.textContent).toContain("https://gitlab.com/octo/app");
  });
});
