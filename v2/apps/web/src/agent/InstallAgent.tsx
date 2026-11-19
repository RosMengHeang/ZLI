import { installCommand, installPage, type ListedProviderKind } from "@zli-v2/contracts";
import { createContext, useContext, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { installPlatform } from "../welcome/welcome.js";
import "./installAgent.css";

/** Opens a terminal tile that runs the install command. Resolves to a message when it could not start. */
export type RunInstall = (provider: ListedProviderKind, command: string) => Promise<string | undefined>;

/** Given by the shell, which knows the worktree a terminal can open in. Without it only the command shows. */
export const AgentInstallContext = createContext<RunInstall | undefined>(undefined);

function isWindows(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

/**
 * The terminal that runs one install command where the person can watch it and stop it. PowerShell on
 * Windows because the documented commands use `irm | iex`; a login bash elsewhere so PATH matches theirs.
 */
export function installTerminalCommand(
  input: { command: string; title: string; worktreeId: string; cwd: string; sessionId: string },
  windows = isWindows(),
) {
  return {
    type: "terminal.create" as const,
    terminalId: makeCommandId(),
    worktreeId: input.worktreeId,
    cwd: input.cwd,
    title: input.title,
    cols: 120,
    rows: 32,
    sessionId: input.sessionId,
    ...(windows
      ? {
          shell: "powershell.exe",
          // npm installs as npm.ps1, which the default execution policy blocks.
          args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", input.command],
        }
      : { shell: "/bin/bash", args: ["-lc", input.command] }),
  };
}

/**
 * The install action for an agent that is not on this computer: a button that runs its documented
 * command after the person confirms it, or a link to its install page when there is no single command.
 */
export function InstallAgentButton({
  provider,
  name,
  size = "sm",
}: {
  provider: ListedProviderKind;
  name: string;
  size?: "xs" | "sm";
}) {
  const { bridge } = useRuntime();
  const run = useContext(AgentInstallContext);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const platform = installPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const command = installCommand(provider, platform);
  const page = command ? undefined : installPage(provider);

  if (page) {
    return (
      <span className="install-agent">
        <Button size={size} onClick={() => void openExternalLink(bridge, page).then((failed) => setProblem(failed))}>
          Open install page
        </Button>
        {problem ? <span className="install-agent-problem">{problem}</span> : null}
      </span>
    );
  }
  if (!command || !run) return null;

  const start = async () => {
    setStarting(true);
    const failed = await run(provider, command);
    setStarting(false);
    setProblem(failed);
    if (!failed) setConfirming(false);
  };

  return (
    <span className="install-agent">
      <Button size={size} onClick={() => setConfirming(true)}>
        Install
      </Button>
      {problem && !confirming ? <span className="install-agent-problem">{problem}</span> : null}
      {confirming ? (
        <Dialog
          label={`Install ${name}`}
          size="sm"
          title={`Install ${name}?`}
          subtitle="This runs in a terminal tile, so you can watch it and stop it. ZLI checks for the agent again when it finishes."
          scrimLabel="Cancel"
          showClose={false}
          stacked
          initialFocusRef={cancelRef}
          onClose={() => setConfirming(false)}
        >
          <div className="dialog-body">
            <pre className="install-agent-command">
              <code>{command}</code>
            </pre>
            {problem ? (
              <p className="inline-error" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
          <div className="dialog-footer">
            <Button ref={cancelRef} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={starting} onClick={() => void start()}>
              {starting ? "Starting…" : "Run install"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </span>
  );
}
