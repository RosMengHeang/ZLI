import type { MobileDevice, MobileSetupStatus } from "@zli-v2/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { Switch } from "../ui/Switch.js";
import { DeviceScreen } from "./DeviceScreen.js";
import { MobileControls } from "./MobileControls.js";
import { MobileLogsDrawer } from "./MobileLogsDrawer.js";
import { MobileSetup } from "./MobileSetup.js";
import { MobileToolbar } from "./MobileToolbar.js";
import {
  accelerationProblem,
  androidNeedsInstall,
  deviceKindLabel,
  errorText,
  formatElapsed,
  leaseNotice,
  pickDevice,
  type ScreenMode,
  SLOW_BOOT_MS,
  screenshotBlob,
  slowBootNote,
} from "./mobile.js";
import { useClock } from "./useClock.js";
import { useDeviceZoom } from "./useDeviceZoom.js";
import { useMobileSettings } from "./useMobileSettings.js";
import { useNotice } from "./useNotice.js";
import "./mobile.css";

/** A device an agent booted or drove, which the pane should show once it is in the list. */
export type MobileReveal = { deviceId: string; key: number };

const SELECTED_KEY = "zli.mobile.device.v1";
/** How often the agent lease banner rechecks its countdown. */
const LEASE_TICK_MS = 15_000;

type Busy = "boot" | "shutdown" | "lease" | "screenshot";

const CLIPBOARD_IMAGE_ERROR = "ZLI could not put the image on the clipboard. Save the screenshot instead.";

export function MobilePane({ reveal }: { reveal?: MobileReveal | undefined }) {
  const { bridge } = useRuntime();
  const mobile = bridge?.mobile;
  if (!mobile)
    return (
      <div className="tool-pane mobile-pane">
        <PaneHeader icon="smartphone" title="Mobile" />
        <EmptyState
          icon="smartphone"
          title="Devices need the desktop app"
          detail="Emulators and simulators run on your computer. Open this workspace in the ZLI desktop app to boot and drive them."
        />
      </div>
    );
  return <MobilePaneBody mobile={mobile} reveal={reveal} />;
}

function MobilePaneBody({ mobile, reveal }: { mobile: MobileBridge; reveal: MobileReveal | undefined }) {
  const [devices, setDevices] = useState<MobileDevice[]>();
  const [devicesError, setDevicesError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<MobileSetupStatus>();
  const [statusError, setStatusError] = useState<string>();
  const { settings, error: settingsError, setAgentTools } = useMobileSettings(mobile);
  const [selectedId, setSelectedIdState] = useState<string | undefined>(() => readSelected());
  /** Setup is open, and why: from the wrench, or to add a virtual device. */
  const [setupFor, setSetupFor] = useState<"setup" | "new-device">();
  const showSetup = setupFor !== undefined;
  /** Actions still running. A set, because cancelling a boot overlaps the boot it stops. */
  const [busy, setBusy] = useState<ReadonlySet<Busy>>(() => new Set());
  const [actionError, setActionError] = useState<string>();
  const [notice, showNotice] = useNotice();
  const takeOverRef = useRef<HTMLButtonElement>(null);
  const [screenMode, setScreenMode] = useState<ScreenMode>();
  /** When each device was first seen booting, so the elapsed time survives re-renders and device switches. */
  const bootStartsRef = useRef(new Map<string, number>());
  /** Devices the person cancelled, whose boot call then fails on purpose. */
  const cancelledRef = useRef(new Set<string>());

  const setSelectedId = useCallback((deviceId: string) => {
    setSelectedIdState(deviceId);
    setActionError(undefined);
    try {
      window.localStorage.setItem(SELECTED_KEY, deviceId);
    } catch {
      // Without storage the pane falls back to a running device next time.
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    setRefreshing(true);
    try {
      setDevices(await mobile.devices());
      setDevicesError(undefined);
    } catch (cause) {
      setDevicesError(errorText(cause, "The device list could not be read."));
    } finally {
      setRefreshing(false);
    }
  }, [mobile]);

  const refreshStatus = useCallback(
    async (options?: { recheckAcceleration?: boolean }) => {
      try {
        setStatus(await mobile.status(options));
        setStatusError(undefined);
      } catch (cause) {
        setStatusError(errorText(cause, "ZLI could not check what is installed."));
      }
    },
    [mobile],
  );

  useEffect(() => {
    const unsubscribe = mobile.onDevices((next) => {
      setDevices(next);
      setDevicesError(undefined);
    });
    void refreshDevices();
    void refreshStatus();
    return unsubscribe;
  }, [mobile, refreshDevices, refreshStatus]);

  const revealKey = reveal?.key;
  const revealId = reveal?.deviceId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each reveal key selects its device once.
  useEffect(() => {
    if (revealId) {
      setSelectedId(revealId);
      setSetupFor(undefined);
    }
  }, [revealKey]);

  useEffect(() => {
    const booting = new Set(
      devices?.filter((candidate) => candidate.state === "booting").map(({ deviceId }) => deviceId),
    );
    for (const deviceId of bootStartsRef.current.keys())
      if (!booting.has(deviceId)) bootStartsRef.current.delete(deviceId);
  }, [devices]);

  const device = devices ? pickDevice(devices, selectedId) : undefined;
  const agentLeaseEnds = device?.lease?.kind === "agent" && device.lease.expiresAt !== undefined;
  const now = useClock(device?.state === "booting" ? 1_000 : agentLeaseEnds ? LEASE_TICK_MS : undefined);
  let bootElapsed: number | undefined;
  if (device?.state === "booting") {
    const starts = bootStartsRef.current;
    if (!starts.has(device.deviceId)) starts.set(device.deviceId, Date.now());
    bootElapsed = Math.max(0, now - (starts.get(device.deviceId) ?? now));
  }
  const lease = device ? leaseNotice(device, { now }) : undefined;
  const agentHolds = lease?.kind === "agent";
  const needsAndroid = status ? androidNeedsInstall(status.android) : false;
  const acceleration = status ? accelerationProblem(status.android) : undefined;

  const [zoom, setZoom] = useDeviceZoom(device?.deviceId);

  const run = async (kind: Busy, operation: () => Promise<unknown>, fallback: string) => {
    setBusy((current) => new Set(current).add(kind));
    setActionError(undefined);
    try {
      await operation();
    } catch (cause) {
      setActionError(errorText(cause, fallback));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(kind);
        return next;
      });
    }
  };

  const nudgeTakeOver = useCallback(() => takeOverRef.current?.focus(), []);

  const bootDevice = (target: MobileDevice) =>
    void run(
      "boot",
      async () => {
        cancelledRef.current.delete(target.deviceId);
        try {
          await mobile.boot(target.deviceId);
        } catch (cause) {
          if (!cancelledRef.current.has(target.deviceId)) throw cause;
        } finally {
          cancelledRef.current.delete(target.deviceId);
        }
      },
      `${target.name} did not boot.`,
    );

  const cancelBoot = (target: MobileDevice) => {
    cancelledRef.current.add(target.deviceId);
    void run(
      "shutdown",
      async () => {
        try {
          await mobile.shutdown(target.deviceId);
        } catch (cause) {
          cancelledRef.current.delete(target.deviceId);
          throw cause;
        }
      },
      `${target.name} could not be stopped.`,
    );
  };

  const saveScreenshot = (target: MobileDevice) =>
    run(
      "screenshot",
      async () => {
        const shot = await mobile.screenshot(target.deviceId);
        const link = document.createElement("a");
        link.href = `data:${shot.mimeType};base64,${shot.data}`;
        link.download = `${fileSafe(target.name)}-${fileStamp(new Date())}.png`;
        link.click();
        showNotice(`Saved ${link.download}`);
      },
      "The screenshot could not be taken.",
    );

  const copyScreenshot = (target: MobileDevice) =>
    run(
      "screenshot",
      async () => {
        if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error(CLIPBOARD_IMAGE_ERROR);
        const image = mobile.screenshot(target.deviceId).then(screenshotBlob);
        // The clipboard takes writes only right after a click, so the write starts now and waits for the image.
        const written = navigator.clipboard.write([new ClipboardItem({ "image/png": image })]).then(
          () => true,
          () => false,
        );
        await image;
        if (!(await written)) throw new Error(CLIPBOARD_IMAGE_ERROR);
        showNotice("Copied the screenshot.");
      },
      "The screenshot could not be copied.",
    );

  const setupView = (
    <div className="mobile-scroll">
      {statusError ? (
        <EmptyState icon="alert" tone="danger" title="Setup could not be checked" detail={statusError}>
          <Button size="sm" icon="reload" onClick={() => void refreshStatus()}>
            Try again
          </Button>
        </EmptyState>
      ) : status ? (
        <MobileSetup
          mobile={mobile}
          status={status}
          noDevices={devices?.length === 0}
          addingDevice={setupFor === "new-device"}
          onRecheck={refreshStatus}
        />
      ) : (
        <LoadingState label="Checking what is installed" />
      )}
    </div>
  );

  let body: ReactNode;
  if (!devices && devicesError)
    body = (
      <EmptyState icon="alert" tone="danger" title="Devices could not be listed" detail={devicesError}>
        <Button size="sm" icon="reload" loading={refreshing} onClick={() => void refreshDevices()}>
          Try again
        </Button>
      </EmptyState>
    );
  else if (!devices) body = <LoadingState label="Looking for devices" />;
  else if (showSetup) body = setupView;
  else if (!device)
    body =
      status && !needsAndroid ? (
        <EmptyState
          icon="smartphone"
          title="No devices found"
          detail={
            <>
              The Android SDK and its virtual devices are installed, but none are listed. Refresh to look again, or
              connect an Android phone with USB debugging turned on.
              <span className="mobile-empty-note">
                {status.android.sdkRoot ? `ZLI uses the SDK in ${status.android.sdkRoot}. ` : null}To use another SDK,
                set ANDROID_HOME and restart ZLI.
              </span>
            </>
          }
        >
          <Button size="sm" icon="reload" loading={refreshing} onClick={() => void refreshDevices()}>
            Refresh
          </Button>
        </EmptyState>
      ) : (
        setupView
      );
  else body = deviceBody(device);

  function deviceBody(shown: MobileDevice): ReactNode {
    if (shown.state === "online")
      return (
        <DeviceScreen
          key={shown.deviceId}
          mobile={mobile}
          device={shown}
          inputBlocked={agentHolds}
          onBlockedInput={nudgeTakeOver}
          onModeChange={setScreenMode}
          zoom={zoom}
        />
      );
    if (shown.state === "booting")
      return (
        <EmptyState
          media={<span className="spinner" aria-hidden="true" />}
          title={`Booting ${shown.name}${bootElapsed === undefined ? "" : `, ${formatElapsed(bootElapsed)}`}`}
          detail={
            shown.kind === "physical" ? undefined : (
              <>
                The first boot of a new virtual device can take a few minutes.
                {bootElapsed !== undefined && bootElapsed >= SLOW_BOOT_MS ? (
                  <span className="mobile-empty-note">{slowBootNote(shown)}</span>
                ) : null}
              </>
            )
          }
        />
      );
    if (shown.state === "shutdown")
      return (
        <EmptyState
          icon="smartphone"
          title={`${shown.name} is off`}
          detail={
            shown.kind === "physical"
              ? "Turn the phone on and unlock it."
              : "Boot it to show its screen here. Agents can boot it too."
          }
        >
          {shown.kind === "physical" ? null : (
            <Button
              variant="primary"
              size="sm"
              icon="play"
              loading={busy.has("boot")}
              onClick={() => bootDevice(shown)}
            >
              Boot
            </Button>
          )}
        </EmptyState>
      );
    if (shown.state === "unauthorized")
      return (
        <EmptyState
          icon="shield"
          title="Allow USB debugging on the phone"
          detail="Unlock the phone and accept the prompt to trust this computer. The device appears here once it is allowed."
        >
          <Button size="sm" icon="reload" loading={refreshing} onClick={() => void refreshDevices()}>
            Refresh
          </Button>
        </EmptyState>
      );
    return (
      <EmptyState
        icon="alert"
        title={`${shown.name} is not responding`}
        detail="adb lists it as offline. Reconnect the cable, or restart the emulator, then refresh."
      >
        <Button size="sm" icon="reload" loading={refreshing} onClick={() => void refreshDevices()}>
          Refresh
        </Button>
      </EmptyState>
    );
  }

  const android = device?.platform === "android";
  const virtual = device ? device.kind !== "physical" : false;
  const online = device?.state === "online";

  return (
    <div className="tool-pane mobile-pane">
      <PaneHeader icon="smartphone" title="Mobile" detail={device && !showSetup ? deviceKindLabel(device) : undefined}>
        <IconButton
          icon="reload"
          size="sm"
          iconSize={14}
          label="Refresh devices"
          disabled={refreshing}
          onClick={() => {
            void refreshDevices();
            void refreshStatus();
          }}
        />
        <IconButton
          icon="wrench"
          size="sm"
          iconSize={14}
          label="Setup"
          tooltip={showSetup ? "Back to the device" : "Android and iOS setup"}
          pressed={showSetup}
          disabled={!devices}
          onClick={() => setSetupFor((current) => (current ? undefined : "setup"))}
        />
      </PaneHeader>
      {devices && !showSetup ? (
        <MobileToolbar
          devices={devices}
          device={device}
          bootElapsedMs={bootElapsed}
          screenMode={screenMode}
          zoom={zoom}
          onZoom={setZoom}
          booting={busy.has("boot")}
          stopping={busy.has("shutdown")}
          onSelect={setSelectedId}
          onNewDevice={() => setSetupFor("new-device")}
          onBoot={() => device && bootDevice(device)}
          onShutdown={() =>
            device && void run("shutdown", () => mobile.shutdown(device.deviceId), `${device.name} did not shut down.`)
          }
          onCancel={() => device && cancelBoot(device)}
        />
      ) : null}
      {!showSetup && devices && devices.length > 0 && needsAndroid && !devices.some(isAndroidVirtual) ? (
        <div className="banner banner-info">
          <Icon name="smartphone" size={14} />
          <span className="banner-message">The Android emulator is not set up on this computer.</span>
          <div className="banner-actions">
            <Button size="xs" onClick={() => setSetupFor("setup")}>
              Set it up
            </Button>
          </div>
        </div>
      ) : null}
      {!showSetup && device && android && virtual && acceleration ? (
        <div className="banner banner-warning">
          <Icon name="alert" size={14} />
          <span className="banner-message">{acceleration}</span>
        </div>
      ) : null}
      {!showSetup && device && lease ? (
        <div className={`banner ${lease.kind === "agent" ? "banner-warning" : "banner-info"}`} role="status">
          <Icon name={lease.kind === "agent" ? "bot" : "user"} size={14} />
          <span className="banner-message">{lease.text}</span>
          <div className="banner-actions">
            {lease.kind === "agent" ? (
              <Button
                ref={takeOverRef}
                size="xs"
                variant="primary"
                loading={busy.has("lease")}
                onClick={() =>
                  void run("lease", () => mobile.takeOver(device.deviceId), "ZLI could not give you control.")
                }
              >
                Take over
              </Button>
            ) : (
              <Button
                size="xs"
                loading={busy.has("lease")}
                onClick={() =>
                  void run("lease", () => mobile.release(device.deviceId), "ZLI could not hand the device back.")
                }
              >
                Hand back to agents
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {actionError && !showSetup ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{actionError}</span>
        </div>
      ) : null}
      <div className="mobile-notice" role="status">
        {notice && !showSetup ? (
          <div key={notice.key} className="banner banner-info">
            <Icon name="check" size={14} />
            <span className="banner-message">{notice.text}</span>
          </div>
        ) : null}
      </div>
      {devicesError && devices ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{devicesError}</span>
        </div>
      ) : null}
      <div className="mobile-body">{body}</div>
      {device && online && !showSetup ? (
        <MobileControls
          key={device.deviceId}
          mobile={mobile}
          device={device}
          inputBlocked={agentHolds}
          onBlockedInput={nudgeTakeOver}
          onError={setActionError}
          onNotice={showNotice}
          screenshotBusy={busy.has("screenshot")}
          onScreenshot={() => void saveScreenshot(device)}
          onCopyScreenshot={() => void copyScreenshot(device)}
        />
      ) : null}
      {device && online && !showSetup ? (
        <MobileLogsDrawer
          key={`logs-${device.deviceId}`}
          mobile={mobile}
          device={device}
          inputBlocked={agentHolds}
          onBlockedInput={nudgeTakeOver}
          onNotice={showNotice}
        />
      ) : null}
      <div className="mobile-footer">
        <Switch
          label="Let agents use devices"
          hint={
            settingsError ??
            "Agents get the zli-mobile tools to boot devices, install and open apps, tap, type, take screenshots, and read logs."
          }
          checked={settings?.agentTools ?? false}
          disabled={!settings}
          onChange={setAgentTools}
        />
      </div>
    </div>
  );
}

function isAndroidVirtual(device: MobileDevice): boolean {
  return device.platform === "android" && device.kind === "emulator";
}

function readSelected(): string | undefined {
  try {
    return window.localStorage.getItem(SELECTED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "device";
}

function fileStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
