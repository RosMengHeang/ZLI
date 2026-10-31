import type { MobileDevice, MobileSetupStatus, MobileToolProbe } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import {
  accelerationProblem,
  deviceKindLabel,
  devicesInGroups,
  errorText,
  stateLabel,
  stateTone,
  systemImageLabel,
} from "../mobile/mobile.js";
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
import { SectionHeader, SettingGroup, SettingRow } from "./SectionHeader.js";

/** Phone simulation: the devices on this computer, how their screens show, and what the emulator needs. */
export function MobileSection() {
  const { bridge } = useRuntime();
  const settings = useAppSettings();
  const mobile = bridge?.mobile;
  const shortcut = settings.shortcuts.toggleMobile ?? defaultShortcut("toggleMobile");
  return (
    <>
      <SectionHeader title="Mobile">
        Android emulators, USB phones, and iPhone simulators open in the Mobile panel. Show it with{" "}
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
  const [showFrame, setShowFrame] = useDeviceFrame();
  const { settings: agentSettings, error: agentError, setAgentTools } = useMobileSettings(mobile);

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
    try {
      await work();
    } catch (cause) {
      setActionError(errorText(cause, fallback));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(device.deviceId);
        return next;
      });
    }
  };

  return (
    <>
      <SettingGroup
        title="Devices"
        className="mobile-devices-group"
        actions={
          <IconButton
            label="Refresh devices"
            icon="reload"
            size="xs"
            iconSize={12}
            onClick={() => void refreshDevices()}
          />
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
            debugging turned on.
          </p>
        ) : null}
        {devices && devices.length > 0 ? (
          <ul className="mobile-device-rows" aria-label="Devices">
            {devicesInGroups(devices).map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                busy={busy.has(device.deviceId)}
                onBoot={() => void act(device, () => mobile.boot(device.deviceId), `${device.name} did not boot.`)}
                onShutdown={() =>
                  void act(device, () => mobile.shutdown(device.deviceId), `${device.name} did not shut down.`)
                }
              />
            ))}
          </ul>
        ) : null}
        {actionError ? (
          <p className="setting-placeholder is-problem" role="alert">
            {actionError}
          </p>
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
          {status.ios.supported ? (
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
}: {
  device: MobileDevice;
  busy: boolean;
  onBoot(): void;
  onShutdown(): void;
}) {
  const virtual = device.kind !== "physical";
  const platform = device.platform === "ios" ? "iOS" : "Android";
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
        </span>
      </span>
      <Badge tone={stateTone(device)} dot={device.state !== "booting"} spinner={device.state === "booting"}>
        {stateLabel(device.state)}
      </Badge>
      <span className="mobile-device-action">
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
      </span>
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
