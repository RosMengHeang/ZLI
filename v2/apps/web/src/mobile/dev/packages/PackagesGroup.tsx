import { type MobilePackageCheck, type MobilePackageVerdict, NPM_PACKAGE_NAME } from "@zli-v2/contracts";
import { type FormEvent, useId, useState } from "react";

import { Badge, type BadgeTone } from "../../../ui/Badge.js";
import { Button } from "../../../ui/Button.js";
import { Field } from "../../../ui/Field.js";
import { errorText } from "../../mobile.js";
import type { MobileDevContext } from "../context.js";
import "./packages.css";

const MAX_PACKAGES = 20;

const VERDICTS: Record<MobilePackageVerdict["verdict"], { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Fine" },
  warn: { tone: "warning", label: "Warning" },
  block: { tone: "danger", label: "Blocked" },
  unchecked: { tone: "quiet", label: "Not checked" },
};

/** Splits what the person typed into package names, or says which one is not a package name. */
export function parsePackages(text: string): { names: string[] } | { problem: string } {
  const names = [...new Set(text.split(/[\s,]+/u).filter(Boolean))];
  const bad = names.find((name) => !NPM_PACKAGE_NAME.test(name));
  if (bad) return { problem: `${bad} is not an npm package name.` };
  if (names.length > MAX_PACKAGES) return { problem: `Check at most ${MAX_PACKAGES} packages at a time.` };
  return { names };
}

/** The Packages group: check names against React Native Directory, then propose the install command. */
export function PackagesGroup({ context }: { context: MobileDevContext }) {
  const packages = context.mobile.dev?.packages;
  const { worktreeId } = context;
  const titleId = useId();
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState<{ names: string[]; result: MobilePackageCheck }>();
  const [busy, setBusy] = useState<"check" | "propose">();
  const [error, setError] = useState<string>();
  if (!packages || !worktreeId) return null;

  const parsed = parsePackages(value);
  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || "problem" in parsed || parsed.names.length === 0) return;
    setBusy("check");
    setError(undefined);
    try {
      setChecked({ names: parsed.names, result: await packages.check(worktreeId, parsed.names) });
    } catch (cause) {
      setError(errorText(cause, "ZLI could not check these packages."));
    } finally {
      setBusy(undefined);
    }
  };
  const propose = async () => {
    if (!checked || busy) return;
    setBusy("propose");
    setError(undefined);
    try {
      await packages.proposeInstall(worktreeId, checked.names);
      context.onNotice(
        "The install command is waiting at the top of the panel. Nothing runs until you choose Run in terminal.",
      );
    } catch (cause) {
      setError(errorText(cause, "ZLI could not propose the install."));
    } finally {
      setBusy(undefined);
    }
  };

  const allBlocked = checked?.result.verdicts.every((verdict) => verdict.verdict === "block") ?? false;
  return (
    <section className="mobile-setup-section mobile-packages" aria-labelledby={titleId}>
      <h3 id={titleId} className="mobile-setup-title">
        Packages
      </h3>
      <form className="mobile-packages-form" onSubmit={(event) => void check(event)}>
        <Field
          label="Check packages"
          {...("problem" in parsed && value.trim()
            ? { hint: parsed.problem, hintTone: "warning" as const }
            : { hint: "Names separated by spaces, such as react-native-mmkv expo-camera." })}
        >
          <input
            className="input is-mono"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            maxLength={2_000}
            aria-invalid={"problem" in parsed && value.trim() ? true : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          loading={busy === "check"}
          disabled={"problem" in parsed || parsed.names.length === 0}
        >
          Check
        </Button>
      </form>
      {checked ? (
        <>
          <ul className="mobile-doctor-findings" aria-label="Package results">
            {checked.result.verdicts.map((verdict) => {
              const shown = VERDICTS[verdict.verdict];
              return (
                <li key={verdict.name} className="mobile-doctor-finding">
                  <Badge tone={shown.tone}>{shown.label}</Badge>
                  <div className="mobile-doctor-copy">
                    <code className="mobile-doctor-label">{verdict.name}</code>
                    {verdict.reasons.map((reason) => (
                      <span key={reason} className="mobile-doctor-detail">
                        {reason}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {checked.result.command ? (
            <pre className="mobile-proposal-well">
              <code>{checked.result.command}</code>
            </pre>
          ) : null}
          {checked.result.install || allBlocked ? (
            <div className="mobile-setup-actions">
              <Button
                size="sm"
                loading={busy === "propose"}
                disabled={!checked.result.install}
                tooltip={checked.result.install ? undefined : "Every package was blocked"}
                onClick={() => void propose()}
              >
                Propose install
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
