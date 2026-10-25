import type { MobileAndroidStatus, MobileSetupPlan, MobileSetupProgress, MobileSetupStatus } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import {
  accelerationProblem,
  androidNeedsInstall,
  errorText,
  formatBytes,
  planDownload,
  progressPercent,
} from "./mobile.js";

const ACCELERATION_ITEM = "Hardware acceleration for the emulator";

/** What this computer has for Android and iOS, and the guided Android install when something is missing. */
export function MobileSetup({
  mobile,
  status,
  onRecheck,
}: {
  mobile: MobileBridge;
  status: MobileSetupStatus;
  /** Reads the status again. recheckAcceleration also reruns the emulator's acceleration check. */
  onRecheck(options?: { recheckAcceleration?: boolean }): Promise<void>;
}) {
  const [rechecking, setRechecking] = useState(false);
  const recheck = async (options?: { recheckAcceleration?: boolean }) => {
    setRechecking(true);
    try {
      await onRecheck(options);
    } finally {
      setRechecking(false);
    }
  };
  const acceleration = accelerationProblem(status.android);

  return (
    <div className="mobile-setup">
      <section className="mobile-setup-section" aria-labelledby="mobile-setup-android">
        <h3 id="mobile-setup-android" className="mobile-setup-title">
          Android
        </h3>
        {acceleration ? (
          <div className="banner banner-warning" role="alert">
            <Icon name="alert" size={14} />
            <span className="banner-message">{acceleration}</span>
            <div className="banner-actions">
              <Button size="xs" loading={rechecking} onClick={() => void recheck({ recheckAcceleration: true })}>
                Check again
              </Button>
            </div>
          </div>
        ) : null}
        {androidNeedsInstall(status.android) ? (
          <AndroidInstall mobile={mobile} android={status.android} onFinished={() => void recheck()} />
        ) : (
          <p className="mobile-setup-ready">
            <Icon name="check" size={13} />
            {status.android.avds.length === 1
              ? `Ready, with the virtual device ${status.android.avds[0]}.`
              : `Ready, with ${status.android.avds.length} virtual devices.`}
          </p>
        )}
      </section>
      <section className="mobile-setup-section" aria-labelledby="mobile-setup-ios">
        <h3 id="mobile-setup-ios" className="mobile-setup-title">
          iOS
        </h3>
        {!status.ios.supported ? (
          <p className="mobile-setup-text">
            The iOS Simulator runs only on a Mac with Xcode. Open ZLI on a Mac to use iPhone simulators.
          </p>
        ) : status.ios.missing.length > 0 ? (
          <>
            <p className="mobile-setup-text">Install these, then check again:</p>
            <ul className="mobile-setup-list">
              {status.ios.missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Button size="sm" icon="reload" loading={rechecking} onClick={() => void recheck()}>
              Check again
            </Button>
          </>
        ) : (
          <p className="mobile-setup-ready">
            <Icon name="check" size={13} />
            Ready. Simulators from Xcode appear in the device list.
          </p>
        )}
      </section>
    </div>
  );
}

function AndroidInstall({
  mobile,
  android,
  onFinished,
}: {
  mobile: MobileBridge;
  android: MobileAndroidStatus;
  onFinished(): void;
}) {
  const [progress, setProgress] = useState<MobileSetupProgress>();
  const progressRef = useRef<MobileSetupProgress | undefined>(undefined);
  const [plan, setPlan] = useState<MobileSetupPlan>();
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string>();
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    const show = (next: MobileSetupProgress) => {
      progressRef.current = next;
      setProgress(next);
    };
    const unsubscribe = mobile.onSetupProgress((next) => {
      if (!disposed) show(next);
    });
    // Setup keeps running when the panel closes, so reopening it picks up where the install is.
    mobile
      .setupProgress()
      .then((next) => {
        if (!disposed && !progressRef.current) show(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [mobile]);

  const review = async () => {
    setPlanning(true);
    setError(undefined);
    try {
      const next = await mobile.setupPlan();
      setPlan(next);
      setAccepted(new Set());
    } catch (cause) {
      setError(errorText(cause, "ZLI could not work out what to download. Check the internet connection."));
    } finally {
      setPlanning(false);
    }
  };

  const install = async () => {
    if (!plan) return;
    setError(undefined);
    const starting: MobileSetupProgress = { state: "running", message: "Starting the install" };
    progressRef.current = starting;
    setProgress(starting);
    try {
      await mobile.runSetup([...accepted]);
      setPlan(undefined);
    } catch (cause) {
      const ended = progressRef.current?.state;
      // A failed or cancelled run already reported its reason through progress.
      if (ended !== "failed" && ended !== "cancelled") {
        const idle: MobileSetupProgress = { state: "idle", message: "" };
        progressRef.current = idle;
        setProgress(idle);
        setError(errorText(cause, "Android setup could not start."));
      }
    } finally {
      onFinished();
    }
  };

  if (progress?.state === "running") return <SetupProgress mobile={mobile} progress={progress} />;

  const ended =
    progress?.state === "failed" || progress?.state === "cancelled" ? (
      <div className={`banner ${progress.state === "failed" ? "banner-danger" : "banner-info"}`} role="alert">
        <Icon name="alert" size={14} />
        <span className="banner-message">
          {progress.state === "failed" ? `Setup stopped: ${progress.message}` : progress.message}
        </span>
      </div>
    ) : null;
  const errorBanner = error ? (
    <div className="banner banner-danger" role="alert">
      <Icon name="alert" size={14} />
      <span className="banner-message">{error}</span>
    </div>
  ) : null;

  if (!plan) {
    const missing = android.missing.filter((item) => item !== ACCELERATION_ITEM);
    return (
      <div className="mobile-setup-body">
        {ended}
        {errorBanner}
        <p className="mobile-setup-text">
          The Android emulator needs a few things this computer does not have yet. ZLI can download and install them for
          you, after showing what it will download and the licenses that come with it.
        </p>
        {missing.length > 0 ? (
          <ul className="mobile-setup-list">
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        <div className="mobile-setup-actions">
          <Button variant="primary" size="sm" icon="download" loading={planning} onClick={() => void review()}>
            {progress?.state === "failed" || progress?.state === "cancelled"
              ? "Review and try again"
              : "Review the install"}
          </Button>
        </div>
        <p className="mobile-setup-hint">
          Already have Android Studio? ZLI uses its SDK from ANDROID_HOME or the default install folder. Set it, restart
          ZLI, and this step goes away.
        </p>
      </div>
    );
  }

  if (plan.steps.length === 0)
    return (
      <div className="mobile-setup-body">
        <p className="mobile-setup-text">
          Nothing needs downloading. Everything the emulator needs is already in {plan.sdkRoot}.
        </p>
        <div className="mobile-setup-actions">
          <Button size="sm" icon="reload" onClick={onFinished}>
            Check again
          </Button>
        </div>
      </div>
    );

  const download = planDownload(plan);
  const allAccepted = plan.licenses.every((license) => accepted.has(license.id));
  return (
    <div className="mobile-setup-body">
      {errorBanner}
      <p className="mobile-setup-text">
        ZLI will install these into <code>{plan.sdkRoot}</code>
        {download.bytes > 0
          ? `, downloading ${download.partial ? "at least " : "about "}${formatBytes(download.bytes)}.`
          : "."}
      </p>
      <ul className="mobile-setup-steps">
        {plan.steps.map((step) => (
          <li key={step.id}>
            <span>{step.label}</span>
            {step.bytes !== undefined ? <span className="mobile-setup-size">{formatBytes(step.bytes)}</span> : null}
          </li>
        ))}
      </ul>
      <p className="mobile-setup-text">It then creates the virtual device {plan.avdName}.</p>
      {plan.licenses.map((license) => (
        <div className="mobile-license" key={license.id}>
          <details>
            <summary>Read the {license.title}</summary>
            <pre className="mobile-license-text">{license.text}</pre>
          </details>
          <label className="check-field mobile-license-accept">
            <input
              type="checkbox"
              checked={accepted.has(license.id)}
              onChange={(event) => {
                const checked = event.target.checked;
                setAccepted((current) => {
                  const next = new Set(current);
                  if (checked) next.add(license.id);
                  else next.delete(license.id);
                  return next;
                });
              }}
            />
            <span className="choice-copy">
              <span className="choice-title">I accept the {license.title}</span>
            </span>
          </label>
        </div>
      ))}
      <div className="mobile-setup-actions">
        <Button
          variant="primary"
          size="sm"
          icon="download"
          disabled={!allAccepted}
          tooltip={allAccepted ? undefined : "Accept each license first"}
          onClick={() => void install()}
        >
          Install
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setPlan(undefined)}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function SetupProgress({ mobile, progress }: { mobile: MobileBridge; progress: MobileSetupProgress }) {
  const [cancelling, setCancelling] = useState(false);
  const percent = progressPercent(progress);
  const bytes =
    progress.receivedBytes !== undefined && progress.totalBytes
      ? `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`
      : undefined;
  return (
    <div className="mobile-setup-body" role="status">
      <p className="mobile-setup-text">{progress.message || "Installing"}</p>
      <progress
        className="mobile-setup-progress"
        max={100}
        {...(percent === undefined ? {} : { value: percent })}
        aria-label="Install progress"
      />
      <p className="mobile-setup-hint">
        {bytes ?? (percent !== undefined ? `${Math.round(percent)}%` : "Working")}. You can close this panel; setup
        keeps going.
      </p>
      <div className="mobile-setup-actions">
        <Button
          size="sm"
          loading={cancelling}
          onClick={() => {
            setCancelling(true);
            void mobile.cancelSetup().finally(() => setCancelling(false));
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
