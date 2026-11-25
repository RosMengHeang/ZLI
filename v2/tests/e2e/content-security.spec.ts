import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
  sendChatMessage,
} from "./desktop-fixtures.js";

test("the app window runs under its content security policy without breaking anything", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root);
    const page = fixture.page;
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/iu.test(message.text())) violations.push(message.text());
    });

    expect(page.url()).toMatch(/^zli-v2:\/\/app\//u);
    // A script slipped into the page does not run.
    expect(
      await page.evaluate(async () => {
        const script = document.createElement("script");
        script.textContent = "document.body.dataset.injected = 'ran'";
        document.head.append(script);
        await new Promise((resolve) => setTimeout(resolve, 50));
        script.remove();
        return document.body.dataset.injected ?? "blocked";
      }),
    ).toBe("blocked");
    violations.length = 0;

    // A chat with Markdown, code, and a link renders and works under the policy.
    await openNewAgentOptions(page);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByText("Codex", { exact: true }).click();
    await dialog.getByText("Chat", { exact: true }).click();
    await dialog.getByRole("button", { name: "Start agent" }).click();
    await sendChatMessage(page, "Show **policy-bold**, `policy-code`, and https://example.com");
    await expect(page.getByText("policy-bold").first()).toBeVisible();

    expect(violations).toEqual([]);
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
