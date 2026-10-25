import type { MobileDevice } from "@zli-v2/contracts";

import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Picker, type PickerOption } from "../ui/Picker.js";
import {
  deviceGroup,
  deviceSummary,
  devicesInGroups,
  formatElapsed,
  type ScreenMode,
  screenModeChip,
  stateLabel,
} from "./mobile.js";

/** Picker values that are not devices. Device ids always carry a platform prefix, so these never collide. */
const NEW_DEVICE = "new-virtual-device";
const NO_DEVICE = "no-device";

/**
 * The row under the pane header: which device, its state, how its screen arrives, and Boot, Cancel, or Shut down.
 * The picker shows even with one device or none, so the row keeps its shape.
 */
export function MobileToolbar({
  devices,
  device,
  bootElapsedMs,
  screenMode,
  booting,
  stopping,
  onSelect,
  onNewDevice,
  onBoot,
  onShutdown,
  onCancel,
}: {
  devices: readonly MobileDevice[];
  device: MobileDevice | undefined;
  /** How long the device has been booting, while it boots. */
  bootElapsedMs: number | undefined;
  screenMode: ScreenMode | undefined;
  booting: boolean;
  stopping: boolean;
  onSelect(deviceId: string): void;
  /** Picked from the last entry in the device list. */
  onNewDevice(): void;
  onBoot(): void;
  onShutdown(): void;
  /** Stops a virtual device that is still booting. */
  onCancel(): void;
}) {
  const virtual = device ? device.kind !== "physical" : false;
  const chip = device?.state === "online" && screenMode ? screenModeChip(screenMode) : undefined;
  const options: PickerOption<string>[] = device
    ? [
        ...devicesInGroups(devices).map((candidate) => ({
          value: candidate.deviceId,
          label: candidate.name,
          description: deviceSummary(candidate),
          group: deviceGroup(candidate),
          icon: <Icon name={candidate.kind === "physical" ? "smartphone" : "appWindow"} size={14} />,
        })),
        { value: NEW_DEVICE, label: "New virtual device", icon: <Icon name="plus" size={14} /> },
      ]
    : [{ value: NO_DEVICE, label: "No devices" }];
  return (
    <div className="mobile-toolbar">
      <Picker<string>
        label="Device"
        tooltip={device ? "Choose a device" : "Connect a phone or set up the emulator first"}
        value={device?.deviceId ?? NO_DEVICE}
        options={options}
        disabled={!device}
        onChange={(value) => (value === NEW_DEVICE ? onNewDevice() : onSelect(value))}
      >
        <span className="picker-trigger-label">{device?.name ?? "No devices"}</span>
      </Picker>
      {device ? (
        <Badge tone={stateTone(device)} dot={device.state !== "booting"} spinner={device.state === "booting"}>
          {device.state === "booting" && bootElapsedMs !== undefined
            ? `${stateLabel(device.state)} ${formatElapsed(bootElapsedMs)}`
            : stateLabel(device.state)}
        </Badge>
      ) : null}
      {chip ? (
        <Badge className="mobile-mode-chip" tone={chip.tone} {...(chip.title ? { title: chip.title } : {})}>
          {chip.label}
        </Badge>
      ) : null}
      <span className="mobile-toolbar-spacer" />
      {device && virtual && device.state === "shutdown" ? (
        <Button size="sm" icon="play" loading={booting} onClick={onBoot}>
          Boot
        </Button>
      ) : null}
      {device && virtual && device.state === "booting" ? (
        <Button size="sm" icon="square" loading={stopping} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {device && virtual && device.state === "online" ? (
        <Button size="sm" icon="square" loading={stopping} onClick={onShutdown}>
          Shut down
        </Button>
      ) : null}
    </div>
  );
}

function stateTone(device: MobileDevice): BadgeTone {
  switch (device.state) {
    case "online":
      return "success";
    case "booting":
      return "info";
    case "shutdown":
      return "quiet";
    case "offline":
      return "danger";
    case "unauthorized":
      return "warning";
  }
}
