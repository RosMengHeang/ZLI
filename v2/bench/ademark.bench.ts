import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  closeDesktop,
  createGitFixture,
  type DesktopFixture,
  launchDesktop,
  openNewAgentOptions,
} from "../tests/e2e/desktop-fixtures.js";
import { breakdown, median, percentile, sampleTree, type TreeSample } from "./processes.js";
import { type ReplayServer, startReplayServer } from "./replayServer.js";

/**
 * ADEMark's tests (https://ademark.dev), run against ZLI on this machine. ADEMark runs on macOS only, so this
 * repeats its method here: the real app, the real `claude` CLI as the agent, and a replay server in place of
 * the model. Results go to bench/results/<label>.json.
 *
 *   pnpm bench                     # full run
 *   ZLI_BENCH_LABEL=after pnpm bench
 */

const LABEL = process.env.ZLI_BENCH_LABEL ?? "run";
const QUICK = process.env.ZLI_BENCH_QUICK === "1";
const COLD_RUNS = QUICK ? 1 : 3;
const REST_CHATS = 5;
const MANY_CHATS = Number(process.env.ZLI_BENCH_CHATS ?? (QUICK ? 8 : 20));
const SETTLE_MS = QUICK ? 10_000 : 30_000;
const LOAD_MS = QUICK ? 20_000 : 60_000;
const IDLE_CPU_MS = QUICK ? 10_000 : 30_000;

type Results = Record<string, unknown>;

test.setTimeout(60 * 60_000);

test("ADEMark tests against ZLI", async () => {
  const replay = await startReplayServer();
  const results: Results = { label: LABEL, platform: process.platform, startedAt: new Date().toISOString() };
  try {
    results.bareCli = await bareCliHello(replay);
    results.coldStartMs = await coldStarts(replay);
    const { root, repo } = await createGitFixture();
    let fixture: DesktopFixture | undefined;
    try {
      fixture = await launch(repo, root, replay);
      Object.assign(results, await chatTests(fixture, replay));
    } finally {
      if (fixture) {
        results.disk = await diskUse(root);
        results.afterQuit = await afterQuit(fixture);
        await closeDesktop(fixture).catch(() => undefined);
      }
    }
  } finally {
    await replay.close();
    results.finishedAt = new Date().toISOString();
    const folder = join(import.meta.dirname, "results");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${LABEL}.json`), `${JSON.stringify(results, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(results, null, 2));
  }
});

function agentEnv(replay: ReplayServer, root: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: replay.url,
    ANTHROPIC_API_KEY: "sk-bench",
    // A clean Claude config, so the user's own MCP servers, plugins, and memory are not counted as ZLI's.
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    ...(process.env.ZLI_AGENT_IDLE_STOP_MS ? { ZLI_AGENT_IDLE_STOP_MS: process.env.ZLI_AGENT_IDLE_STOP_MS } : {}),
  };
}

async function launch(repo: string, root: string, replay: ReplayServer): Promise<DesktopFixture> {
  return launchDesktop(repo, root, { env: { ...agentEnv(replay, root), ZLI_TEST_PROVIDER: "" } });
}

function roots(fixture: DesktopFixture): number[] {
  const pid = fixture.app.process().pid;
  return pid ? [pid] : [];
}

async function sample(fixture: DesktopFixture): Promise<TreeSample> {
  return sampleTree(roots(fixture), fixture.root);
}

/** The control: `claude -p hi` on its own, through the same replay server. */
async function bareCliHello(replay: ReplayServer): Promise<Results> {
  const { root } = await createGitFixture();
  const before = replay.requests.length;
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("claude -p hi", {
      shell: true,
      cwd: join(root, "repo"),
      env: { ...process.env, ...agentEnv(replay, root) },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", reject);
  });
  const requests = replay.requests.slice(before);
  return {
    ms: Date.now() - started,
    requests: requests.length,
    promptChars: requests.reduce((sum, request) => sum + request.promptChars, 0),
    tools: requests[0]?.toolCount ?? 0,
  };
}

async function coldStarts(replay: ReplayServer): Promise<Results> {
  const times: number[] = [];
  for (let run = 0; run < COLD_RUNS; run += 1) {
    const { root, repo } = await createGitFixture();
    const started = Date.now();
    const fixture = await launch(repo, root, replay);
    await expect(fixture.page.locator(".project-label").first()).toBeVisible({ timeout: 60_000 });
    times.push(Date.now() - started);
    await closeDesktop(fixture);
  }
  return { median: median(times), runs: times };
}

async function startChat(page: Page, name: string): Promise<number> {
  await openNewAgentOptions(page);
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByText("Claude Code", { exact: true }).click();
  await dialog.getByText("Chat", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  const started = Date.now();
  await dialog.getByRole("button", { name: "Start agent" }).click();
  await expect(page.getByRole("textbox", { name: `Message ${name}` })).toBeEnabled({ timeout: 60_000 });
  return Date.now() - started;
}

/** Sends a message and returns how long until the first word of the reply is on screen. */
async function sendAndTimeFirstWord(page: Page, name: string, text: string): Promise<number> {
  const composer = page.getByRole("textbox", { name: `Message ${name}` });
  const replies = page.getByText(/^Hello\./u);
  const before = await replies.count();
  await composer.fill(text);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 60_000 });
  const started = Date.now();
  await composer.press("Enter");
  await expect.poll(() => replies.count(), { timeout: 60_000, intervals: [10] }).toBeGreaterThan(before);
  return Date.now() - started;
}

async function waitAllIdle(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const projection = await window.zli?.runtime.getProjection();
          return projection?.threads.filter((thread) => thread.status === "idle" || thread.status === "stopped").length;
        }),
      { timeout: 120_000, intervals: [500] },
    )
    .toBeGreaterThanOrEqual(count);
}

type Settled = {
  workingSetMb: number;
  privateMb: number;
  appWorkingSetMb: number;
  appPrivateMb: number;
  agentProcesses: number;
  byKind: unknown;
  processes: string[];
};

async function settledMemory(fixture: DesktopFixture): Promise<Settled> {
  await fixture.page.waitForTimeout(SETTLE_MS);
  const samples: TreeSample[] = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push(await sample(fixture));
    await fixture.page.waitForTimeout(2_000);
  }
  const last = samples.at(-1) as TreeSample;
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return {
    workingSetMb: Math.round(median(samples.map((entry) => entry.workingSetMb))),
    privateMb: Math.round(median(samples.map((entry) => entry.privateMb))),
    appWorkingSetMb: Math.round(median(samples.map((entry) => entry.appWorkingSetMb))),
    appPrivateMb: Math.round(median(samples.map((entry) => entry.appPrivateMb))),
    agentProcesses: last.agentProcesses,
    byKind: roundKinds(breakdown(last)),
    // Each process with its memory and what it runs, so the report can say where memory goes.
    processes: [...last.processes]
      .sort((a, b) => b.workingSetBytes - a.workingSetBytes)
      .map(
        (entry) =>
          `${mb(entry.workingSetBytes)} MB ws / ${mb(entry.privateBytes)} MB private  ${entry.name}  ${entry.commandLine
            .replaceAll(fixture.root, "<root>")
            .replace(/\s+/gu, " ")
            .slice(0, 220)}`,
      ),
  };
}

/** CPU each kind of process used between two samples, as % of one core. */
function cpuByKind(start: TreeSample, end: TreeSample): Record<string, number> {
  const before = new Map(start.processes.map((entry) => [entry.pid, entry.cpuMs]));
  const totals: Record<string, number> = {};
  for (const entry of end.processes) {
    const used = entry.cpuMs - (before.get(entry.pid) ?? entry.cpuMs);
    const kind = Object.keys(breakdown({ ...end, processes: [entry] }))[0] ?? entry.name;
    totals[kind] = (totals[kind] ?? 0) + used;
  }
  const window = end.at - start.at;
  return Object.fromEntries(
    Object.entries(totals)
      .map(([kind, used]) => [kind, Number(((used / window) * 100).toFixed(2))] as const)
      .filter(([, percent]) => percent > 0)
      .sort((a, b) => b[1] - a[1]),
  );
}

function roundKinds(kinds: ReturnType<typeof breakdown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(kinds)
      .sort((a, b) => b[1].workingSetMb - a[1].workingSetMb)
      .map(([kind, value]) => [kind, `${value.count} proc, ${Math.round(value.workingSetMb)} MB`]),
  );
}

async function chatTests(fixture: DesktopFixture, replay: ReplayServer): Promise<Results> {
  const { page } = fixture;
  const results: Results = {};

  // New thread, ready to type; first word after Enter; and every request one "hi" sends.
  const newThread: number[] = [];
  const firstWord: number[] = [];
  let hello: Results | undefined;
  for (let index = 1; index <= REST_CHATS; index += 1) {
    const name = `Bench${index}`;
    newThread.push(await startChat(page, name));
    const before = replay.requests.length;
    firstWord.push(await sendAndTimeFirstWord(page, name, "hi"));
    await waitAllIdle(page, index);
    if (!hello) {
      await page.waitForTimeout(3_000);
      const requests = replay.requests.slice(before);
      hello = {
        requests: requests.length,
        promptChars: requests.reduce((sum, request) => sum + request.promptChars, 0),
        firstRequestTools: requests[0]?.toolCount ?? 0,
        models: [...new Set(requests.map((request) => request.model))],
        zliServers: [...new Set(requests.flatMap((request) => request.zliServers))],
      };
    }
  }
  results.newThreadMs = { median: median(newThread), runs: newThread };
  results.firstWordMs = { median: median(firstWord), runs: firstWord };
  results.hello = hello;

  results.restMemory5 = await settledMemory(fixture);
  results.toolHostCall = await toolHostCall(fixture);

  // Idle CPU with the window in front: CPU time used by the whole tree over the window, as % of one core.
  const cpuStart = await sample(fixture);
  await page.waitForTimeout(IDLE_CPU_MS);
  const cpuEnd = await sample(fixture);
  results.idleCpuPercent = Number((((cpuEnd.cpuMs - cpuStart.cpuMs) / (cpuEnd.at - cpuStart.at)) * 100).toFixed(2));
  results.idleCpuByKind = cpuByKind(cpuStart, cpuEnd);

  // Under load: five agents stream at once; typing lag is measured in a sixth chat's message box meanwhile.
  replay.setStreamMs(LOAD_MS);
  const loadSamples: TreeSample[] = [];
  const typingChat = "Typist";
  await startChat(page, typingChat);
  for (let index = 1; index <= REST_CHATS; index += 1) {
    await page.evaluate(async (name) => {
      const projection = await window.zli?.runtime.getProjection();
      const thread = projection?.threads.find((candidate) => candidate.name === name);
      if (!thread) return;
      await window.zli?.runtime.dispatch({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        command: { type: "thread.send", threadId: thread.threadId, text: "write a long answer" },
      });
    }, `Bench${index}`);
  }
  const loadUntil = Date.now() + LOAD_MS - 5_000;
  const lags: number[] = [];
  await page.locator(".session-row", { hasText: typingChat }).click();
  const composer = page.getByRole("textbox", { name: `Message ${typingChat}` });
  await composer.click();
  await page.evaluate(() => {
    const store: number[] = [];
    (window as unknown as { __benchLags: number[] }).__benchLags = store;
    document.addEventListener(
      "input",
      (event) => {
        const typed = event.timeStamp;
        requestAnimationFrame(() => setTimeout(() => store.push(performance.now() - typed), 0));
      },
      true,
    );
  });
  while (Date.now() < loadUntil) {
    loadSamples.push(await sample(fixture));
    await composer.pressSequentially("typing under load ", { delay: 60 });
    await composer.fill("");
  }
  lags.push(...(await page.evaluate(() => (window as unknown as { __benchLags: number[] }).__benchLags)));
  results.loadMemory = {
    peakWorkingSetMb: Math.round(Math.max(...loadSamples.map((entry) => entry.workingSetMb))),
    medianWorkingSetMb: Math.round(median(loadSamples.map((entry) => entry.workingSetMb))),
    byKindAtPeak: roundKinds(
      breakdown(loadSamples.reduce((max, entry) => (entry.workingSetMb > max.workingSetMb ? entry : max))),
    ),
  };
  results.typingLagMs = { p95: Math.round(percentile(lags, 95)), median: Math.round(median(lags)), keys: lags.length };
  replay.setStreamMs(0);
  await waitAllIdle(page, REST_CHATS + 1);

  // Memory per extra chat, from REST_CHATS to MANY_CHATS (the Typist chat counts as one).
  const many = await settledMemory(fixture);
  for (let index = REST_CHATS + 2; index <= MANY_CHATS; index += 1) {
    const name = `Bench${index}`;
    await startChat(page, name);
    await sendAndTimeFirstWord(page, name, "hi");
  }
  await waitAllIdle(page, MANY_CHATS);
  const manyAfter = await settledMemory(fixture);
  const added = MANY_CHATS - REST_CHATS - 1;
  results.memoryPerChatMb = Number(((manyAfter.workingSetMb - many.workingSetMb) / added).toFixed(1));
  // ADEMark's A10: the app's own memory per extra chat, agents left out, in private memory.
  results.appPrivatePerChatMb = Number(((manyAfter.appPrivateMb - many.appPrivateMb) / added).toFixed(1));
  results.totalPrivatePerChatMb = Number(((manyAfter.privateMb - many.privateMb) / added).toFixed(1));
  results.restMemoryMany = { chats: MANY_CHATS, ...manyAfter };

  if (process.env.ZLI_AGENT_IDLE_STOP_MS) {
    await page.waitForTimeout(Number(process.env.ZLI_AGENT_IDLE_STOP_MS) + 15_000);
    results.restMemoryManyAfterIdleStop = await settledMemory(fixture);
    // A stopped agent comes back on the next message.
    results.firstWordAfterIdleStopMs = await sendAndTimeFirstWord(page, "Bench1", "hi again");
  }
  return results;
}

/**
 * Calls list_agents on the shared tool host as the first chat's agent would, to check the host reaches ZLI
 * and answers. Reports "not running" for a build without the host.
 */
async function toolHostCall(fixture: DesktopFixture): Promise<Results> {
  const endpointFile = join(fixture.root, "runtime.sqlite.tool-host.json");
  let endpoint: { port: number; token: string };
  try {
    endpoint = JSON.parse(await readFile(endpointFile, "utf8")) as typeof endpoint;
  } catch {
    return { status: "not running" };
  }
  const caller = await fixture.page.evaluate(async () => {
    const projection = await window.zli?.runtime.getProjection();
    const thread = projection?.threads[0];
    const worktree = projection?.worktrees.find((entry) => entry.worktreeId === thread?.worktreeId);
    return { w: thread?.worktreeId, c: worktree?.path };
  });
  const key = Buffer.from(JSON.stringify(caller), "utf8").toString("base64url");
  const call = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/mcp/zli/${key}`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.text()).slice(0, 300) };
  };
  const started = Date.now();
  const initialize = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } },
  });
  const listed = await call({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_agents", arguments: {} },
  });
  return { status: "running", ms: Date.now() - started, initialize: initialize.status, listAgents: listed };
}

async function afterQuit(fixture: DesktopFixture): Promise<Results> {
  const tree = roots(fixture);
  await fixture.app.close().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, QUICK ? 15_000 : 60_000));
  const left = await sampleTree(tree, fixture.root);
  return {
    processesLeft: left.processes.length,
    workingSetMb: Math.round(left.workingSetMb),
    byKind: roundKinds(breakdown(left)),
  };
}

async function diskUse(root: string): Promise<Results> {
  const entries: Results = {};
  for (const name of await readdir(root)) {
    entries[name] = Number(((await folderBytes(join(root, name))) / (1024 * 1024)).toFixed(2));
  }
  return entries;
}

async function folderBytes(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await folderBytes(join(path, name));
  return total;
}
