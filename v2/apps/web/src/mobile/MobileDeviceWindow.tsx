import type { MobileDevice } from "@zli-v2/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState } from "../ui/Pane.js";
import { Segmented } from "../ui/Segmented.js";
import { DeviceScreen } from "./DeviceScreen.js";
import { LeaseBanner } from "./LeaseBanner.js";
import { MobileControls } from "./MobileControls.js";
import { deviceKindLabel, errorText, leaseNotice } from "./mobile.js";
import { copyScreenshot, saveScreenshot } from "./screenshots.js";
import { useClock } from "./useClock.js";
import { useDeviceFrame } from "./useDeviceFrame.js";
import { type Zoom, useDeviceZoom } from "./useDeviceZoom.js";
import { useNotice } from "./useNotice.js";
import "@zli-v2/ui/primitives.css";
import "./mobile.css";

/** How often the agent lease banner rechecks its countdown. */
const LEASE_TICK_MS = 15_000;
const SHAPE_LIMIT = 4_000;

type Busy = "lease" | "screenshot" | "pin";

/**
 * The pop-out window for one device: a slim title bar with the device's name and Keep on top, the device in its
 * frame, the lease banner, and the bottom controls. Closing the window gives the device back to the panel.
 */
export function MobileDeviceWindow({ mobile, deviceId }: { mobile: MobileBridge | undefined; deviceId: string }) {
  if (!mobile)
    return (
      <div className="mobile-window">
        <EmptyState
          icon="smartphone"
          title="Devices need the desktop app"
          detail="Open this workspace in the ZLI desktop app to show a device in its own window."
        />
      </div>
    );
  return <MobileDeviceWindowBody mobile={mobile} deviceId={deviceId} />;
}

function MobileDeviceWindowBody({ mobile, deviceId }: { mobile: MobileBridge; deviceId: string }) {
  const [devices, setDevices] = useState<MobileDevice[]>();
  const [devicesError, setDevicesError] = useState<string>();
  const [pinned, setPinned] = useState(false);
  const [hostOs, setHostOs] = useState<string>();
  const [busy, setBusy] = useState<ReadonlySet<Busy>>(() => new Set());
  const [actionError, setActionError] = useState<string>();
  const [notice, showNotice] = useNotice();
  const takeOverRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState<number>();

  useEffect(() => {
    const unsubscribe = mobile.onDevices((next) => {
      setDevices(next);
      setDevicesError(undefined);
    });
    mobile
      .devices()
      .then(setDevices, (cause: unknown) => setDevicesError(errorText(cause, "The device list could not be read.")));
    mobile.status().then(
      (status) => setHostOs(status.host.os),
      () => undefined,
    );
    return unsubscribe;
  }, [mobile]);

  useEffect(() => {
    const follow = (popOuts: { deviceId: string; pinned: boolean }[]) =>
      setPinned(popOuts.find((entry) => entry.deviceId === deviceId)?.pinned ?? false);
    const unsubscribe = mobile.onPopOuts?.(follow);
    mobile.popOuts?.().then(follow, () => undefined);
    return unsubscribe;
  }, [mobile, deviceId]);

  const device = devices?.find((candidate) => candidate.deviceId === deviceId);
  const name = device?.name;
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);

  const agentLeaseEnds = device?.lease?.kind === "agent" && device.lease.expiresAt !== undefined;
  const now = useClock(agentLeaseEnds ? LEASE_TICK_MS : undefined);
  const lease = device ? leaseNotice(device, { now }) : undefined;
  const agentHolds = lease?.kind === "agent";
  const [zoom, setZoom] = useDeviceZoom(device?.deviceId);
  const [showFrame, setShowFrame] = useDeviceFrame();
  const online = device?.state === "online";

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

  const bannerKey = `${lease?.kind ?? ""}|${actionError ? 1 : 0}`;
  // The window's bars and banners take room around the device, measured from the box the device fits in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: banners change the room around the device.
  useEffect(() => {
    if (!aspect || zoom !== "fit" || !mobile.setPopOutAspect) return;
    const box = rootRef.current?.querySelector(".mobile-zoom")?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return;
    const extra = (outer: number, inner: number) => Math.min(SHAPE_LIMIT, Math.max(0, Math.round(outer - inner)));
    mobile
      .setPopOutAspect({
        deviceId,
        aspect,
        extraWidth: extra(window.innerWidth, box.width),
        extraHeight: extra(window.innerHeight, box.height),
      })
      .catch(() => undefined);
  }, [mobile, deviceId, aspect, zoom, bannerKey]);

  const togglePin = () =>
    void run(
      "pin",
      async () => {
        const popOuts = await mobile.pinPopOut?.(deviceId, !pinned);
        if (popOuts) setPinned(popOuts.find((entry) => entry.deviceId === deviceId)?.pinned ?? false);
      },
      pinned ? "ZLI could not stop keeping the window on top." : "ZLI could not keep the window on top.",
    );

  let body: ReactNode;
  if (!devices && devicesError)
    body = <EmptyState icon="alert" tone="danger" title="Devices could not be listed" detail={devicesError} />;
  else if (!devices) body = <LoadingState label="Looking for the device" />;
  else if (!device)
    body = (
      <EmptyState icon="smartphone" title="This device is gone" detail="ZLI no longer lists it. Close this window.">
        <Button size="sm" onClick={() => void mobile.closePopOut?.(deviceId)}>
          Close window
        </Button>
      </EmptyState>
    );
  else if (online)
    body = (
      <DeviceScreen
        key={device.deviceId}
        mobile={mobile}
        device={device}
        inputBlocked={agentHolds}
        onBlockedInput={nudgeTakeOver}
        zoom={zoom}
        showFrame={showFrame}
        onAspect={setAspect}
      />
    );
  else
    body = (
      <EmptyState
        icon="smartphone"
        title={device.state === "booting" ? `${device.name} is booting` : `${device.name} is not running`}
        detail="Its screen shows here once it runs. Boot and shut it down from the Mobile panel."
      />
    );

  return (
    <div className="mobile-window" ref={rootRef}>
      <header className="mobile-window-bar">
        <Icon name="smartphone" size={14} />
        <span className="mobile-window-title">{device?.name ?? "Device"}</span>
        {device ? <span className="mobile-window-detail">{deviceKindLabel(device)}</span> : null}
        <span className="mobile-toolbar-spacer" />
        {online ? (
          <Segmented<Zoom>
            label="Zoom"
            value={zoom}
            options={[
              { value: "fit", label: "Fit", tooltip: "Fit the screen to the window" },
              {
                value: "actual",
                label: "100%",
                ariaLabel: "100%, device pixels",
                tooltip: "Show device pixels at 100%",
              },
            ]}
            onChange={setZoom}
          />
        ) : null}
        {mobile.pinPopOut ? (
          <IconButton
            icon="pin"
            size="sm"
            iconSize={14}
            label="Keep on top"
            tooltip={pinned ? "Stop keeping this window on top" : "Keep this window on top of other windows"}
            pressed={pinned}
            disabled={busy.has("pin")}
            onClick={togglePin}
          />
        ) : null}
      </header>
      {device && lease ? (
        <LeaseBanner
          lease={lease}
          busy={busy.has("lease")}
          takeOverRef={takeOverRef}
          onTakeOver={() => void run("lease", () => mobile.takeOver(deviceId), "ZLI could not give you control.")}
          onRelease={() => void run("lease", () => mobile.release(deviceId), "ZLI could not hand the device back.")}
        />
      ) : null}
      {actionError ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{actionError}</span>
        </div>
      ) : null}
      <div className="mobile-notice" role="status">
        {notice ? (
          <div key={notice.key} className="banner banner-info">
            <Icon name="check" size={14} />
            <span className="banner-message">{notice.text}</span>
          </div>
        ) : null}
      </div>
      <div className="mobile-body">{body}</div>
      {device && online ? (
        <MobileControls
          key={device.deviceId}
          mobile={mobile}
          device={device}
          inputBlocked={agentHolds}
          onBlockedInput={nudgeTakeOver}
          onError={setActionError}
          onNotice={showNotice}
          screenshotBusy={busy.has("screenshot")}
          onScreenshot={() =>
            void run(
              "screenshot",
              async () => showNotice(`Saved ${await saveScreenshot(mobile, device)}`),
              "The screenshot could not be taken.",
            )
          }
          onCopyScreenshot={() =>
            void run(
              "screenshot",
              async () => {
                await copyScreenshot(mobile, device);
                showNotice("Copied the screenshot.");
              },
              "The screenshot could not be copied.",
            )
          }
          canRotate={device.platform === "android" || hostOs === "macos"}
          showFrame={showFrame}
          onShowFrame={setShowFrame}
        />
      ) : null}
    </div>
  );
}
