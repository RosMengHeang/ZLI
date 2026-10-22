import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, type DesktopFixture, launchDesktop } from "./desktop-fixtures.js";

test("folds file reads, previews HTML replies, attaches long pastes, and finds text in a diff", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByLabel("First message").fill("[reads] [html] look around");
    await newAgent.getByRole("button", { name: "Start agent" }).click();

    const workLog = page.getByRole("region", { name: "Work log" });
    await expect(workLog).toContainText("Ran 1 command, read 3 files", { timeout: 30_000 });
    await workLog.locator(".work-log-header").click();
    const reads = workLog.getByRole("button", { name: /Read 3 files/u });
    await expect(reads).toHaveAttribute("aria-expanded", "false");
    await reads.click();
    await expect(workLog.getByText("Read src/routes.ts")).toBeVisible();

    const preview = page.frameLocator('iframe[title="HTML preview"]');
    await expect(preview.getByRole("heading", { name: "Mock card" })).toBeVisible();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator(".md-code").last()).toContainText("<h1");

    const composer = page.getByRole("textbox", { name: "Message Codex" });
    const log = Array.from({ length: 60 }, (_, index) => `12:00:${String(index).padStart(2, "0")} request ok`).join(
      "\n",
    );
    await composer.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, log);
    const attachments = page.getByRole("list", { name: "Attachments" });
    await expect(attachments).toContainText("Pasted text");
    await expect(attachments).toContainText("60 lines");
    await expect(composer).toHaveValue("");
    await composer.fill("Summarize this log");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText(/Mock response: Summarize this log/u)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Attached text the person pasted/u)).toBeVisible();
    await expect(page.locator(".chat-attachments")).toContainText("pasted-text-1.txt");

    const worktreePath = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      const thread = projection?.threads[0];
      return projection?.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path ?? "";
    });
    expect(worktreePath).not.toBe("");
    await writeFile(
      join(worktreePath, "README.md"),
      "# ZLI integration fixture\n\nRun the tests.\nRun the linter.\n",
      "utf8",
    );
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await page.locator(".review-file", { hasText: "README.md" }).click();
    const lines = page.getByRole("listbox", { name: "Lines of README.md" });
    await lines.getByRole("option", { name: /Run the tests/u }).click();
    await page.keyboard.press(`${mod}+F`);
    const find = page.getByRole("searchbox", { name: "Find in diff" });
    await expect(find).toBeFocused();
    await find.fill("run the");
    const count = page.locator(".diff-find-count");
    await expect(count).toHaveText("1 of 2");
    await expect(lines.locator(".diff-find-hit")).toHaveCount(2);
    await find.press("Enter");
    await expect(count).toHaveText("2 of 2");
    await expect(lines.locator(".is-find-current")).toContainText("Run the linter.");
    await find.fill("nothing like this");
    await expect(count).toHaveText("No matches");
    await find.press("Escape");
    await expect(find).toHaveCount(0);
    await expect(lines.locator(".diff-find-hit")).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
