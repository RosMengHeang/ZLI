import { type MobileIosHostTestResult, MobileSshHost } from "@zli-v2/contracts";
import { useId, useState } from "react";

import { errorText, macName } from "../mobile/mobile.js";
import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { SettingsRow } from "./SettingsLayout.js";

type TestResult = MobileIosHostTestResult & { host: string };

/**
 * The Mac that runs iPhone simulators over SSH: its address, Test connection, and a way to go back to this
 * computer. ZLI uses the person's SSH key, so there is no password field.
 */
export function RemoteMacRows({
  mobile,
  saved,
  macHere,
  problem,
  save,
  onSaved,
}: {
  mobile: Pick<MobileBridge, "testIosHost">;
  /** The saved address, "" for none, or undefined while settings load. */
  saved: string | undefined;
  /** This computer is a Mac, so it runs simulators itself when no address is set. */
  macHere: boolean;
  /** Why the saved Mac's simulators are unavailable, from the last status check. */
  problem: string | undefined;
  save(host: string): Promise<void>;
  onSaved(): void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult>();

  const value = draft ?? saved ?? "";
  const address = value.trim();
  const parsed = address ? MobileSshHost.safeParse(address) : undefined;
  const invalid = parsed && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const dirty = saved !== undefined && address !== saved;
  const shownResult = result?.host === address ? result : undefined;

  const store = async (next: string) => {
    if (saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await save(next);
      setDraft(undefined);
      onSaved();
    } catch (cause) {
      setSaveError(errorText(cause, "ZLI could not save the Mac's address."));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!mobile.testIosHost || !address || invalid || testing) return;
    setTesting(true);
    try {
      setResult({ host: address, ...(await mobile.testIosHost(address)) });
    } catch (cause) {
      setResult({ host: address, ok: false, message: errorText(cause, "The connection test did not finish.") });
    } finally {
      setTesting(false);
    }
  };

  const description =
    invalid ??
    saveError ??
    (saved && !dirty
      ? `ZLI runs iPhone simulators on ${macName(saved)} over SSH.${macHere ? " Clear the address to use this Mac's simulators." : ""}`
      : macHere
        ? "To use the simulators on another Mac, enter its SSH address. ZLI signs in with your SSH key and never stores a password."
        : "Use the simulators on a Mac you own. ZLI signs in over SSH with your SSH key and never stores a password.");
  const connection = shownResult?.message ?? (!dirty ? problem : undefined);

  return (
    <>
      <SettingsRow
        label="Mac for iPhone simulators"
        htmlFor={inputId}
        description={description}
        descriptionTone={invalid || saveError ? "warning" : undefined}
      >
        <div className="setting-inline">
          <input
            id={inputId}
            className="input is-mono"
            placeholder="you@mac-mini.local"
            value={value}
            maxLength={253}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            disabled={saved === undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaveError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !dirty || invalid) return;
              event.preventDefault();
              void store(address);
            }}
          />
          {dirty ? (
            <Button size="sm" loading={saving} disabled={Boolean(invalid)} onClick={() => void store(address)}>
              Save
            </Button>
          ) : saved ? (
            <IconButton
              label="Clear the Mac"
              tooltip={macHere ? "Use this Mac's simulators again" : "Stop using this Mac"}
              icon="x"
              size="sm"
              disabled={saving}
              onClick={() => void store("")}
            />
          ) : null}
        </div>
      </SettingsRow>
      {address ? (
        <SettingsRow
          label="Connection"
          description={
            connection ? <span role="status">{connection}</span> : "Signs in to the Mac and counts its simulators."
          }
          descriptionTone={connection && !shownResult?.ok ? "warning" : undefined}
        >
          <Button
            size="sm"
            icon="reload"
            loading={testing}
            disabled={Boolean(invalid) || !mobile.testIosHost}
            onClick={() => void test()}
          >
            Test connection
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}
