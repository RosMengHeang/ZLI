import { crashReportText, type MobileCrashReport, shortCrashTitle } from "@zli-v2/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button, IconButton } from "../../../ui/Button.js";
import { Icon } from "../../../ui/Icon.js";
import { errorText } from "../../mobile.js";
import type { MobileDevContext } from "../context.js";
import { copyText, useWorktreeAgent } from "./useWorktreeAgent.js";
import "./crash.css";

const NO_AGENT = "No chat agent works in this worktree";
const HOLDER_NO_AGENT = "The agent holding this device has no chat to take the report";

/** The text Send to agent and Copy report hand over: the crash, its frames, and the log before it. */
export function crashCardText(report: MobileCrashReport): string {
  return `${crashReportText(report)}\n\nCaught by ZLI from the device log.`;
}

/** The newest crash on the shown device that the person has not dismissed, with Send to agent. */
export function CrashBanner({ context }: { context: MobileDevContext }) {
  const crash = context.mobile.dev?.crash;
  const deviceId = context.device?.deviceId;
  const [reports, setReports] = useState<readonly MobileCrashReport[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  // The crash belongs to whoever holds the device, so Send goes to that agent, not the panel's worktree.
  // An agent's lease owner id is "agent:<worktreeId>".
  const lease = context.device?.lease;
  const holderWorktreeId =
    lease?.kind === "agent" && lease.ownerId.startsWith("agent:") ? lease.ownerId.slice("agent:".length) : undefined;
  const agent = useWorktreeAgent(holderWorktreeId ?? context.worktreeId);
  const noAgent =
    holderWorktreeId !== undefined && holderWorktreeId !== context.worktreeId ? HOLDER_NO_AGENT : NO_AGENT;
  const detailsId = useId();
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;

  useEffect(() => {
    setReports([]);
    if (!crash || !deviceId) return;
    let current = true;
    const unsubscribe = crash.onChange((event) => {
      if (current && event.deviceId === deviceId) setReports(event.reports);
    });
    crash.list(deviceId).then(
      (next) => {
        if (current) setReports(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [crash, deviceId]);

  const report = reports.find((entry) => !entry.dismissed);
  const crashId = report?.crashId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new crash starts folded.
  useEffect(() => setExpanded(false), [crashId]);
  if (!crash || !deviceId || !report) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      if (await agent.send(crashCardText(report))) context.onNotice(`Sent to the agent in ${agent.name}`);
      else context.onError(noAgent);
    } catch (cause) {
      context.onError(errorText(cause, "ZLI could not send the crash to the agent."));
    } finally {
      setSending(false);
    }
  };
  const dismiss = () => {
    const forDevice = deviceId;
    crash.dismiss(forDevice, report.crashId).then(
      // The answer names the device the person dismissed on; after a switch it must not overwrite the new one.
      (next) => {
        if (deviceRef.current === forDevice) setReports(next);
      },
      (cause: unknown) => {
        context.onError(errorText(cause, "ZLI could not dismiss the crash."));
      },
    );
  };
  const details = [
    ...report.frames.map((frame) => `  ${frame.trim()}`),
    ...(report.frames.length > 0 ? [""] : []),
    ...report.tail,
  ];

  return (
    <section className="banner banner-danger mobile-crash" aria-label="App crash">
      <Icon name="alert" size={14} />
      <span className="banner-message">
        {report.appId ?? "The app"} crashed: {shortCrashTitle(report.title)}
        {report.count > 1 ? <span className="mobile-crash-count"> ×{report.count}</span> : null}
      </span>
      <div className="banner-actions">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Hide details" : "Show details"}
        </Button>
        <Button
          size="xs"
          disabled={!agent.available}
          loading={sending}
          tooltip={agent.available ? undefined : noAgent}
          onClick={() => void send()}
        >
          Send to agent
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => copyText(crashCardText(report), "Copied the crash report.", context.onNotice, context.onError)}
        >
          Copy report
        </Button>
        <IconButton icon="x" size="xs" iconSize={12} label="Dismiss crash" onClick={dismiss} />
      </div>
      {expanded ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the well scrolls, and keyboard users need to reach it.
        <pre className="mobile-crash-well" id={detailsId} tabIndex={0}>
          {details.join("\n")}
        </pre>
      ) : null}
    </section>
  );
}
