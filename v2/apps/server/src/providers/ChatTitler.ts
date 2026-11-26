import { randomUUID } from "node:crypto";

import { CommandId, type ProviderDiscovery, type RuntimeEventEnvelope, ThreadId } from "@zli-v2/contracts";
import { spawnCli } from "@zli-v2/shared";

import type { Engine } from "../orchestration/Engine.js";

const TITLE_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TITLE_CHARS = 80;

const TITLE_PROMPT =
  "Write a title of 2 to 6 words for a chat that starts with the message the user sends. Name its topic plainly, " +
  "in the message's language. Reply with the title only: no quotes, no full stop.";

/** Makes a title from a chat's first message. Undefined when none could be made. */
export type TitleWriter = (message: string) => Promise<string | undefined>;

/**
 * Gives each chat a short title once, from its first message, so the sidebar does not show the message itself.
 * One attempt per chat: a failed one leaves the chat named by its first message, as before.
 */
export class ChatTitler {
  private readonly unsubscribe: () => void;
  private readonly tried = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly write: TitleWriter,
  ) {
    this.unsubscribe = engine.subscribe((envelope) => void this.observe(envelope));
  }

  stop(): void {
    this.unsubscribe();
  }

  private async observe(envelope: RuntimeEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (event.type !== "thread.message.appended" || event.message.role !== "user") return;
    const threadId = event.message.threadId;
    if (this.tried.has(threadId)) return;
    this.tried.add(threadId);
    const projection = await this.engine.projection();
    const thread = projection.threads.find((entry) => entry.threadId === threadId);
    // A chat that carries on another one keeps that one's title, and agents started by agents or buddies are
    // named by their task.
    if (!thread || thread.chatTitle || thread.continues || thread.startedBy || thread.unattended) return;
    const users = (projection.messages ?? []).filter(
      (message) => message.threadId === threadId && message.role === "user",
    );
    // Only the first message names the chat. After a restart, later messages never start a second attempt.
    if (users.length !== 1 || users[0]?.messageId !== event.message.messageId) return;
    const text = event.message.text.trim();
    if (!text) return;
    let title: string | undefined;
    try {
      title = cleanTitle(await this.write(text.slice(0, MAX_MESSAGE_CHARS)));
    } catch {
      return;
    }
    if (!title) return;
    try {
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.title", threadId: ThreadId.parse(threadId), title },
      });
    } catch {
      // The chat was removed meanwhile; it keeps no title.
    }
  }
}

/** One line, without quotes or a closing full stop, cut to fit. */
export function cleanTitle(raw: string | undefined): string | undefined {
  const line = raw
    ?.split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return undefined;
  const bare = line
    .replace(/^(?:title:\s*)/iu, "")
    .replace(/^["'`*]+|["'`*.。]+$/gu, "")
    .trim();
  if (!bare) return undefined;
  return bare.length > MAX_TITLE_CHARS ? `${bare.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : bare;
}

/**
 * Titles with Claude Code's smallest model when Claude Code is installed: no tools, no MCP servers, no settings,
 * and nothing saved to the person's session history. Without Claude Code, chats keep their first message.
 */
export function claudeTitleWriter(discover: () => Promise<readonly ProviderDiscovery[]>): TitleWriter {
  return async (message) => {
    const claude = (await discover()).find((entry) => entry.provider === "claude-code");
    if (claude?.status !== "found" || !claude.path) return undefined;
    return runTitle(claude.path, message);
  };
}

function runTitle(command: string, message: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(
        command,
        [
          "-p",
          "--model",
          "haiku",
          "--output-format",
          "text",
          "--no-session-persistence",
          "--tools",
          "",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--system-prompt",
          TITLE_PROMPT,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, TITLE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? out : undefined));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(message);
  });
}
