import type { ChildProcess } from "node:child_process";

import { type AccountSignIn, BACKGROUND_SIGN_IN, type ListedProviderKind } from "@zli-v2/contracts";
import { spawnCli } from "@zli-v2/shared";

import { signInStatus } from "./accountEnv.js";

/** How each agent starts its browser sign-in. Grok asks for its browser login over its device code. */
const LOGIN_ARGS: Partial<Record<ListedProviderKind, readonly string[]>> = {
  codex: ["login"],
  "claude-code": ["auth", "login", "--claudeai"],
  "cursor-agent": ["login"],
  grok: ["login", "--oauth"],
  kimi: ["login"],
  copilot: ["login"],
};

/** Long enough to sign in from a password manager or another browser. */
const SIGN_IN_TIMEOUT_MS = 600_000;
/** Some logins keep running after the credentials land; this long after, ZLI ends them. */
const AFTER_CREDENTIALS_MS = 3_000;
const CREDENTIALS_POLL_MS = 1_000;
const MAX_OUTPUT = 8_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal color codes start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The sign-in page in a login's output: the first full https link that is not the login's own local page. */
export function signInUrl(output: string): string | undefined {
  const plain = output.replace(ANSI, "");
  // Trailing whitespace shows the link has arrived whole rather than split across two chunks.
  for (const match of plain.matchAll(/(https:\/\/[^\s"'<>]+)\s/gu)) {
    try {
      const url = new URL(match[1] ?? "");
      if (!LOCAL_HOSTS.has(url.hostname)) return url.toString();
    } catch {
      // Not a link; keep looking.
    }
  }
  return undefined;
}

/** A one-time code such as ABCD-1234 that the person enters on the sign-in page. */
export function signInCode(output: string): string | undefined {
  const plain = output.replace(ANSI, "").replace(/https?:\/\/\S+/gu, " ");
  return /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)\b/u.exec(plain)?.[1];
}

type Session = {
  state: AccountSignIn;
  child: ChildProcess | undefined;
  stop(): void;
};

export type AccountSignInsOptions = {
  /** The agent CLI's path, or undefined when it is not installed. */
  resolveCli(provider: ListedProviderKind): Promise<string | undefined>;
  /** The account's provider, environment, and folder, or an error message. */
  resolveAccount(
    accountId: string,
  ): Promise<{ provider: ListedProviderKind; env: Record<string, string>; dir: string }>;
  /** Called when a sign-in finishes, so account and plan readings can refresh. */
  onDone?(accountId: string): void;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnCli;
  timeoutMs?: number;
};

/**
 * Runs an agent's own login with the account's folder, hidden, and reports the page it opens, so Sign in
 * goes straight to the browser instead of a terminal. One sign-in runs per account at a time.
 */
export class AccountSignIns {
  private readonly sessions = new Map<string, Session>();
  /** Starts for one account run one after another, so two quick clicks never leave a login nobody tracks. */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** Bumped by every start and cancel: a start that finishes after a newer one, or a cancel, stops its login. */
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(private readonly options: AccountSignInsOptions) {}

  /** Undefined when this agent signs in only in a terminal. */
  async start(accountId: string): Promise<AccountSignIn | undefined> {
    const generation = this.bump(accountId);
    const previous = this.starting.get(accountId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.launch(accountId, generation));
    this.starting.set(accountId, next);
    try {
      return await next;
    } finally {
      if (this.starting.get(accountId) === next) this.starting.delete(accountId);
    }
  }

  private async launch(accountId: string, generation: number): Promise<AccountSignIn | undefined> {
    const account = await this.options.resolveAccount(accountId);
    const kind = BACKGROUND_SIGN_IN[account.provider];
    const args = LOGIN_ARGS[account.provider];
    if (!kind || !args) return undefined;
    this.sessions.get(accountId)?.stop();
    const file = await this.options.resolveCli(account.provider);
    const opensBrowser = kind === "browser";
    const state: AccountSignIn = { accountId, state: "waiting", opensBrowser };
    if (!file) {
      return this.remember(accountId, {
        ...state,
        state: "failed",
        message: "This agent is not installed. Install it, then sign in again.",
      });
    }
    const before = await signInStatus(account.provider, account.dir);
    let output = "";
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? spawnCli)(file, args, {
        env: { ...(this.options.env ?? process.env), ...account.env },
        cwd: account.dir,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return this.remember(accountId, {
        ...state,
        state: "failed",
        message: error instanceof Error ? error.message : "The sign-in did not start.",
      });
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let poll: ReturnType<typeof setInterval> | undefined;
    let credentialsLanded = false;
    const session: Session = {
      state,
      child,
      stop: () => {
        if (session.state.state !== "waiting") return;
        finish({ state: "cancelled" });
        child.kill();
      },
    };
    const finish = (patch: Partial<AccountSignIn>) => {
      if (session.state.state !== "waiting") return;
      session.state = { ...session.state, ...patch };
      for (const timer of timers) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (session.state.state === "done") this.options.onDone?.(accountId);
    };
    const read = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT);
      if (session.state.state !== "waiting") return;
      const url = session.state.url ?? signInUrl(output);
      const code = session.state.code ?? (kind === "code" ? signInCode(output) : undefined);
      session.state = { ...session.state, ...(url ? { url } : {}), ...(code ? { code } : {}) };
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => finish({ state: "failed", message: error.message }));
    child.on("close", (code) => {
      if (code === 0 || credentialsLanded) {
        finish({ state: "done" });
        return;
      }
      const said = output.replace(ANSI, "").trim().split(/\r?\n/u).slice(-4).join("\n").trim();
      finish({ state: "failed", message: said || `The sign-in stopped (exit code ${code ?? "unknown"}).` });
    });
    timers.push(
      setTimeout(() => {
        finish({ state: "failed", message: "The sign-in took too long. Try again." });
        child.kill();
      }, this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS),
    );
    // Codex and others can keep running once the credentials are written; ZLI ends them after a moment.
    if (before !== "signed-in") {
      poll = setInterval(() => {
        void signInStatus(account.provider, account.dir).then((now) => {
          if (now !== "signed-in" || credentialsLanded || session.state.state !== "waiting") return;
          credentialsLanded = true;
          if (poll) clearInterval(poll);
          timers.push(
            setTimeout(() => {
              finish({ state: "done" });
              child.kill();
            }, AFTER_CREDENTIALS_MS),
          );
        });
      }, CREDENTIALS_POLL_MS);
    }
    this.sessions.set(accountId, session);
    // Cancelled, or asked again, while it was starting: this login is not wanted any more.
    if (this.disposed || this.generations.get(accountId) !== generation) session.stop();
    return session.state;
  }

  private bump(accountId: string): number {
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    return generation;
  }

  status(accountId: string): AccountSignIn | undefined {
    return this.sessions.get(accountId)?.state;
  }

  cancel(accountId: string): AccountSignIn | undefined {
    this.bump(accountId);
    this.sessions.get(accountId)?.stop();
    return this.status(accountId);
  }

  /** Ends every running sign-in, as when ZLI quits. */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) session.stop();
  }

  private remember(accountId: string, state: AccountSignIn): AccountSignIn {
    this.sessions.set(accountId, { state, child: undefined, stop: () => undefined });
    return state;
  }
}
