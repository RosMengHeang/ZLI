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
  '<body style="margin: 0">',
  '<main style="padding: 24px">',
  '<h1 class="hero-title" style="margin: 0 0 12px">Checkout</h1>',
  '<button id="pay" style="padding: 8px 16px" onclick="document.title = \'clicked\'">Pay now</button>',
  '<section style="height: 600px"></section>',
  "</main>",
  "</body>",
].join("");

test("annotates elements and a region on the page and sends them to a chat agent in one message", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  try {
    const port = await listen(server);
    const pageUrl = `http://127.0.0.1:${port}/`;
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
    await page.getByRole("textbox", { name: "Browser URL" }).fill(pageUrl);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Design fixture" })).toBeVisible({ timeout: 20_000 });
    const browserTabId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.browserTabs.at(-1)?.browserTabId;
    });
    if (!browserTabId) throw new Error("The browser tab was not projected to the renderer.");
    // Trusted clicks in the page, the same input a person's mouse produces.
    const clickInPage = (selector: string) =>
      page.evaluate(async (input) => window.zli?.browser.click(input), { browserTabId, selector });
    type GuestInput =
      | { text: string }
      | { key: string }
      | { mouse: "mouseDown" | "mouseUp" | "mouseMove"; x: number; y: number };
    const inPage = (inputs: GuestInput[]) =>
      fixture?.app.evaluate(
        async ({ webContents }, { url, inputs }) => {
          const guest = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(url));
          if (!guest) throw new Error("The page's web contents were not found.");
          guest.focus();
          for (const input of inputs) {
            if ("text" in input) await guest.insertText(input.text);
            else if ("key" in input) {
              guest.sendInputEvent({ type: "keyDown", keyCode: input.key });
              guest.sendInputEvent({ type: "keyUp", keyCode: input.key });
            } else guest.sendInputEvent({ type: input.mouse, x: input.x, y: input.y, button: "left", clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
        { url: pageUrl, inputs },
      );
    // The note card opens next to the pick with its text box focused; Return saves it.
    const writeNote = (note: string) => inPage([{ text: note }, { key: "Enter" }]);

    const annotate = page.getByRole("button", { name: "Annotate", exact: true });
    await annotate.click();
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "Click or drag" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toHaveCount(0);

    // Exact, because the chat that receives the message is a region named after it.
    const panel = page.getByRole("region", { name: "Annotations", exact: true });
    await clickInPage("#pay");
    await expect(panel).toContainText("1 annotation", { timeout: 15_000 });
    await expect(panel).toContainText('<button> "Pay now"');
    await expect(panel.getByRole("img", { name: /Screenshot of annotation 1/u })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Return to save" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send 1 annotation" })).toBeDisabled();
    await writeNote("Make the pay button green.");
    await expect(panel).toContainText("Make the pay button green.");
    await expect(page.getByRole("button", { name: "Send 1 annotation" })).toBeEnabled();
    // Annotate stays on after a pick, and the page never saw the click.
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    await clickInPage("h1");
    await expect(panel).toContainText("2 annotations", { timeout: 15_000 });
    await writeNote("Bigger, tighter.");
    await expect(panel).toContainText("Bigger, tighter.");
    const title = await page.evaluate(
      async (tabId) => (await window.zli?.browser.snapshot(tabId)) as { title?: string } | undefined,
      browserTabId,
    );
    expect(title?.title).toBe("Design fixture");

    // A drag over empty space marks a region and opens its note.
    const drag: GuestInput[] = [
      { mouse: "mouseMove", x: 40, y: 160 },
      { mouse: "mouseDown", x: 40, y: 160 },
    ];
    for (let step = 1; step <= 10; step += 1) drag.push({ mouse: "mouseMove", x: 40 + step * 18, y: 160 + step * 10 });
    drag.push({ mouse: "mouseUp", x: 220, y: 260 });
    await inPage(drag);
    await expect(page.getByRole("status").filter({ hasText: "Draw on the area" })).toBeVisible();
    await writeNote("Add a signup card here.");
    await expect(panel).toContainText("3 annotations", { timeout: 15_000 });
    await expect(panel).toContainText("Region");
    const send = page.getByRole("button", { name: "Send 3 annotations" });
    await expect(send).toBeEnabled();

    // The device size preview still works while annotating.
    await page.getByRole("button", { name: "Device size" }).click();
    await expect(page.getByRole("button", { name: "Fit panel" })).toBeVisible();
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Fit panel" }).click();

    // Escape leaves Annotate but keeps the annotations for sending.
    await page.keyboard.press("Escape");
    await expect(annotate).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("textbox", { name: "Browser URL" })).toBeVisible();
    await expect(panel).toContainText("Turn on Annotate to edit notes on the page.");
    await expect(panel).toContainText("3 annotations");
    await send.click();
    const dialog = page.getByRole("dialog", { name: "Send annotations" });
    await expect(dialog.locator(".choice-detail")).toHaveText(/Codex chat/u);
    const preview = dialog.getByLabel("Message preview");
    await expect(preview).toContainText(
      `Please apply these 3 design annotations I made in the ZLI browser panel on ${pageUrl}`,
    );
    await expect(preview).toContainText("Selector: `#pay`");
    await expect(preview).toContainText("Instruction: Make the pay button green.");
    await expect(preview).toContainText("Instruction: Bigger, tighter.");
    await expect(preview).toContainText("### Annotation 3: Region");
    await expect(preview).toContainText("Instruction: Add a signup card here.");
    await expect(preview).toContainText("region-3.png (attached)");
    await expect(preview).toContainText('<button id="pay"');
    await expect(dialog).toContainText("with 3 images");
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByText(/Mock response: Please apply these 3 design annotations/u)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(".chat-attachments")).toContainText("element-1.png");
    await expect(page.locator(".chat-attachments")).toContainText("region-3.png");
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
