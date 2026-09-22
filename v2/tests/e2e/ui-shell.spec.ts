import { expect, test } from "@playwright/test";

import { closeDesktop, createGitFixture, launchDesktop, type DesktopFixture } from "./desktop-fixtures.js";

test("provides a focused, keyboard-driven workbench shell", async () => {
  test.skip(process.env.ZLI_RUN_E2E !== "1", "Electron integration tests run explicitly in CI.");
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  const shortcut = process.platform === "darwin" ? "Meta+k" : "Control+k";
  try {
    fixture = await launchDesktop(repo, root);
    await fixture.page.keyboard.press(shortcut);
    const palette = fixture.page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByRole("textbox", { name: "Search commands" });
    await search.fill("browser");
    await expect(palette.getByRole("button", { name: "Focus browser" })).toBeVisible();
    await expect(palette.getByRole("button", { name: "Focus agent" })).toHaveCount(0);
    await search.press("Enter");
    await expect(fixture.page.getByRole("button", { name: "Browser" })).toHaveClass(/is-active/iu);

    await fixture.page.keyboard.press(shortcut);
    await fixture.page.getByRole("textbox", { name: "Search commands" }).fill("help");
    await fixture.page.getByRole("textbox", { name: "Search commands" }).press("Enter");
    await expect(fixture.page.getByRole("dialog", { name: "Help and diagnostics" })).toBeVisible();
    await expect(fixture.page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
    await fixture.page.getByRole("button", { name: "Close" }).click();
  } finally {
    if (fixture) await closeDesktop(fixture);
  }
});
