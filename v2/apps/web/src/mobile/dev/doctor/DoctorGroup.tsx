import type { MobileDoctorDeep, MobileDoctorDeepPlan, MobileFinding, MobileProjectFacts } from "@zli-v2/contracts";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { Badge, type BadgeTone } from "../../../ui/Badge.js";
import { Button } from "../../../ui/Button.js";
import { LoadingState } from "../../../ui/Pane.js";
import { errorText } from "../../mobile.js";
import type { MobileDevContext } from "../context.js";
import "./doctor.css";

const PROJECT_VERSIONS: readonly [string, string][] = [
  ["expo", "Expo SDK"],
  ["react-native", "React Native"],
  ["flutter", "Flutter"],
  ["dart", "Dart"],
  ["gradle", "Gradle"],
  ["agp", "Android Gradle Plugin"],
  ["kotlin", "Kotlin"],
];

const HOST_TOOLS: readonly [string, string][] = [
  ["node", "Node.js"],
  ["java", "Java"],
  ["adb", "adb"],
  ["xcode", "Xcode"],
  ["cocoapods", "CocoaPods"],
];

const SEVERITY: Record<MobileFinding["severity"], { tone: BadgeTone; label: string }> = {
  error: { tone: "danger", label: "Error" },
  warning: { tone: "warning", label: "Warning" },
  info: { tone: "quiet", label: "Note" },
};

/** The Toolchain group of the project check: versions, findings with fixes to propose, Expo checks, and agent notes. */
export function DoctorGroup({ context }: { context: MobileDevContext }) {
  const doctor = context.mobile.dev?.doctor;
  const proposals = context.mobile.dev?.proposals;
  const { worktreeId } = context;
  const titleId = useId();
  const [facts, setFacts] = useState<MobileProjectFacts>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      if (!doctor || !worktreeId) return;
      const current = ++request.current;
      setLoading(true);
      setError(undefined);
      try {
        const next = await doctor.check(worktreeId, refresh ? { refresh } : {});
        if (current === request.current) setFacts(next);
      } catch (cause) {
        if (current === request.current) setError(errorText(cause, "ZLI could not check this project."));
      } finally {
        if (current === request.current) setLoading(false);
      }
    },
    [doctor, worktreeId],
  );

  useEffect(() => {
    setFacts(undefined);
    void load();
  }, [load]);

  // A written notes block or a finished fix changes what the doctor sees, so check again quietly.
  useEffect(() => {
    if (!proposals || !worktreeId) return;
    const seen = new Set<string>();
    return proposals.onChange((list) => {
      const written = list.filter(
        (proposal) =>
          proposal.worktreeId === worktreeId && proposal.state === "written" && !seen.has(proposal.proposalId),
      );
      for (const proposal of written) seen.add(proposal.proposalId);
      if (written.length > 0) void load();
    });
  }, [proposals, worktreeId, load]);

  if (!doctor || !worktreeId) return null;
  return (
    <section className="mobile-setup-section mobile-doctor" aria-labelledby={titleId}>
      <div className="mobile-doctor-head">
        <h3 id={titleId} className="mobile-setup-title">
          Toolchain
        </h3>
        {facts ? (
          <Button size="xs" variant="ghost" icon="reload" loading={loading} onClick={() => void load(true)}>
            Check again
          </Button>
        ) : null}
      </div>
      {!facts && loading ? <LoadingState label="Checking this project" /> : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {facts?.stack === "none" ? (
        <p className="mobile-setup-text">
          No mobile app found in this worktree. ZLI looks for Expo, React Native, Flutter, Android, and Xcode projects.
        </p>
      ) : facts ? (
        <Facts facts={facts} context={context} worktreeId={worktreeId} onChanged={() => void load()} />
      ) : null}
    </section>
  );
}

function Facts({
  facts,
  context,
  worktreeId,
  onChanged,
}: {
  facts: MobileProjectFacts;
  context: MobileDevContext;
  worktreeId: string;
  onChanged(): void;
}) {
  const host = facts.host ?? {};
  return (
    <>
      <ul className="mobile-doctor-rows" aria-label="Versions">
        {facts.appDir !== "." ? <Row label="App folder" value={<code>{facts.appDir}</code>} /> : null}
        {PROJECT_VERSIONS.filter(([key]) => facts.versions[key]).map(([key, label]) => (
          <Row key={key} label={label} value={<code>{facts.versions[key]}</code>} />
        ))}
        {HOST_TOOLS.filter(([key]) => host[key] !== undefined).map(([key, label]) => (
          <Row key={key} label={label} value={<HostValue value={host[key] as string} />} />
        ))}
        {facts.client && facts.client.kind !== "unknown" ? (
          <Row label="Runs in" value={clientLabel(facts.client.kind)} description={facts.client.reason} />
        ) : null}
        {facts.newArch?.enabled !== undefined ? (
          <Row
            label="New Architecture"
            value={facts.newArch.enabled ? "On" : "Off"}
            description={facts.newArch.source}
          />
        ) : null}
        {facts.signing ? <Row label="Signing" description={signingText(facts.signing)} /> : null}
      </ul>
      {facts.findings.length > 0 ? (
        <ul className="mobile-doctor-findings" aria-label="Problems">
          {facts.findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} context={context} worktreeId={worktreeId} />
          ))}
        </ul>
      ) : (
        <p className="mobile-setup-hint">ZLI found no known problems.</p>
      )}
      <ul className="mobile-doctor-rows">
        {facts.stack === "expo" ? (
          <ExpoChecks context={context} worktreeId={worktreeId} last={facts.deep} onFinished={onChanged} />
        ) : null}
        <AgentNotes context={context} worktreeId={worktreeId} facts={facts} />
      </ul>
    </>
  );
}

function Row({
  label,
  value,
  description,
  children,
}: {
  label: string;
  value?: ReactNode;
  description?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="mobile-doctor-row">
      <div className="mobile-doctor-copy">
        <span className="mobile-doctor-label">{label}</span>
        {description ? <span className="mobile-doctor-detail">{description}</span> : null}
        {children}
      </div>
      {value !== undefined ? <div className="mobile-doctor-value">{value}</div> : null}
    </li>
  );
}

function HostValue({ value }: { value: string }) {
  if (value === "not found") return <Badge tone="quiet">Not found</Badge>;
  if (value === "not checked") return <Badge tone="quiet">Not checked on this computer</Badge>;
  return <code>{value}</code>;
}

/** One finding with its badge. Propose fix only creates a proposal card; the person runs it from there. */
export function FindingRow({
  finding,
  context,
  worktreeId,
}: {
  finding: MobileFinding;
  context: MobileDevContext;
  worktreeId: string;
}) {
  const doctor = context.mobile.dev?.doctor;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const severity = SEVERITY[finding.severity];
  const propose = async () => {
    if (!doctor || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await doctor.proposeFix(worktreeId, finding.id);
      context.onNotice("The fix is waiting at the top of the panel. Nothing runs until you choose Run in terminal.");
    } catch (cause) {
      setError(errorText(cause, "ZLI could not propose this fix."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="mobile-doctor-finding">
      <Badge tone={severity.tone}>{severity.label}</Badge>
      <div className="mobile-doctor-copy">
        <span className="mobile-doctor-label">{finding.title}</span>
        <span className="mobile-doctor-detail">{finding.detail}</span>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {finding.fix && doctor ? (
        <Button size="xs" loading={busy} aria-label={`Propose fix: ${finding.title}`} onClick={() => void propose()}>
          Propose fix
        </Button>
      ) : null}
    </li>
  );
}

const STEP_LABELS = {
  expoConfig: "expo config",
  expoInstallCheck: "expo install --check",
  expoDoctor: "expo-doctor",
} as const;
const STEP_STATES: Record<string, { tone: BadgeTone; label: string }> = {
  passed: { tone: "success", label: "Passed" },
  failed: { tone: "danger", label: "Failed" },
  "not-installed": { tone: "quiet", label: "Not installed in this project" },
  "timed-out": { tone: "warning", label: "Timed out" },
};

/** Run Expo checks shows the exact lines first, and runs them only after Run. */
function ExpoChecks({
  context,
  worktreeId,
  last,
  onFinished,
}: {
  context: MobileDevContext;
  worktreeId: string;
  last: MobileDoctorDeep | undefined;
  onFinished(): void;
}) {
  const doctor = context.mobile.dev?.doctor;
  const [plan, setPlan] = useState<MobileDoctorDeepPlan>();
  const [busy, setBusy] = useState<"plan" | "run">();
  const [result, setResult] = useState<MobileDoctorDeep>();
  const [error, setError] = useState<string>();
  const shown = result ?? last;
  if (!doctor) return null;

  const showPlan = async () => {
    setBusy("plan");
    setError(undefined);
    try {
      setPlan(await doctor.deepPlan(worktreeId));
    } catch (cause) {
      setError(errorText(cause, "ZLI could not prepare the Expo checks."));
    } finally {
      setBusy(undefined);
    }
  };
  const run = async () => {
    setBusy("run");
    setError(undefined);
    try {
      setResult(await doctor.deepRun(worktreeId));
      setPlan(undefined);
      onFinished();
    } catch (cause) {
      setError(errorText(cause, "The Expo checks did not run."));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Row
      label="Expo checks"
      description="Runs expo config, expo install --check, and expo-doctor from this project. They run the project's own code."
      value={
        plan ? undefined : (
          <Button size="xs" variant="ghost" loading={busy === "plan"} onClick={() => void showPlan()}>
            Run Expo checks
          </Button>
        )
      }
    >
      {plan ? (
        <div className="mobile-doctor-plan">
          <pre className="mobile-proposal-well">
            <code>{plan.commands.join("\n")}</code>
          </pre>
          <p className="mobile-doctor-detail">
            Runs in {plan.folder === "." ? "the worktree folder" : plan.folder}. This can take a minute.
          </p>
          <div className="mobile-setup-actions">
            <Button size="xs" variant="primary" loading={busy === "run"} onClick={() => void run()}>
              Run
            </Button>
            <Button size="xs" variant="ghost" disabled={busy === "run"} onClick={() => setPlan(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {shown && !plan ? (
        <ul className="mobile-doctor-steps" aria-label="Expo check results">
          {(Object.keys(STEP_LABELS) as (keyof typeof STEP_LABELS)[]).map((key) => {
            const step = shown[key];
            if (!step) return null;
            const state = STEP_STATES[step.state] ?? { tone: "quiet" as const, label: step.state };
            const lines =
              key === "expoInstallCheck" && "packages" in step && step.packages.length > 0
                ? step.packages.join("\n")
                : key === "expoDoctor" && "failures" in step && step.failures.length > 0
                  ? step.failures.join("\n")
                  : step.state === "failed"
                    ? step.detail
                    : undefined;
            return (
              <li key={key}>
                <div className="mobile-doctor-step">
                  <code>{STEP_LABELS[key]}</code>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>
                {lines ? (
                  <pre className="mobile-proposal-well">
                    <code>{lines}</code>
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Row>
  );
}

/** Prepare notes creates the AGENTS.md block proposal; the card above does the writing. */
function AgentNotes({
  context,
  worktreeId,
  facts,
}: {
  context: MobileDevContext;
  worktreeId: string;
  facts: MobileProjectFacts;
}) {
  const doctor = context.mobile.dev?.doctor;
  const [busy, setBusy] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setUpToDate(facts.notes?.state === "current"), [facts.notes?.state]);
  if (!doctor) return null;
  const file = facts.notes?.file ?? "AGENTS.md";
  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await doctor.proposeBlock(worktreeId);
      setUpToDate(result.upToDate);
      if (!result.upToDate)
        context.onNotice(
          `The change to ${result.file} is waiting at the top of the panel. Nothing is written until you choose Write.`,
        );
    } catch (cause) {
      setError(errorText(cause, "ZLI could not prepare the notes."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Agent notes"
      description={`Adds what agents need to know to ${file}, between zli:mobile markers. You see the change before anything is written.`}
      value={
        <div className="mobile-doctor-actions">
          {upToDate ? <Badge tone="quiet">Up to date</Badge> : null}
          <Button size="xs" variant="ghost" loading={busy} onClick={() => void prepare()}>
            Prepare notes
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </Row>
  );
}

function clientLabel(kind: NonNullable<MobileProjectFacts["client"]>["kind"]): string {
  switch (kind) {
    case "dev-build":
      return "Development build";
    case "expo-go":
      return "Expo Go";
    default:
      return "Native project";
  }
}

export function signingText(signing: NonNullable<MobileProjectFacts["signing"]>): string {
  const android = {
    "debug-only": "Android: debug key only.",
    "release-config": "Android: a release signing config in the Gradle build.",
    eas: "Android: signed by EAS Build.",
    unknown: "Android: not known.",
  }[signing.android];
  const ios =
    signing.ios === "not-checked"
      ? "iPhone: not checked on this computer."
      : `iPhone: ${signing.ios.identities} signing ${signing.ios.identities === 1 ? "identity" : "identities"}.`;
  return `${android} ${ios}`;
}
