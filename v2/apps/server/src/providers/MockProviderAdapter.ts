import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderCapabilities, ThreadId } from "@zli-v2/contracts";

import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderEvent,
  ProviderKind,
  ProviderSession,
} from "./ProviderService.js";

/**
 * Deterministic provider used only by the Electron integration harness.
 * It exercises the structured provider boundary without spawning another CLI.
 */
export class MockProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderKind = "codex";
  readonly capabilities: ProviderCapabilities = {
    exactResume: true,
    structuredApproval: true,
    structuredUserInput: true,
    conversationRollback: true,
    modelSwitch: "unsupported",
  };

  private readonly sessions = new Map<string, ProviderSession>();
  private readonly turns = new Map<string, unknown[]>();
  /** Turns paused on an approval or question, finished once the person answers. */
  private readonly pausedTurns = new Map<string, string>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  /** Names of the variables each session's account set, so the harness can see which account a chat used. */
  private readonly accountEnv = new Map<string, string[]>();

  async startSession(input: {
    threadId: ThreadId;
    cwd: string;
    account?: ProviderAccount;
    resumeSessionId?: string;
  }): Promise<ProviderSession> {
    const session: ProviderSession = {
      threadId: input.threadId,
      provider: this.provider,
      cwd: input.cwd,
      status: "idle",
      providerSessionId: input.resumeSessionId ?? `mock-${randomUUID()}`,
    };
    this.sessions.set(input.threadId, session);
    this.turns.set(input.threadId, []);
    this.accountEnv.set(input.threadId, Object.keys(input.account?.env ?? {}).sort());
    return session;
  }

  async sendTurn(input: { threadId: ThreadId; text: string; model?: string }): Promise<{ turnId: string }> {
    const session = this.context(input.threadId);
    const turnId = randomUUID();
    session.status = "working";
    setTimeout(() => {
      if (!this.sessions.has(input.threadId)) return;
      if (input.text.includes("[hold]")) {
        this.emit({ type: "turn.started", threadId: input.threadId, turnId });
        return;
      }
      if (input.text.includes("[approval]")) {
        session.status = "waiting";
        this.pausedTurns.set(input.threadId, turnId);
        this.emit({
          type: "approval.requested",
          threadId: input.threadId,
          requestId: randomUUID(),
          payload: { title: "Mock provider approval", command: "echo integration-check" },
        });
        return;
      }
      // "[ask]" asks the way Claude Code and Codex do: several questions, each with picks and room for another answer.
      if (input.text.includes("[ask]")) {
        session.status = "waiting";
        this.pausedTurns.set(input.threadId, turnId);
        this.emit({
          type: "user-input.requested",
          threadId: input.threadId,
          requestId: randomUUID(),
          payload: {
            title: "A few questions before I start",
            questions: [
              {
                id: "auth",
                header: "Sign-in",
                question: "How should people sign in?",
                isOther: true,
                options: [
                  { label: "Email and password", description: "Simplest; we store hashed passwords." },
                  { label: "Magic link", description: "No passwords; a link arrives by email." },
                  { label: "GitHub OAuth", description: "One click for developers." },
                ],
              },
              {
                id: "session",
                header: "Sessions",
                question: "How long should a session last?",
                options: [
                  { label: "1 day", description: "Safer on shared computers." },
                  { label: "30 days", description: "Fewer sign-ins." },
                ],
              },
              { id: "notes", header: "Anything else", question: "Anything else I should know?" },
            ],
          },
        });
        return;
      }
      if (input.text.includes("[input]")) {
        session.status = "waiting";
        this.pausedTurns.set(input.threadId, turnId);
        this.emit({
          type: "user-input.requested",
          threadId: input.threadId,
          requestId: randomUUID(),
          payload: { title: "Mock provider input", fields: ["answer"] },
        });
        return;
      }
      this.emit({ type: "turn.started", threadId: input.threadId, turnId });
      // "[crash]" stands in for the agent's process dying mid-turn.
      if (input.text.includes("[crash]")) {
        this.sessions.delete(input.threadId);
        this.accountEnv.delete(input.threadId);
        this.emit({ type: "session.closed", threadId: input.threadId, reason: "The mock agent exited unexpectedly." });
        return;
      }
      // "[limit]" stands in for the plan's usage limit stopping the turn, with a reset two hours out.
      if (input.text.includes("[limit]")) {
        session.status = "failed";
        this.emit({
          type: "provider.error",
          threadId: input.threadId,
          message: "You've hit your limit · resets in 2h",
          usageLimit: { resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
        });
        return;
      }
      // "[steps]" plays a short turn with text between reads, an edit, and a command, each running for a moment.
      // "[plan]" adds the agent's todo list, updated as the steps finish.
      // Read from the person's own words, the last paragraph: context put before them can quote earlier tags.
      const own = input.text.split("\n\n").at(-1) ?? input.text;
      // "[showcase]" plays one turn with every kind of step the chat can show, spaced out so each live state is seen.
      if (own.includes("[showcase]")) {
        this.playShowcase(input.threadId, turnId);
        return;
      }
      if (own.includes("[steps]") || own.includes("[plan]")) {
        this.playSteps(input.threadId, turnId, own.includes("[slow]") ? 1_500 : 150, own.includes("[plan]"));
        return;
      }
      // "[write notes.md]" writes that file in the worktree, standing in for an agent's edit.
      const write = /\[write (\w[\w.-]*)\]/u.exec(input.text)?.[1];
      if (write) {
        try {
          writeFileSync(join(session.cwd, write), `Written by the mock agent: ${input.text}\n`);
        } catch {
          // The harness only checks the reply when the folder cannot be written.
        }
      }
      // "[reads]" stands in for an agent looking around: several file reads, then one command.
      if (input.text.includes("[reads]")) {
        for (const file of ["src/app.ts", "src/routes.ts", "package.json"]) {
          this.emit({
            type: "activity",
            threadId: input.threadId,
            turnId,
            activity: {
              activityId: randomUUID(),
              kind: "file-read",
              title: `Read ${file}`,
              status: "completed",
              files: [file],
            },
          });
        }
        this.emit({
          type: "activity",
          threadId: input.threadId,
          turnId,
          activity: { activityId: randomUUID(), kind: "command", title: "npm test", status: "completed" },
        });
      }
      this.emit({ type: "assistant.delta", threadId: input.threadId, turnId, text: `Mock response: ${input.text}` });
      if (input.text.includes("[account]")) {
        const names = this.accountEnv.get(input.threadId) ?? [];
        this.emit({
          type: "assistant.delta",
          threadId: input.threadId,
          turnId,
          text: `\n\nAccount environment: ${names.length > 0 ? names.join(", ") : "none"}`,
        });
      }
      if (input.text.includes("[html]")) {
        this.emit({
          type: "assistant.delta",
          threadId: input.threadId,
          turnId,
          text: '\n\n```html\n<!doctype html>\n<html><body><h1 style="color:#2563eb">Mock card</h1></body></html>\n```\n',
        });
      }
      if (input.text.includes("[usage]")) {
        this.emit({
          type: "usage",
          threadId: input.threadId,
          turnId,
          usage: {
            inputTokens: 12_400,
            cachedInputTokens: 8_000,
            outputTokens: 1_250,
            costUsd: 0.042,
            contextTokens: 13_650,
            contextWindow: 200_000,
          },
        });
      }
      this.emit({ type: "turn.completed", threadId: input.threadId, turnId, status: "completed" });
      session.status = "idle";
    }, 5);
    return { turnId };
  }

  async interruptTurn(input: { threadId: ThreadId; turnId?: string }): Promise<void> {
    this.context(input.threadId).status = "idle";
  }

  async respondToRequest(input: { threadId: ThreadId; requestId: string; decision: unknown }): Promise<void> {
    this.finishPausedTurn(input.threadId);
  }

  async respondToUserInput(input: {
    threadId: ThreadId;
    requestId: string;
    answers: Record<string, string>;
  }): Promise<void> {
    this.finishPausedTurn(input.threadId);
  }

  async stopSession(input: { threadId: ThreadId }): Promise<void> {
    this.context(input.threadId);
    this.sessions.delete(input.threadId);
    this.accountEnv.delete(input.threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return [...this.sessions.values()];
  }

  hasSession(input: { threadId: ThreadId }): boolean {
    return this.sessions.has(input.threadId);
  }

  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    return { threadId: input.threadId, turns: this.turns.get(input.threadId) ?? [] };
  }

  async rollbackThread(input: {
    threadId: ThreadId;
    numTurns: number;
  }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    this.context(input.threadId);
    const turns = this.turns.get(input.threadId) ?? [];
    turns.splice(Math.max(0, turns.length - input.numTurns));
    return { threadId: input.threadId, turns };
  }

  async stopAll(): Promise<void> {
    this.sessions.clear();
    this.turns.clear();
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private context(threadId: ThreadId): ProviderSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`Mock provider session does not exist: ${threadId}`);
    return session;
  }

  private finishPausedTurn(threadId: ThreadId): void {
    const session = this.context(threadId);
    const turnId = this.pausedTurns.get(threadId);
    this.pausedTurns.delete(threadId);
    session.status = "idle";
    if (!turnId) return;
    setTimeout(() => {
      if (!this.sessions.has(threadId)) return;
      this.emit({ type: "turn.completed", threadId, turnId, status: "completed" });
    }, 5);
  }

  private playSteps(threadId: ThreadId, turnId: string, pause: number, withPlan = false): void {
    const activity = (
      activityId: string,
      status: "running" | "completed",
      fields: Omit<Extract<ProviderEvent, { type: "activity" }>["activity"], "activityId" | "status">,
    ): ProviderEvent => ({ type: "activity", threadId, turnId, activity: { activityId, status, ...fields } });
    const read = (file: string) => ({ kind: "file-read" as const, title: `Read ${file}`, files: [file] });
    const search = { kind: "search" as const, title: "Search TODO" };
    const edit = {
      kind: "file-edit" as const,
      title: "Edit src/routes.ts",
      files: ["src/routes.ts"],
      lines: { added: 4, removed: 1 },
    };
    const test = { kind: "command" as const, title: "Run the tests", command: "npm test" };
    const text = (value: string): ProviderEvent => ({ type: "assistant.delta", threadId, turnId, text: value });
    const stepNames = ["Read the routes", "Find where empty input is skipped", "Fix the route", "Run the tests"];
    const plan = (done: number): ProviderEvent[] =>
      withPlan
        ? [
            activity("plan", "completed", {
              kind: "tool",
              title: `Plan: ${done} of ${stepNames.length} done`,
              todos: stepNames.map((name, index) => ({
                text: name,
                status: index < done ? "completed" : index === done ? "in_progress" : "pending",
              })),
            }),
          ]
        : [];
    const script: ProviderEvent[][] = [
      [...plan(0)],
      [text("I'll look at the routes first.")],
      [activity("read-1", "running", read("src/app.ts"))],
      [activity("read-1", "completed", read("src/app.ts")), activity("read-2", "running", read("src/routes.ts"))],
      [activity("read-2", "completed", read("src/routes.ts")), ...plan(1), activity("search-1", "running", search)],
      [
        activity("search-1", "completed", search),
        ...plan(2),
        text("\n\nFound it. The route skips empty input, so I'll fix that."),
      ],
      [activity("edit-1", "running", edit)],
      [activity("edit-1", "completed", edit), ...plan(3), activity("test-1", "running", test)],
      [activity("test-1", "completed", { ...test, detail: "2 passed" }), ...plan(4)],
      [text("\n\nDone. The route now handles empty input and the tests pass.")],
      [{ type: "turn.completed", threadId, turnId, status: "completed" }],
    ];
    const prefix = `${turnId}:`;
    script.forEach((events, index) => {
      setTimeout(() => {
        if (!this.sessions.has(threadId)) return;
        for (const event of events) {
          if (event.type === "activity") {
            this.emit({ ...event, activity: { ...event.activity, activityId: prefix + event.activity.activityId } });
          } else this.emit(event);
        }
        if (index === script.length - 1) this.context(threadId).status = "idle";
      }, index * pause);
    });
  }

  /**
   * Thinking streamed in parts, a run of reads, a command with long output, a tool called with
   * arguments, a web search with its pages, a test run that fails with a stack trace, an edit, a reply
   * that cites one of the pages, and a context window most of the way full.
   */
  private playShowcase(threadId: ThreadId, turnId: string): void {
    type Fields = Omit<Extract<ProviderEvent, { type: "activity" }>["activity"], "activityId" | "status">;
    const prefix = `${turnId}:`;
    const activity = (id: string, status: "running" | "completed" | "failed", fields: Fields): ProviderEvent => ({
      type: "activity",
      threadId,
      turnId,
      activity: { activityId: prefix + id, status, ...fields },
    });
    const text = (value: string): ProviderEvent => ({ type: "assistant.delta", threadId, turnId, text: value });
    const think = (id: string, value: string): ProviderEvent => ({
      type: "reasoning.delta",
      threadId,
      turnId,
      reasoningId: prefix + id,
      text: value,
    });
    const thought = (id: string): ProviderEvent => ({
      type: "reasoning.completed",
      threadId,
      turnId,
      reasoningId: prefix + id,
    });
    const read = (file: string): Fields => ({ kind: "file-read", title: `Read ${file}`, files: [file] });
    const search: Fields = {
      kind: "search",
      title: "Search revalidate",
      input: [
        { key: "pattern", value: "revalidate(Tag|Path)" },
        { key: "path", value: "src" },
      ],
    };
    const build: Fields = { kind: "command", title: "Build the app", command: "npm run build" };
    const buildOutput = [
      "> app@1.4.0 build",
      "> next build",
      "",
      "   ▲ Next.js 15.0.3",
      "",
      "   Creating an optimized production build ...",
      " ✓ Compiled successfully",
      "   Linting and checking validity of types ...",
      "   Collecting page data ...",
      " ✓ Generating static pages (24/24)",
      "   Finalizing page optimization ...",
      "",
      "Route (app)                              Size     First Load JS",
      ...Array.from(
        { length: 22 },
        (_, index) =>
          `├ ○ /docs/page-${String(index + 1).padStart(2, "0")}                     ${(1.2 + index / 10).toFixed(1)} kB         ${(88 + index).toString()} kB`,
      ),
      "└ ○ /settings                             3.1 kB         102 kB",
      "+ First Load JS shared by all            84.2 kB",
      "  ├ chunks/framework-8e0e0f4a6b.js       45.2 kB",
      "  ├ chunks/main-app-c4a3e9e1b2.js        31.6 kB",
      "  └ other shared chunks (total)          7.4 kB",
      "",
      "○  (Static)  prerendered as static content",
    ].join("\n");
    const docs: Fields = {
      kind: "tool",
      title: "context7: get library docs",
      input: [
        { key: "libraryId", value: "/vercel/next.js" },
        { key: "topic", value: "revalidateTag and the data cache" },
        { key: "tokens", value: "5000" },
        {
          key: "filter",
          value: JSON.stringify(
            { sections: ["caching", "data-fetching", "route-handlers"], version: "15", includeExamples: true },
            null,
            2,
          ),
        },
      ],
    };
    const web: Fields = {
      kind: "web",
      title: "Search the web: next.js revalidateTag fetch cache",
      input: [{ key: "query", value: "next.js revalidateTag fetch cache" }],
    };
    const pages = [
      { url: "https://nextjs.org/docs/app/api-reference/functions/revalidateTag", title: "Functions: revalidateTag" },
      { url: "https://github.com/vercel/next.js/discussions/54075", title: "revalidateTag does not clear the cache" },
      { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching", title: "HTTP caching - MDN" },
    ];
    const test: Fields = { kind: "command", title: "Run the cache tests", command: "npm test -- cache" };
    const trace = [
      "FAIL src/lib/cache.test.ts",
      "TypeError: Cannot read properties of undefined (reading 'tags')",
      "    at revalidateAll (src/lib/cache.ts:42:18)",
      "    at Object.<anonymous> (src/lib/cache.test.ts:17:5)",
      "    at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)",
      "    at new Promise (<anonymous>)",
      "    at callAsyncCircusFn (node_modules/jest-circus/build/utils.js:231:10)",
      "    at _callCircusTest (node_modules/jest-circus/build/run.js:316:40)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    const edit: Fields = {
      kind: "file-edit",
      title: "Edit src/lib/cache.ts",
      files: ["src/lib/cache.ts"],
      lines: { added: 6, removed: 2 },
    };
    // Each entry waits its delay after the one before, so the whole turn takes about fourteen seconds.
    const script: Array<[delay: number, events: ProviderEvent[]]> = [
      [300, [think("think-1", "")]],
      [350, [think("think-1", "**Reading the request**\n\nThe person wants stale pages fixed after a deploy. ")]],
      [350, [think("think-1", "That points at the data cache: `revalidateTag` is called, but the fetch calls ")]],
      [
        350,
        [think("think-1", "may not be tagged.\n\n**Plan**\n\nRead the cache helpers, check how fetches are tagged, ")],
      ],
      [350, [think("think-1", "then build to see which routes are static.")]],
      [400, [think("think-1", " After that, look up whether `revalidateTag` clears tagged fetches in Next 15.")]],
      [300, [thought("think-1")]],
      [200, [text("I'll look at how the cache is wired first.")]],
      [300, [activity("read-1", "running", read("src/lib/cache.ts"))]],
      [
        500,
        [
          activity("read-1", "completed", read("src/lib/cache.ts")),
          activity("read-2", "running", read("src/app/api/revalidate/route.ts")),
        ],
      ],
      [
        500,
        [
          activity("read-2", "completed", read("src/app/api/revalidate/route.ts")),
          activity("search-1", "running", search),
        ],
      ],
      [
        600,
        [
          activity("search-1", "completed", {
            ...search,
            detail: "src/lib/cache.ts:40\nsrc/app/api/revalidate/route.ts:12",
          }),
        ],
      ],
      [300, [activity("build-1", "running", build)]],
      [1_800, [activity("build-1", "completed", { ...build, detail: buildOutput })]],
      [300, [activity("docs-1", "running", docs)]],
      [
        1_200,
        [
          activity("docs-1", "completed", {
            ...docs,
            detail:
              "revalidateTag(tag) purges every fetch tagged with `tag` from the Data Cache.\nFetches need `next: { tags: [...] }` to be tagged.",
          }),
        ],
      ],
      [300, [activity("web-1", "running", web)]],
      [1_100, [activity("web-1", "completed", { ...web, urls: pages })]],
      [300, [think("think-2", "The fetch in getPosts has no tags, so revalidateTag never reaches it. ")]],
      [500, [think("think-2", "Run the tests before changing anything.")]],
      [300, [thought("think-2")]],
      [200, [activity("test-1", "running", test)]],
      [1_400, [activity("test-1", "failed", { ...test, detail: trace })]],
      [300, [activity("edit-1", "running", edit)]],
      [700, [activity("edit-1", "completed", edit)]],
      [
        300,
        [
          text(
            "\n\nThe pages stayed stale because `getPosts` fetched without tags, so `revalidateTag('posts')` had nothing to purge. " +
              `I tagged the fetch in \`src/lib/cache.ts\`; [revalidateTag only clears tagged fetches](${pages[0]?.url}). ` +
              "The cache test still fails on an undefined `tags` field, which the next step fixes.",
          ),
        ],
      ],
      [
        200,
        [
          {
            type: "usage",
            threadId,
            turnId,
            usage: {
              inputTokens: 148_200,
              cachedInputTokens: 120_000,
              outputTokens: 3_400,
              costUsd: 0.61,
              contextTokens: 161_600,
              contextWindow: 200_000,
            },
          },
        ],
      ],
      [200, [{ type: "turn.completed", threadId, turnId, status: "completed" }]],
    ];
    let at = 0;
    script.forEach(([delay, events], index) => {
      at += delay;
      setTimeout(() => {
        if (!this.sessions.has(threadId)) return;
        for (const event of events) this.emit(event);
        if (index === script.length - 1) this.context(threadId).status = "idle";
      }, at);
    });
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
