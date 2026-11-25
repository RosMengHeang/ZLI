import { expect, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
} from "../tests/e2e/desktop-fixtures.js";
import { median } from "./processes.js";
import { startReplayServer } from "./replayServer.js";

/**
 * Where the time between Enter and the first word goes: before the request reaches the model (ZLI and the
 * CLI), and after (the reply coming back to the screen). Run with ZLI_BENCH_LATENCY=1 pnpm bench.
 */
test.skip(process.env.ZLI_BENCH_LATENCY !== "1", "Run with ZLI_BENCH_LATENCY=1.");
test.setTimeout(10 * 60_000);

test("first word latency breakdown", async () => {
  const replay = await startReplayServer();
  const { root, repo } = await createGitFixture();
  let fixture: DesktopFixture | undefined;
  try {
    fixture = await launchDesktop(repo, root, {
      env: {
        ANTHROPIC_BASE_URL: replay.url,
        ANTHROPIC_API_KEY: "sk-bench",
        CLAUDE_CONFIG_DIR: `${root}/claude-config`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        ZLI_TEST_PROVIDER: "",
      },
    });
    const { page } = fixture;
    await openNewAgentOptions(page);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByText("Claude Code", { exact: true }).click();
    await dialog.getByText("Chat", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Lat");
    await dialog.getByRole("button", { name: "Start agent" }).click();
    const composer = page.getByRole("textbox", { name: "Message Lat" });
    await expect(composer).toBeEnabled({ timeout: 60_000 });
    const replies = page.getByText(/^Hello\./u);
    const toRequest: number[] = [];
    const toScreen: number[] = [];
    for (let run = 0; run < 6; run += 1) {
      const before = await replies.count();
      const requestsBefore = replay.requests.length;
      await composer.fill(`hi ${run}`);
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 60_000 });
      const started = Date.now();
      await composer.press("Enter");
      await expect.poll(() => replies.count(), { timeout: 60_000, intervals: [10] }).toBeGreaterThan(before);
      const shown = Date.now();
      const request = replay.requests[requestsBefore];
      if (request) {
        toRequest.push(request.at - started);
        toScreen.push(shown - request.at);
      }
      await page.waitForTimeout(1_500);
    }
    console.log(
      JSON.stringify({
        enterToRequestMs: { median: median(toRequest), runs: toRequest },
        requestToScreenMs: { median: median(toScreen), runs: toScreen },
        requestAt: replay.requests.map((request) => request.at),
      }),
    );
  } finally {
    if (fixture) await closeDesktop(fixture).catch(() => undefined);
    await replay.close();
  }
});
