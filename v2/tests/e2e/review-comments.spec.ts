import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  openCreateWorktree,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("comments on diff lines and sends them to a chat agent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("comments");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /comments/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeEnabled({ timeout: 20_000 });

    const worktreePath = join(`${repo}-worktrees`, "comments");
    await writeFile(
      join(worktreePath, "README.md"),
      "# ZLI integration fixture\n\nSetup steps go here.\nRun the tests before merging.\n",
      "utf8",
    );
    const changesToggle = page.getByRole("button", { name: "Changes", exact: true });
    await changesToggle.click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await page.locator(".review-file", { hasText: "README.md" }).click();
    const lines = page.getByRole("listbox", { name: "Lines of README.md" });
    await expect(lines).toBeVisible();

    await lines.getByRole("option", { name: /Setup steps go here/u }).click();
    await page.keyboard.press("Shift+ArrowDown");
    await expect(lines.getByRole("option", { selected: true })).toHaveCount(2);
    await page.keyboard.press("c");
    const comment = page.getByRole("textbox", { name: "Comment on README.md:3-4" });
    await expect(comment).toBeFocused();
    await comment.fill("Turn these into a numbered list.");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(comment).toHaveCount(0);

    const list = page.getByRole("region", { name: "Review comments" });
    await expect(list).toContainText("1 comment");
    await expect(list).toContainText("README.md:3-4");
    await expect(list).toContainText("Turn these into a numbered list.");

    await changesToggle.click();
    await expect(list).toHaveCount(0);
    await changesToggle.click();
    await expect(list).toContainText("Turn these into a numbered list.");

    await list.getByRole("button", { name: "Send to agent" }).click();
    const send = page.getByRole("dialog", { name: "Send comments" });
    await expect(send.getByRole("radio", { checked: true })).toHaveCount(1);
    await expect(send.locator(".choice-detail")).toHaveText(/Codex chat/u);
    await expect(send.getByLabel("Message preview")).toContainText("README.md:3-4");
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toHaveCount(0);

    await expect(
      page.getByText(/Mock response: Please address this review comment on the changes in comments/u),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/Turn these into a numbered list\./u).first()).toBeVisible();
    await expect(list).toHaveCount(0);
    await expect(composer).toBeFocused();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});

test("collects notes from a turn's diff and the Files editor and sends them together", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await sendChatMessage(page, "[write notes.txt] add release notes");
    await expect(page.getByText("Mock response: [write notes.txt] add release notes")).toBeVisible({ timeout: 30_000 });

    const changes = page.getByRole("region", { name: "Changes in this turn" });
    await expect(changes).toContainText("1 file changed", { timeout: 20_000 });
    await changes.getByRole("button", { name: /notes\.txt/u }).click();
    const turnLines = changes.getByRole("listbox", { name: "Lines of notes.txt" });
    await turnLines.getByRole("option", { name: /Written by the mock agent/u }).click();
    await page.keyboard.press("c");
    const turnComment = page.getByRole("textbox", { name: "Comment on notes.txt:1" });
    await expect(turnComment).toBeFocused();
    await turnComment.fill("Say which version this is for.");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(turnComment).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^1 review note not sent/u })).toBeVisible();

    await page.evaluate(() => window.localStorage.removeItem("zli.files.viewModes.v1"));
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Files panel" });
    await panel.locator(".file-row", { hasText: "README.md" }).first().click();
    await panel.getByRole("tab", { name: "Code", exact: true }).click();
    const editor = panel.locator(".cm-content");
    await editor.getByText("ZLI integration fixture").click();
    await panel.getByRole("button", { name: "Add review note" }).click();
    const note = panel.getByRole("textbox", { name: "Note on README.md:1" });
    await expect(note).toBeFocused();
    await note.fill("Use a shorter title.");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(note).toHaveCount(0);

    await page.getByRole("button", { name: /^2 review notes not sent/u }).click();
    const send = page.getByRole("dialog", { name: "Send comments" });
    const preview = send.getByLabel("Message preview");
    await expect(preview).toContainText("notes.txt:1");
    await expect(preview).toContainText("README.md:1");
    await expect(preview).toContainText("Use a shorter title.");
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toHaveCount(0);
    await expect(page.getByText(/Mock response: Please address these review comments on the changes/u)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /review notes? not sent/u })).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
