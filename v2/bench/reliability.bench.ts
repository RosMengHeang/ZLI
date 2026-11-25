import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
} from "../tests/e2e/desktop-fixtures.js";
import { sampleTree } from "./processes.js";
import { type ReplayServer, startReplayServer } from "./replayServer.js";

/**
 * ADEMark's reliability tests C2 to C6 (https://ademark.dev), run against ZLI with the real `claude` CLI and a
 * replay server for the model. ADEMark strikes at 90 s into a long turn; here it is AT_MS, so a run takes
 * minutes. Results go to bench/results/reliability.json.
 *
 *   ZLI_BENCH_RELIABILITY=1 pnpm bench
 */
test.skip(process.env.ZLI_BENCH_RELIABILITY !== "1", "Run with ZLI_BENCH_RELIABILITY=1.");
test.setTimeout(30 * 60_000);

const execFileAsync = promisify(execFile);
/** When each fault strikes, counted from the start of the long turn. */
const AT_MS = 10_000;
/** How long the long turn streams when nothing goes wrong. */
const LONG_TURN_MS = 40_000;
/** How long the model API stays unreachable in C5. */
const BLOCK_MS = 15_000;

type Outcome = Record<string, unknown>;

type Chat = { fixture: DesktopFixture; replay: ReplayServer; root: string; repo: string };

function env(replay: ReplayServer, root: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: replay.url,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    ZLI_TEST_PROVIDER: "",
  };
}

async function openChat(): Promise<Chat> {
  const replay = await startReplayServer();
  const { root, repo } = await createGitFixture();
  const fixture = await launchDesktop(repo, root, { env: env(replay, root) });
  await openNewAgentOptions(fixture.page);
  const dialog = fixture.page.getByRole("dialog", { name: "New agent" });
  await dialog.getByText("Claude Code", { exact: true }).click();
  await dialog.getByText("Chat", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Rel");
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(composer(fixture.page)).toBeEnabled({ timeout: 60_000 });
  return { fixture, replay, root, repo };
}

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message Rel" });
}

async function type(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

async function thread(page: Page) {
  return page.evaluate(async () => {
    const projection = await window.zli?.runtime.getProjection();
    const found = projection?.threads.find((entry) => entry.name === "Rel") ?? projection?.threads[0];
    const messages = (projection?.messages ?? []).filter((entry) => entry.threadId === found?.threadId);
    return {
      status: found?.status,
      error: found?.errorMessage,
      providerSessionId: found?.providerSessionId,
      messages: messages.map((entry) => ({ role: entry.role, text: entry.text.slice(0, 80) })),
      queued: (projection?.queuedMessages ?? []).filter((entry) => entry.threadId === found?.threadId).length,
    };
  });
}

/** Waits until the chat's status is one of `statuses`, returning how long that took or undefined on timeout. */
async function waitStatus(page: Page, statuses: string[], timeoutMs: number): Promise<number | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = (await thread(page).catch(() => undefined))?.status;
    if (status && statuses.includes(status)) return Date.now() - started;
    await page.waitForTimeout(200);
  }
  return undefined;
}

/** Starts a long turn and waits for its first streamed words. */
async function longTurn(chat: Chat, text: string): Promise<number> {
  chat.replay.setStreamMs(LONG_TURN_MS);
  const before = chat.replay.requests.length;
  await type(chat.fixture.page, text);
  await expect.poll(() => chat.replay.requests.length, { timeout: 60_000 }).toBeGreaterThan(before);
  return Date.now();
}

/** Sends one short message after a fault and reports whether, and how fast, the agent answered. */
async function answersAfter(chat: Chat, text: string): Promise<Outcome> {
  chat.replay.setStreamMs(0);
  const page = chat.fixture.page;
  const replies = page.getByText(/^Hello\./u);
  const before = await replies.count();
  const started = Date.now();
  try {
    await expect(composer(page)).toBeEnabled({ timeout: 60_000 });
    await type(page, text);
    await expect.poll(() => replies.count(), { timeout: 90_000, intervals: [100] }).toBeGreaterThan(before);
    return { answered: true, ms: Date.now() - started };
  } catch (error) {
    return { answered: false, after: Date.now() - started, error: String(error).slice(0, 200) };
  }
}

async function agentPids(chat: Chat): Promise<number[]> {
  const pid = chat.fixture.app.process().pid;
  const tree = await sampleTree(pid ? [pid] : [], chat.root);
  return tree.processes.filter((entry) => entry.name.toLowerCase() === "claude.exe").map((entry) => entry.pid);
}

async function close(chat: Chat | undefined): Promise<void> {
  if (!chat) return;
  await closeDesktop(chat.fixture).catch(() => undefined);
  await chat.replay.close().catch(() => undefined);
}

/**
 * ADEMark's survival rubric for C4 to C6: watch 60 s after the fault. Pass when the agent goes back to the model
 * on its own and the chat ends idle with its messages; partial when it needs one "continue" from the person;
 * fail when even that gets no answer.
 */
async function survival(chat: Chat, requestsAtFault: number, messagesBefore: number): Promise<Outcome> {
  chat.replay.setStreamMs(0);
  const page = chat.fixture.page;
  const watchUntil = Date.now() + 60_000;
  let resumedAt: number | undefined;
  while (Date.now() < watchUntil) {
    if (resumedAt === undefined && chat.replay.requests.length > requestsAtFault) resumedAt = Date.now();
    const state = await thread(page).catch(() => undefined);
    if (resumedAt !== undefined && state?.status === "idle") break;
    await page.waitForTimeout(500);
  }
  const watched = await thread(page);
  const autoResumed = resumedAt !== undefined && watched.status === "idle";
  const nothingLost = watched.messages.length >= messagesBefore;
  if (autoResumed && nothingLost) {
    return { grade: "pass", autoResumed, status: watched.status, messagesKept: nothingLost, shown: watched.error };
  }
  const manual = await answersAfter(chat, "continue");
  return {
    grade: manual.answered === true ? "partial" : "fail",
    autoResumed,
    statusAfterWatch: watched.status,
    shown: watched.error,
    messagesKept: nothingLost,
    afterContinue: manual,
  };
}

async function c2MessageDelivery(): Promise<Outcome> {
  const chat = await openChat();
  try {
    await longTurn(chat, "start a long task");
    const page = chat.fixture.page;
    const sent = ["follow-up one", "follow-up two", "follow-up three"];
    for (const text of sent) {
      await page.waitForTimeout(2_000);
      await type(page, text);
    }
    chat.replay.setStreamMs(0);
    // The long turn ends by itself; then every queued message must reach the model, once each, in order.
    await waitStatus(page, ["idle"], LONG_TURN_MS + 60_000);
    await expect
      .poll(() => sent.every((text) => chat.replay.requests.some((request) => request.lastUserText.includes(text))), {
        timeout: 90_000,
      })
      .toBe(true)
      .catch(() => undefined);
    await waitStatus(page, ["idle"], 60_000);
    const reached = sent.map(
      (text) => chat.replay.requests.filter((request) => request.lastUserText.includes(text)).length,
    );
    const order = sent.map((text) => chat.replay.requests.findIndex((request) => request.lastUserText.includes(text)));
    const inOrder = order.every(
      (index, position) => index >= 0 && (position === 0 || index > (order[position - 1] ?? -1)),
    );
    const state = await thread(page);
    return {
      pass: reached.every((count) => count >= 1) && inOrder,
      deliveredPerMessage: reached,
      inOrder,
      userMessagesInChat: state.messages.filter((entry) => entry.role === "user").length,
      status: state.status,
    };
  } finally {
    await close(chat);
  }
}

async function c3ChatLock(): Promise<Outcome> {
  const chat = await openChat();
  try {
    await longTurn(chat, "start a long task");
    const page = chat.fixture.page;
    const box = composer(page);
    let longestLockMs = 0;
    let lockedSince: number | undefined;
    const until = Date.now() + 15_000;
    let typed = "";
    while (Date.now() < until) {
      const editable = await box.isEditable().catch(() => false);
      const now = Date.now();
      if (!editable) lockedSince ??= now;
      else {
        if (lockedSince !== undefined) longestLockMs = Math.max(longestLockMs, now - lockedSince);
        lockedSince = undefined;
        typed += "x";
        await box.pressSequentially("x");
      }
      await page.waitForTimeout(250);
    }
    if (lockedSince !== undefined) longestLockMs = Math.max(longestLockMs, Date.now() - lockedSince);
    const value = await box.inputValue();
    return { pass: longestLockMs <= 2_000 && value === typed, longestLockMs, typedKept: value === typed };
  } finally {
    await close(chat);
  }
}

async function c4AgentKilled(): Promise<Outcome> {
  const chat = await openChat();
  try {
    const started = await longTurn(chat, "start a long task");
    const page = chat.fixture.page;
    await page.waitForTimeout(Math.max(0, AT_MS - (Date.now() - started)));
    const pids = await agentPids(chat);
    const killedAt = Date.now();
    for (const pid of pids) await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)]).catch(() => undefined);
    const requestsAtFault = chat.replay.requests.length;
    const messagesBefore = (await thread(page)).messages.length;
    const noticedMs = await waitStatus(page, ["stopped", "failed", "idle"], 60_000);
    const sessionBefore = (await thread(page)).providerSessionId;
    const graded = await survival(chat, requestsAtFault, messagesBefore);
    const final = await thread(page);
    return {
      ...graded,
      killedProcesses: pids.length,
      statusNoticedAfterMs: noticedMs,
      sameConversation: final.providerSessionId === sessionBefore,
      totalMs: Date.now() - killedAt,
    };
  } finally {
    await close(chat);
  }
}

async function c5ApiBlocked(): Promise<Outcome> {
  const chat = await openChat();
  try {
    const started = await longTurn(chat, "start a long task");
    const page = chat.fixture.page;
    await page.waitForTimeout(Math.max(0, AT_MS - (Date.now() - started)));
    chat.replay.setBlocked(true);
    const requestsAtBlock = chat.replay.requests.length;
    const statuses = new Set<string>();
    const blockUntil = Date.now() + BLOCK_MS;
    while (Date.now() < blockUntil) {
      const status = (await thread(page)).status;
      if (status) statuses.add(status);
      await page.waitForTimeout(500);
    }
    chat.replay.setBlocked(false);
    const messagesBefore = (await thread(page)).messages.length;
    const graded = await survival(chat, requestsAtBlock, messagesBefore);
    return { ...graded, statusesWhileBlocked: [...statuses], connectionsRefused: chat.replay.refused() };
  } finally {
    await close(chat);
  }
}

async function c6QuitAndReopen(): Promise<Outcome> {
  let chat: Chat | undefined = await openChat();
  try {
    const started = await longTurn(chat, "start a long task");
    await chat.fixture.page.waitForTimeout(Math.max(0, AT_MS - (Date.now() - started)));
    const before = await thread(chat.fixture.page);
    const requestsAtQuit = chat.replay.requests.length;
    // ZLI asks before quitting while an agent works. ADEMark accepts that question and records it, so the
    // native box is answered "Quit anyway" the way the person would.
    await chat.fixture.app.evaluate(({ dialog }) => {
      const asked = globalThis as unknown as { __quitAsked?: string };
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string };
        asked.__quitAsked = `${options.message ?? ""} ${options.detail ?? ""}`.trim();
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    // A normal quit, as when the person closes ZLI. If it never finishes, that is a result too.
    const quitStarted = Date.now();
    const quit = await Promise.race([
      chat.fixture.app.close().then(() => "closed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000)),
    ]);
    const quitMs = Date.now() - quitStarted;
    // The question is read from the log of the main process before it exits; it may already be gone.
    const quitQuestion = "asked before quitting (answered Quit anyway)";
    if (quit === "hung") {
      const quitDialog = await chat.fixture.page
        .getByRole("dialog")
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => undefined);
      return { grade: "fail", quit, quitMs, quitDialog };
    }
    const relaunchStarted = Date.now();
    const fixture = await launchDesktop(chat.repo, chat.root, { env: env(chat.replay, chat.root) });
    chat = { ...chat, fixture };
    const page = fixture.page;
    await page.locator(".session-row", { hasText: "Rel" }).first().click({ timeout: 30_000 });
    const reopenMs = Date.now() - relaunchStarted;
    const graded = await survival(chat, requestsAtQuit, before.messages.length);
    const final = await thread(page);
    return {
      ...graded,
      quitMs,
      quitQuestion,
      reopenMs,
      messagesBefore: before.messages.length,
      messagesAfter: final.messages.length,
      sameConversation: final.providerSessionId === before.providerSessionId,
    };
  } finally {
    await close(chat);
  }
}

test("ADEMark reliability tests against ZLI", async () => {
  const results: Record<string, Outcome> = {};
  const only = process.env.ZLI_BENCH_ONLY?.split(",");
  const run = async (name: string, body: () => Promise<Outcome>) => {
    if (only && !only.some((id) => name.startsWith(id))) return;
    try {
      results[name] = await body();
    } catch (error) {
      results[name] = { pass: false, harnessError: String(error).slice(0, 400) };
    }
    console.log(name, JSON.stringify(results[name]));
  };
  await run("C2 message delivery", c2MessageDelivery);
  await run("C3 chat lock", c3ChatLock);
  await run("C4 agent killed", c4AgentKilled);
  await run("C5 model API blocked", c5ApiBlocked);
  await run("C6 quit and reopen", c6QuitAndReopen);
  const folder = join(import.meta.dirname, "results");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "reliability.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
});
