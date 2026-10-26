import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeApp,
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  git,
  launchDesktop,
} from "./desktop-fixtures.js";

test("completes the workspace, provider, browser, review, and restoration journey", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  let browserServer: Server | undefined;
  let rendererRandomUUIDDisabled = false;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    await expect(page.locator(".project-label")).toContainText("repo");

    await page.getByRole("button", { name: "Create worktree", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create worktree" });
    await dialog.getByLabel("Branch").fill("e2e");
    await dialog.getByRole("button", { name: "Create worktree" }).click();
    const worktree = page.getByRole("button", { name: /e2e/iu });
    await expect(worktree).toContainText("Ready", { timeout: 30_000 });
    await worktree.click();
    const worktreeId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.worktrees.find((candidate) => candidate.path.replaceAll("\\", "/").endsWith("/e2e"))
        ?.worktreeId;
    });
    if (!worktreeId) throw new Error("The created worktree was not present in the runtime projection.");

    const terminalPort = 43100 + Math.floor(Math.random() * 500);
    const worktreePath = join(`${repo}-worktrees`, "e2e");
    browserServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>ZLI fixture</title><main>browser fixture ready</main>");
    });
    const browserPort = await listen(browserServer);
    await writeFile(
      join(worktreePath, "dev-server.mjs"),
      [
        "import { createServer } from 'node:http';",
        "createServer((_request, response) => {",
        "  response.writeHead(200, { 'content-type': 'text/html' });",
        "  response.end('<!doctype html><title>ZLI fixture</title><main>browser fixture ready</main>');",
        `}).listen(${terminalPort}, '127.0.0.1', () => console.log('ZLI_DEV_READY ${terminalPort}'));`,
      ].join("\n"),
      "utf8",
    );
    // The drawer's open state is remembered between launches, so only open it when it is closed.
    const terminalToggle = page.getByRole("button", { name: "Terminal", exact: true });
    if ((await terminalToggle.getAttribute("aria-pressed")) !== "true") await terminalToggle.click();
    await page.getByRole("button", { name: "Start terminal" }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const projection = await window.zli?.runtime.getProjection();
            const terminal = projection?.terminals.at(-1);
            return terminal ? `${terminal.status}:${terminal.errorMessage ?? ""}` : "missing";
          }),
        { timeout: 10_000 },
      )
      .toBe("running:");
    await page.locator(".terminal-output .xterm-helper-textarea").focus();
    await page.keyboard.type("node dev-server.mjs");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(`ZLI_DEV_READY ${terminalPort}`, {
      timeout: 20_000,
    });
    await page.locator(".sidebar-new-agent").click();
    const newAgent = page.getByRole("dialog", { name: "New agent" });
    await newAgent.getByText("Codex", { exact: true }).click();
    await expect(newAgent.getByRole("radio", { name: /Codex/u })).toBeChecked();
    await newAgent.getByText("Chat", { exact: true }).click();
    await expect(newAgent.getByRole("radio", { name: /^Chat/u })).toBeChecked();
    await expect(newAgent.getByRole("radio", { name: /Existing worktree/u })).toBeChecked();
    await expect(newAgent.getByRole("button", { name: "Worktree: e2e" })).toBeVisible();
    await newAgent.getByRole("button", { name: "Start agent" }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeEnabled({ timeout: 20_000 });
    await composer.fill("inspect workspace");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Mock response: inspect workspace")).toBeVisible();

    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByRole("textbox", { name: "Browser URL" }).fill(`http://127.0.0.1:${browserPort}`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByRole("heading", { name: "ZLI fixture" })).toBeVisible({ timeout: 20_000 });

    const browserTabId = await page.evaluate(async () => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.browserTabs.at(-1)?.browserTabId;
    });
    if (!browserTabId) throw new Error("The browser tab was not projected to the renderer.");
    const snapshot = await page.evaluate(async (tabId) => {
      if (!window.zli) throw new Error("The ZLI bridge is unavailable in the renderer.");
      return window.zli.browser.snapshot(tabId);
    }, browserTabId);
    expect(snapshot).toMatchObject({ url: `http://127.0.0.1:${browserPort}/`, title: "ZLI fixture" });
    const designInspection = await page.evaluate(async (tabId) => {
      if (!window.zli) throw new Error("The ZLI bridge is unavailable in the renderer.");
      return window.zli.browser.designInspect({ browserTabId: tabId, selector: "main" });
    }, browserTabId);
    expect(designInspection).toMatchObject({
      tag: "main",
      text: "browser fixture ready",
      screenshot: { mimeType: "image/png" },
    });

    await writeFile(join(worktreePath, "change.txt"), "integration change\n", "utf8");
    if (process.platform === "linux") {
      await setRendererRandomUUID(fixture.page, false);
      rendererRandomUUIDDisabled = true;
    }
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Refresh changes" }).click();
    await expect(page.getByText("change.txt")).toBeVisible({ timeout: 20_000 });
    await page.locator(".review-file", { hasText: "change.txt" }).click();
    await expect(page.getByRole("region", { name: "Diff for change.txt" })).toContainText("integration change");
    const previousReviewUpdate = await page.evaluate(async (id) => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.reviews?.find((candidate) => candidate.worktreeId === id)?.updatedAt ?? "";
    }, worktreeId);
    expect(previousReviewUpdate).not.toBe("");
    await page.getByLabel("Commit message").fill("exercise review flow");
    await page.getByRole("button", { name: "Commit all changes" }).click();
    await expect
      .poll(
        () =>
          page.evaluate(async (id) => {
            const projection = await window.zli?.runtime.getProjection();
            const review = projection?.reviews?.find((candidate) => candidate.worktreeId === id);
            return review?.errorMessage
              ? `error: ${review.errorMessage}`
              : (review?.updatedAt ?? document.querySelector(".review-pane .inline-error")?.textContent ?? "");
          }, worktreeId),
        { timeout: 20_000 },
      )
      .not.toBe(previousReviewUpdate);
    const reviewError = await page.evaluate(async (id) => {
      const projection = await window.zli?.runtime.getProjection();
      return projection?.reviews?.find((candidate) => candidate.worktreeId === id)?.errorMessage;
    }, worktreeId);
    expect(reviewError).toBeUndefined();
    await expect(page.locator(".review-pane .inline-error")).toHaveCount(0);
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    await page.getByRole("button", { name: "More Git actions" }).click();
    await page.getByRole("menuitem", { name: "Merge into another branch…" }).click();
    const mergeLocal = page.getByRole("dialog", { name: "Merge into another branch" });
    await mergeLocal.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(mergeLocal).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(() => git(repo, ["show", "main:change.txt"]).catch(() => ""), { timeout: 20_000 })
      .toBe("integration change");
    await setRendererRandomUUID(page, true);
    rendererRandomUUIDDisabled = false;

    await fixture.page.evaluate(() => window.zli?.test?.restartRuntime());
    await expect(fixture.page.getByRole("log", { name: "Terminal output" })).toContainText(
      `ZLI_DEV_READY ${terminalPort}`,
      { timeout: 20_000 },
    );
    await closeApp(fixture, { stopTerminals: false });
    const relaunched = await launchDesktop(repo, root);
    fixture = relaunched;
    await expect
      .poll(
        async () =>
          relaunched.page.evaluate(async (id) => {
            const projection = await window.zli?.runtime.getProjection();
            return projection?.worktrees.find((candidate) => candidate.worktreeId === id)?.status;
          }, worktreeId),
        { timeout: 30_000 },
      )
      .toBe("ready");
    await expect(fixture.page.getByRole("button", { name: /e2e/iu })).toContainText("Ready", { timeout: 30_000 });
    await expect(fixture.page.getByText("Mock response: inspect workspace")).toBeVisible({ timeout: 20_000 });
    await fixture.page.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(fixture.page.getByRole("heading", { name: "ZLI fixture" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await closeServer(browserServer);
    if (fixture) {
      if (rendererRandomUUIDDisabled) await setRendererRandomUUID(fixture.page, true);
      await closeDesktop(fixture);
    }
  }
});

async function setRendererRandomUUID(page: DesktopFixture["page"], enabled: boolean): Promise<void> {
  await page.evaluate((shouldEnable) => {
    const cryptoApi = globalThis.crypto as Crypto & { __zliOriginalRandomUUID?: Crypto["randomUUID"] };
    if (shouldEnable) {
      if (cryptoApi.__zliOriginalRandomUUID) {
        Object.defineProperty(cryptoApi, "randomUUID", {
          configurable: true,
          value: cryptoApi.__zliOriginalRandomUUID,
        });
        delete cryptoApi.__zliOriginalRandomUUID;
      }
      return;
    }
    Object.defineProperty(cryptoApi, "__zliOriginalRandomUUID", {
      configurable: true,
      value: cryptoApi.randomUUID,
    });
    Object.defineProperty(cryptoApi, "randomUUID", { configurable: true, value: undefined });
  }, enabled);
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The browser fixture server did not bind."));
        return;
      }
      resolvePort(address.port);
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
