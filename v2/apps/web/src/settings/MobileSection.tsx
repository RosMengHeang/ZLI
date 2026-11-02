import type { MobileDevice, MobileSetupStatus, MobileToolProbe } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { MobileDevSettingGroups } from "../mobile/dev/MobileDevSettingGroups.js";
import {
  accelerationProblem,
  connectionLabel,
  deviceKindLabel,
  deviceStateLabel,
  devicesInGroups,
  errorText,
  macName,
  phoneStateHint,
  stateTone,
  systemImageLabel,
} from "../mobile/mobile.js";
import { NewDeviceDialog, type NewDevicePlatform } from "../mobile/NewDeviceDialog.js";
import { useDeviceFrame } from "../mobile/useDeviceFrame.js";
import { useMobileSettings } from "../mobile/useMobileSettings.js";
import type { MobileBridge } from "../runtime/bridge.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { defaultShortcut } from "../shell/keybindings.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { Switch } from "../ui/Switch.js";
import { useAppSettings } from "./appSettings.js";
import { RemoteMacRows } from "./RemoteMacRows.js";
import { SectionHeader, SettingGroup, SettingRow } from "./SectionHeader.js";

const AVD_PREFIX = "android-avd:";

/** Phone simulation: the devices on this computer, how their screens show, and what the emulator needs. */
export function MobileSection() {
  const { bridge } = useRuntime();
  const settings = useAppSettings();
  const mobile = bridge?.mobile;
  const shortcut = settings.shortcuts.toggleMobile ?? defaultShortcut("toggleMobile");
  return (
    <>
      <SectionHeader title="Mobile">
        Android emulators, Android phones on USB or Wi-Fi, and iPhone simulators open in the Mobile panel. Show it with{" "}
        <Kbd shortcut={shortcut} />.
      </SectionHeader>
      {mobile ? (
        <MobileSettingsBody mobile={mobile} />
      ) : (
        <p className="settings-empty">
          Emulators and simulators run on your computer, so these settings are in the ZLI desktop app only.
        </p>
      )}
    </>
  );
}

function MobileSettingsBody({ mobile }: { mobile: MobileBridge }) {
  const [devices, setDevices] = useState<MobileDevice[]>();
  const [devicesError, setDevicesError] = useState<string>();
  const [status, setStatus] = useState<MobileSetupStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [showFrame, setShowFrame] = useDeviceFrame();
  const { settings: agentSettings, error: agentError, setAgentTools, setIosRemoteHost } = useMobileSettings(mobile);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await mobile.devices());
      setDevicesError(undefined);
    } catch (cause) {
      setDevicesError(errorText(cause, "The device list could not be read."));
    }
  }, [mobile]);

  const check = useCallback(
    async (recheckAcceleration = false) => {
      setChecking(true);
      try {
        setStatus(await mobile.status(recheckAcceleration ? { recheckAcceleration } : undefined));
        setStatusError(undefined);
      } catch (cause) {
        setStatusError(errorText(cause, "ZLI could not check what is installed."));
      } finally {
        setChecking(false);
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
    void check();
    return unsubscribe;
  }, [mobile, refreshDevices, check]);

  const act = async (device: MobileDevice, work: () => Promise<unknown>, fallback: string) => {
    setBusy((current) => new Set(current).add(device.deviceId));
    setActionError(undefined);
    setNotice(undefined);
    try {
      await work();
      return true;
    } catch (cause) {
      setActionError(errorText(cause, fallback));
      return false;
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(device.deviceId);
        return next;
      });
    }
  };

  const platforms: NewDevicePlatform[] = [];
  if (status?.android.avdmanager.found) platforms.push("android");
  if (status?.ios.simctl.found && mobile.createSimulator) platforms.push("ios");

  /** How a virtual device is deleted, or undefined when this one cannot be. */
  const deleter = (device: MobileDevice): (() => Promise<unknown>) | undefined => {
    if (device.kind === "emulator" && status?.android.avdmanager.found && device.deviceId.startsWith(AVD_PREFIX))
      return () => mobile.deleteAvd(device.deviceId.slice(AVD_PREFIX.length));
    const deleteSimulator = mobile.deleteSimulator;
    if (
      device.kind === "simulator" &&
      status?.ios.simctl.found &&
      deleteSimulator &&
      device.deviceId.startsWith("ios:")
    )
      return () => deleteSimulator(device.deviceId.slice("ios:".length));
    return undefined;
  };

  return (
    <>
      <SettingGroup
        title="Devices"
        className="mobile-devices-group"
        actions={
          <>
            {platforms.length > 0 ? (
              <Button size="xs" variant="ghost" icon="plus" onClick={() => setCreating(true)}>
                New device…
              </Button>
            ) : null}
            <IconButton
              label="Refresh devices"
              icon="reload"
              size="xs"
              iconSize={12}
              onClick={() => void refreshDevices()}
            />
          </>
        }
      >
        {devices === undefined && !devicesError ? <p className="setting-placeholder">Looking for devices</p> : null}
        {devicesError ? (
          <p className="setting-placeholder is-problem" role="alert">
            {devicesError}
          </p>
        ) : null}
        {devices?.length === 0 ? (
          <p className="setting-placeholder">
            No devices yet. Set up the Android emulator from the Mobile panel, or connect an Android phone with USB
            debugging turned on. Phones on Wi-Fi connect from Setup in the Mobile panel.
          </p>
        ) : null}
        {devices && devices.length > 0 ? (
          <ul className="mobile-device-rows" aria-label="Devices">
            {devicesInGroups(devices).map((device) => {
              const remove = deleter(device);
              return (
                <DeviceRow
                  key={device.deviceId}
                  device={device}
                  busy={busy.has(device.deviceId)}
                  {...(remove
                    ? {
                        onDelete: async () => {
                          const ok = await act(device, remove, `${device.name} could not be deleted.`);
                          if (ok) {
                            setNotice(`Deleted ${device.name}.`);
                            void refreshDevices();
                          }
                          return ok;
                        },
                      }
                    : {})}
                  onBoot={() => void act(device, () => mobile.boot(device.deviceId), `${device.name} did not boot.`)}
                  onShutdown={() =>
                    void act(device, () => mobile.shutdown(device.deviceId), `${device.name} did not shut down.`)
                  }
                  {...(mobile.disconnectWifi
                    ? {
                        onDisconnect: () =>
                          void act(
                            device,
                            async () => mobile.disconnectWifi?.(device.deviceId),
                            `${device.name} could not be disconnected.`,
                          ),
                      }
                    : {})}
                />
              );
            })}{" "}
          </ul>
        ) : null}
        {actionError ? (
          <p className="setting-placeholder is-problem" role="alert">
            {actionError}
          </p>
        ) : null}
        <div role="status">{notice ? <p className="setting-placeholder">{notice}</p> : null}</div>
        {creating ? (
          <NewDeviceDialog
            mobile={mobile}
            platforms={platforms}
            devices={devices ?? []}
            onCreated={(created) => {
              setCreating(false);
              setActionError(undefined);
              setNotice(`Created ${created.name}.`);
              void refreshDevices();
              void check();
            }}
            onClose={() => setCreating(false)}
          />
        ) : null}
      </SettingGroup>

      <SettingGroup title="Screen">
        <Switch
          label="Show device frame"
          hint="Draw a phone or tablet body around the screen, with side buttons you can click."
          checked={showFrame}
          onChange={setShowFrame}
        />
      </SettingGroup>

      <SettingGroup title="Agents">
        <Switch
          label="Let agents use devices"
          hint={
            agentError ??
            "Agents get the zli-mobile tools to boot devices, install and open apps, tap, type, take screenshots, and read logs."
          }
          checked={agentSettings?.agentTools ?? false}
          disabled={!agentSettings}
          onChange={setAgentTools}
        />
      </SettingGroup>

      <MobileDevSettingGroups mobile={mobile} />

      <SettingGroup
        title="Android SDK"
        actions={
          <Button size="xs" variant="ghost" icon="reload" loading={checking} onClick={() => void check(true)}>
            Check again
          </Button>
        }
      >
        {statusError ? (
          <p className="setting-placeholder is-problem" role="alert">
            {statusError}
          </p>
        ) : !status ? (
          <p className="setting-placeholder">Checking what is installed</p>
        ) : (
          <AndroidRows status={status} />
        )}
      </SettingGroup>

      {status ? (
        <SettingGroup title="iPhone simulator">
          {status.ios.host ? (
            <>
              <ToolRow
                label="Simulator tools"
                detail={`simctl, from Xcode on ${macName(status.ios.host)}`}
                probe={status.ios.simctl}
              />
              <ToolRow
                label="idb"
                detail="Needed for taps, swipes, and typing. Without it the panel shows screenshots only."
                probe={status.ios.idb}
                optional
              />
            </>
          ) : status.ios.supported ? (
            <>
              <ToolRow label="Simulator tools" detail="simctl, from Xcode" probe={status.ios.simctl} />
              <ToolRow
                label="idb"
                detail="Needed for taps, swipes, and typing. Without it the panel shows screenshots only."
                probe={status.ios.idb}
                optional
              />
            </>
          ) : (
            <SettingRow label="Xcode" description="iPhone simulators need a Mac with Xcode.">
              <Badge tone="quiet">Not on this computer</Badge>
            </SettingRow>
          )}
          <RemoteMacRows
            mobile={mobile}
            saved={agentSettings ? (agentSettings.iosRemoteHost ?? "") : undefined}
            macHere={status.host.os === "macos"}
            problem={status.ios.host && !status.ios.simctl.found ? status.ios.missing[0] : undefined}
            save={setIosRemoteHost}
            onSaved={() => {
              void check();
              void refreshDevices();
            }}
          />
        </SettingGroup>
      ) : null}
    </>
  );
}

function DeviceRow({
  device,
  busy,
  onBoot,
  onShutdown,
  onDelete,
  onDisconnect,
}: {
  device: MobileDevice;
  busy: boolean;
  onBoot(): void;
  onShutdown(): void;
  /** Present for a virtual device ZLI can delete. Resolves true once it is gone. */
  onDelete?(): Promise<boolean>;
  /** Present when the bridge can disconnect a phone on Wi-Fi. */
  onDisconnect?: () => void;
}) {
  const virtual = device.kind !== "physical";
  const platform = device.platform === "ios" ? "iOS" : "Android";
  const via = connectionLabel(device);
  const hint = phoneStateHint(device);
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const off = device.state === "shutdown";
  return (
    <li className="mobile-device-row">
      <span className="mobile-device-tile" aria-hidden="true">
        <Icon name="smartphone" size={15} />
      </span>
      <span className="mobile-device-copy">
        <span className="mobile-device-name">{device.name}</span>
        <span className="mobile-device-meta">
          {deviceKindLabel(device)}
          {device.osVersion ? `, ${platform} ${device.osVersion}` : ""}
          {via ? `, ${via}` : ""}
        </span>
        {hint ? <span className="mobile-device-meta is-warning">{hint}</span> : null}
      </span>
      <Badge tone={stateTone(device)} dot={device.state !== "booting"} spinner={device.state === "booting"}>
        {deviceStateLabel(device)}
      </Badge>
      {confirming && onDelete ? (
        <fieldset className="mobile-device-action mobile-device-confirm" aria-label={`Delete ${device.name}?`}>
          <span className="mobile-device-confirm-text">Delete it and its data?</span>
          <Button
            size="xs"
            variant="danger"
            loading={busy}
            aria-label={`Delete ${device.name} for good`}
            onClick={() => void onDelete().then((ok) => ok || setConfirming(false))}
          >
            Delete
          </Button>
          <Button
            ref={keepRef}
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              requestAnimationFrame(() => deleteRef.current?.focus());
            }}
          >
            Keep it
          </Button>
        </fieldset>
      ) : (
        <span className="mobile-device-action">
          {onDelete && off ? (
            <IconButton
              ref={deleteRef}
              label={`Delete ${device.name}`}
              icon="trash"
              size="xs"
              iconSize={12}
              disabled={busy}
              onClick={() => {
                setConfirming(true);
                requestAnimationFrame(() => keepRef.current?.focus());
              }}
            />
          ) : null}
          {virtual && device.state === "shutdown" ? (
            <Button size="xs" icon="play" loading={busy} aria-label={`Boot ${device.name}`} onClick={onBoot}>
              Boot
            </Button>
          ) : null}
          {virtual && device.state === "online" ? (
            <Button
              size="xs"
              variant="ghost"
              icon="power"
              loading={busy}
              aria-label={`Shut down ${device.name}`}
              onClick={onShutdown}
            >
              Shut down
            </Button>
          ) : null}
          {device.connection === "wifi" && onDisconnect ? (
            <Button
              size="xs"
              variant="ghost"
              loading={busy}
              aria-label={`Disconnect ${device.name}`}
              onClick={onDisconnect}
            >
              Disconnect
            </Button>
          ) : null}
        </span>
      )}
    </li>
  );
}

const SDK_SOURCE: Record<MobileSetupStatus["android"]["sdkSource"], string> = {
  env: "Found through ANDROID_HOME.",
  default: "Found in the default install folder.",
  zli: "Installed by ZLI.",
  none: "Set ANDROID_HOME and restart ZLI to use an SDK you already have.",
};

function AndroidRows({ status }: { status: MobileSetupStatus }) {
  const android = status.android;
  const slow = accelerationProblem(android);
  return (
    <>
      <SettingRow label="SDK location" description={SDK_SOURCE[android.sdkSource]}>
        {android.sdkRoot ? (
          <span className="settings-value is-mono" title={android.sdkRoot}>
            {android.sdkRoot}
          </span>
        ) : (
          <Badge tone="warning">Not found</Badge>
        )}
      </SettingRow>
      <ToolRow label="Platform tools" detail="adb, which talks to emulators and phones" probe={android.adb} />
      <ToolRow label="Emulator" detail="Runs Android virtual devices" probe={android.emulator} />
      <ToolRow label="Command-line tools" detail="sdkmanager and avdmanager" probe={android.sdkmanager} />
      <ToolRow label="Java" detail="Version 17 or newer, for the command-line tools" probe={android.java} />
      <SettingRow
        label="Hardware acceleration"
        description={
          slow ??
          (android.acceleration.checked
            ? "The emulator can use your processor's virtualization."
            : "Checked the first time a device boots.")
        }
        descriptionTone={slow ? "warning" : undefined}
      >
        {android.acceleration.checked ? (
          <Badge tone={android.acceleration.usable ? "success" : "warning"} dot={android.acceleration.usable}>
            {android.acceleration.usable ? "Works" : "Unavailable"}
          </Badge>
        ) : (
          <Badge tone="quiet">Not checked</Badge>
        )}
      </SettingRow>
      <SettingRow
        label="System images"
        description={
          android.systemImages.length > 0
            ? android.systemImages.map(systemImageLabel).join("; ")
            : "New virtual devices are created from an installed image."
        }
      >
        <span className="settings-value">
          {android.systemImages.length === 0 ? "None" : `${android.systemImages.length} installed`}
        </span>
      </SettingRow>
    </>
  );
}

function ToolRow({
  label,
  detail,
  probe,
  optional = false,
}: {
  label: string;
  detail: string;
  probe: MobileToolProbe;
  optional?: boolean;
}) {
  return (
    <SettingRow label={label} description={detail}>
      <span className="mobile-tool-state" title={probe.path}>
        {probe.found && probe.version ? <span className="mobile-tool-version">{probe.version}</span> : null}
        {probe.found ? (
          <Badge tone="success" dot>
            Installed
          </Badge>
        ) : (
          <Badge tone={optional ? "quiet" : "warning"}>Missing</Badge>
        )}
      </span>
    </SettingRow>
  );
}
