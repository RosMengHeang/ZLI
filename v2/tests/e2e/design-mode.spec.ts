import { createServer, type Server } from "node:http";

import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  openCreateWorktree,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
} from "./desktop-fixtures.js";

const PAGE = [
  "<!doctype html><title>Design fixture</title>",
  '<main style="padding: 24px">',
  "<h1>Checkout</h1>",
  '<button id="pay" style="padding: 8px 16px" onclick="document.title = \'clicked\'">Pay now</button>',
  "</main>",
].join("");

test("picks an element in the browser panel and sends it to a chat agent", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  try {
    const port = await listen(server);
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await openCreateWorktree(page);
    const createWorktree = page.getByRole("dialog", { name: "Create worktree" });
    await createWorktree.getByLabel("Branch").fill("design");
    await createWorktree.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /design/iu }).first();
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();

    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await newAgent.getByText("Chat", { exact: true }).click();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    await expect(page.getByRole("textbox", { name: "Message Codex" })).toBeEnabled({ timeout: 20_000 });

    const browserToggle = page.getByRole("button", { name: "Browser", exact: true });
    if (!(await page.getByRole("complementary", { name: "Browser panel" }).isVisible())) await browserToggle.click();
    await page.getByRole("textbox", { name: "Browser URL" }).fill(`http://127.0.0.1:${port}`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Design fixture" })).toBeVisible({ timeout: 20_000 });
    const browserTabId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.browserTabs.at(-1)?.browserTabId;
    });
    if (!browserTabId) throw new Error("The browser tab was not projected to the renderer.");

    const pick = page.getByRole("button", { name: "Pick element" });
    await pick.click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Esc cancels" })).toBeVisible();
    // A trusted click in the page, the same input a person's mouse produces.
    await page.evaluate(
      async (tabId) => window.zli?.browser.click({ browserTabId: tabId, selector: "#pay" }),
      browserTabId,
    );

    const panel = page.getByRole("region", { name: "Picked elements" });
    await expect(panel).toContainText("1 element picked", { timeout: 15_000 });
    await expect(panel).toContainText('<button> "Pay now"');
    await expect(panel).toContainText("#pay");
    await expect(panel.getByRole("img", { name: /Screenshot of/u })).toBeVisible();
    await expect(pick).toHaveAttribute("aria-pressed", "false");
    // The pick swallowed the click, so the page's own handler never ran.
    const title = await page.evaluate(
      async (tabId) => (await window.zli?.browser.snapshot(tabId)) as { title?: string } | undefined,
      browserTabId,
    );
    expect(title?.title).toBe("Design fixture");

    // Escape ends a pick without adding anything.
    await panel.getByRole("button", { name: "Pick another" }).click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(pick).toHaveAttribute("aria-pressed", "false");
    await expect(panel).toContainText("1 element picked");

    await panel.getByRole("textbox", { name: "What should change?" }).fill("Make the pay button green.");
    await panel.getByRole("button", { name: "Send to agent" }).click();
    const send = page.getByRole("dialog", { name: "Send picked elements" });
    await expect(send.locator(".choice-detail")).toHaveText(/Codex chat/u);
    const preview = send.getByLabel("Message preview");
    await expect(preview).toContainText("Make the pay button green.");
    await expect(preview).toContainText("Selector: `#pay`");
    await expect(preview).toContainText(`http://127.0.0.1:${port}/`);
    await expect(preview).toContainText('<button id="pay"');
    await expect(send).toContainText("with 1 image");
    await send.getByRole("button", { name: "Send", exact: true }).click();
    await expect(send).toHaveCount(0);

    await expect(page.getByText(/Mock response: Please change this element in the page/u)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".chat-attachments")).toContainText("element-1.png");
    await expect(panel).toHaveCount(0);
  } finally {
    if (fixture) await closeDesktop(fixture);
    server.close();
  }
});

async function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The page server did not bind."));
        return;
      }
      resolvePort(address.port);
    });
  });
}
