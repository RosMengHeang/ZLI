import { type GitBranchesResult, type ReviewProjection, RuntimeProjection } from "@zli-v2/contracts";
import type { RemoteCloseInfo, RemoteSession, RemoteTransport } from "@zli-v2/remote-protocol";

import { ids, sampleProjection } from "./fixtures.js";
import type { StoredPairing } from "./pairingRecord.js";

/** A pairing with keys the demo desktop never checks. */
export const demoPairing: StoredPairing = {
  v: 1,
  desktopName: "Studio",
  hosts: ["192.168.1.20"],
  port: 47321,
  desktopKey: "A".repeat(43),
  deviceId: `${"B".repeat(21)}A`,
  credential: `${"C".repeat(42)}A`,
  phoneSecret: `${"D".repeat(42)}A`,
  deviceName: "Demo phone",
  lastHost: "192.168.1.20",
  pairedAt: "2026-10-28T09:30:00.000Z",
};

const TERMINAL_TEXT = [
  "~/dev/app-worktrees/feature-login $ pnpm test",
  "",
  " RUN  v4.1.12 /home/dev/app",
  "",
  " ✓ src/auth/session.test.ts (6 tests) 41ms",
  " ✓ src/auth/LoginForm.test.tsx (9 tests) 212ms",
  " ✓ src/api/client.test.ts (4 tests) 18ms",
  "",
  " Test Files  3 passed (3)",
  "      Tests  19 passed (19)",
  "   Duration  1.34s",
  "",
  "~/dev/app-worktrees/feature-login $ git status --short",
  " M src/auth/LoginForm.tsx",
  " M src/auth/session.ts",
  "?? src/auth/LoginForm.test.tsx",
  "~/dev/app-worktrees/feature-login $ ",
].join("\n");

const LOGIN_FORM_PATCH = [
  "diff --git a/src/auth/LoginForm.tsx b/src/auth/LoginForm.tsx",
  "--- a/src/auth/LoginForm.tsx",
  "+++ b/src/auth/LoginForm.tsx",
  "@@ -9,22 +9,17 @@ export function LoginForm({ onSubmit }: LoginFormProps) {",
  '   const [email, setEmail] = useState("");',
  '   const [password, setPassword] = useState("");',
  "-  const [pending, setPending] = useState(false);",
  "+  const pending = useRef(false);",
  " ",
  "-  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {",
  '-    if (event.key === "Enter") {',
  "-      event.preventDefault();",
  "-      void submit();",
  "-    }",
  "-  };",
  "-",
  "   const submit = async () => {",
  "+    if (pending.current) return;",
  "+    pending.current = true;",
  "     await onSubmit({ email, password });",
  "+    pending.current = false;",
  "   };",
  " ",
  "   return (",
  "-    <form onSubmit={submit} onKeyDown={handleKeyDown}>",
  "+    <form",
  "+      onSubmit={(event) => {",
  "+        event.preventDefault();",
  "+        void submit();",
  "+      }}",
  "+    >",
  "",
].join("\n");

const SESSION_PATCH = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -21,7 +21,8 @@ export async function signIn(credentials: Credentials): Promise<Session> {",
  '   const response = await client.post("/session", credentials);',
  "-  return response.json();",
  "+  const session: Session = await response.json();",
  "+  return session;",
  " }",
  " ",
  " export function signOut(): Promise<void> {",
  "",
].join("\n");

const LOGIN_TEST_PATCH = [
  "diff --git a/src/auth/LoginForm.test.tsx b/src/auth/LoginForm.test.tsx",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/auth/LoginForm.test.tsx",
  "@@ -0,0 +1,14 @@",
  '+import { fireEvent, render, screen } from "@testing-library/react";',
  '+import { expect, it, vi } from "vitest";',
  "+",
  '+import { LoginForm } from "./LoginForm.js";',
  "+",
  '+it("sends one request when Enter is pressed", async () => {',
  "+  const onSubmit = vi.fn().mockResolvedValue(undefined);",
  "+  render(<LoginForm onSubmit={onSubmit} />);",
  '+  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dev@example.com" } });',
  '+  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });',
  '+  fireEvent.submit(screen.getByRole("form"));',
  "+",
  "+  expect(onSubmit).toHaveBeenCalledTimes(1);",
  "+});",
  "",
].join("\n");

/** The feature worktree's uncommitted changes, by path. */
const DEMO_PATCHES: Record<string, { kind: "modified" | "untracked"; patch: string }> = {
  "src/auth/LoginForm.tsx": { kind: "modified", patch: LOGIN_FORM_PATCH },
  "src/auth/session.ts": { kind: "modified", patch: SESSION_PATCH },
  "src/auth/LoginForm.test.tsx": { kind: "untracked", patch: LOGIN_TEST_PATCH },
};

function lineCounts(patch: string): { additions: number; deletions: number } {
  const lines = patch.split("\n").filter((line) => !line.startsWith("+++") && !line.startsWith("---"));
  return {
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
  };
}

function demoReview() {
  return {
    worktreeId: ids.feature,
    baseRef: "HEAD",
    branch: "feature/login",
    state: "changes",
    files: Object.entries(DEMO_PATCHES).map(([path, { kind, patch }]) => ({
      path,
      kind,
      staged: false,
      unstaged: true,
      binary: false,
      ...lineCounts(patch),
    })),
    conflictFiles: [],
    updatedAt: "2026-10-28T09:40:00.000Z",
  };
}

/** The sample projection with names and conversations, as the screenshots show it. */
export function demoProjection(): RuntimeProjection {
  const base = sampleProjection();
  const names: Record<string, string> = {
    [ids.working]: "Fix the login form",
    [ids.waiting]: "Clean the build output",
    [ids.stopped]: "Update the README",
  };
  return RuntimeProjection.parse({
    ...base,
    threads: base.threads.map((thread) => ({ ...thread, name: names[thread.threadId] })),
    reviews: [demoReview()],
    messages: [
      {
        messageId: "m1",
        threadId: ids.working,
        role: "user",
        text: "The login form submits twice when you press Enter. Fix it and add a test.",
      },
      {
        messageId: "m2",
        threadId: ids.working,
        role: "assistant",
        text: "Found it: the form has both an onSubmit handler and an onKeyDown handler that calls submit. I removed the key handler and kept the native submit.",
      },
      {
        messageId: "m3",
        threadId: ids.working,
        role: "assistant",
        turnId: ids.turn,
        text: "Added a test that presses Enter once and checks that one request goes out. Running the tests now.",
      },
      {
        messageId: "m4",
        threadId: ids.waiting,
        role: "user",
        text: "The build folder has stale files from the old bundler. Clean it up.",
      },
      {
        messageId: "m5",
        threadId: ids.waiting,
        role: "assistant",
        text: "The build folder only holds generated output, so I can delete it and rebuild.",
      },
      { messageId: "m6", threadId: ids.stopped, role: "user", text: "Update the README install steps." },
      { messageId: "m7", threadId: ids.stopped, role: "assistant", text: "Done. The install section now uses pnpm." },
    ],
  });
}

type Command = {
  type: string;
  threadId?: string;
  requestId?: string;
  terminalId?: string;
  worktreeId?: string;
  path?: string;
};

/** Git state the projection does not carry: commits made in the demo that are not pushed yet. */
type DemoGit = { ahead: number };

function demoBranches(git: DemoGit): GitBranchesResult {
  return {
    current: "feature/login",
    defaultBranch: "main",
    local: ["main", "feature/login"],
    remote: ["main", "feature/login"],
    details: { "feature/login": { upstream: { name: "origin/feature/login", ahead: git.ahead, behind: 0 } } },
  };
}

/** Each new review needs a newer time than the last one, since the app waits for exactly that. */
function nextReviews(projection: RuntimeProjection, worktreeId: string | undefined, change: Partial<ReviewProjection>) {
  return (projection.reviews ?? []).map((review) =>
    review.worktreeId === worktreeId
      ? { ...review, ...change, updatedAt: new Date(Date.parse(review.updatedAt) + 1_000).toISOString() }
      : review,
  );
}

/** What a command does to the demo projection, and the result it answers with. */
function apply(
  projection: RuntimeProjection,
  command: Command,
  git: DemoGit,
): { next?: RuntimeProjection; result?: unknown } {
  switch (command.type) {
    case "review.refresh":
      return { next: { ...projection, reviews: nextReviews(projection, command.worktreeId, {}) } };
    case "review.git.branches":
      return { result: demoBranches(git) };
    case "review.commit":
      git.ahead += 1;
      return {
        next: { ...projection, reviews: nextReviews(projection, command.worktreeId, { files: [], state: "clean" }) },
      };
    case "review.pr.push":
      git.ahead = 0;
      return { result: { branch: "feature/login", remote: "origin" } };
    case "files.diff": {
      const review = projection.reviews?.find((candidate) => candidate.worktreeId === command.worktreeId);
      const listed = review?.files.some((file) => file.path === command.path);
      const patch = listed && command.path ? (DEMO_PATCHES[command.path]?.patch ?? "") : "";
      return { result: { path: command.path, binary: false, patch, truncated: false } };
    }
    case "thread.respond":
      return {
        next: {
          ...projection,
          requests: (projection.requests ?? []).filter((request) => request.requestId !== command.requestId),
        },
      };
    case "thread.stop": {
      const { threadId } = command;
      return {
        next: {
          ...projection,
          threads: projection.threads.map((thread) =>
            thread.threadId === threadId ? { ...thread, status: "stopped", activeTurnId: undefined } : thread,
          ),
          requests: (projection.requests ?? []).filter((request) => request.threadId !== threadId),
        },
      };
    }
    case "terminal.read":
      return { result: { terminalId: command.terminalId, text: TERMINAL_TEXT, truncated: false } };
    default:
      return {};
  }
}

/**
 * A desktop inside the app, for screenshots and trying the app without one. It answers the runtime
 * handshake with the demo projection, accepts every command, and plays out answers and stops so the
 * live status reacts to its buttons.
 */
export async function openDemoSession(): Promise<RemoteSession> {
  let projection = demoProjection();
  const git: DemoGit = { ahead: 0 };
  let closed = false;
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<(info: RemoteCloseInfo) => void>();
  const emit = (message: unknown) =>
    queueMicrotask(() => {
      if (closed) return;
      for (const listener of messageListeners) listener(message);
    });

  const transport: RemoteTransport = {
    send(input) {
      const message = input as { type: string; request?: { commandId: string; command: Command } };
      switch (message.type) {
        case "hello":
          emit({ type: "hello", protocolVersion: 1, environment: projection.environment });
          return;
        case "subscribe":
        case "projection.get":
          emit({ type: "projection", projection });
          return;
        case "terminal.attach":
          emit({
            type: "terminal.snapshot",
            snapshot: { terminalId: ids.shell, chunks: [], nextSequence: 4, truncated: false },
          });
          return;
        case "command": {
          if (!message.request) return;
          const { next, result } = apply(projection, message.request.command, git);
          emit({ type: "response", response: { commandId: message.request.commandId, accepted: true, result } });
          if (next) {
            projection = RuntimeProjection.parse({ ...next, lastSequence: projection.lastSequence + 1 });
            emit({ type: "projection", projection });
          }
          return;
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener({ failure: "network", code: 1000 });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };

  return {
    transport,
    ready: {
      type: "gateway.ready",
      desktopName: demoPairing.desktopName,
      environmentId: projection.environment.environmentId,
      hosts: demoPairing.hosts,
      port: demoPairing.port,
    },
  };
}
