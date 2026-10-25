import type { MobileDevice } from "@zli-v2/contracts";

import { Badge, type BadgeTone } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Picker } from "../ui/Picker.js";
import { deviceKindLabel, formatElapsed, type ScreenMode, screenModeChip, stateLabel } from "./mobile.js";

/** The row under the pane header: which device, its state, how its screen arrives, and Boot, Cancel, or Shut down. */
export function MobileToolbar({
  devices,
  device,
  bootElapsedMs,
  screenMode,
  booting,
  stopping,
  onSelect,
  onBoot,
  onShutdown,
  onCancel,
}: {
  devices: readonly MobileDevice[];
  device: MobileDevice;
  /** How long the device has been booting, while it boots. */
  bootElapsedMs: number | undefined;
  screenMode: ScreenMode | undefined;
  booting: boolean;
  stopping: boolean;
  onSelect(deviceId: string): void;
  onBoot(): void;
  onShutdown(): void;
  /** Stops a virtual device that is still booting. */
  onCancel(): void;
}) {
  const virtual = device.kind !== "physical";
  const chip = device.state === "online" && screenMode ? screenModeChip(screenMode) : undefined;
  return (
    <div className="mobile-toolbar">
      {devices.length > 1 ? (
        <Picker<string>
          label="Device"
          tooltip="Choose a device"
          value={device.deviceId}
          options={devices.map((candidate) => ({
            value: candidate.deviceId,
            label: candidate.name,
            description: `${deviceKindLabel(candidate)}${candidate.osVersion ? ` ${candidate.osVersion}` : ""}, ${stateLabel(candidate.state).toLowerCase()}`,
          }))}
          onChange={onSelect}
        >
          <span className="picker-trigger-label">{device.name}</span>
        </Picker>
      ) : (
        <span className="mobile-device-name" title={device.deviceId}>
          {device.name}
        </span>
      )}
      <Badge tone={stateTone(device)} dot={device.state !== "booting"} spinner={device.state === "booting"}>
        {device.state === "booting" && bootElapsedMs !== undefined
          ? `${stateLabel(device.state)} ${formatElapsed(bootElapsedMs)}`
          : stateLabel(device.state)}
      </Badge>
      {chip ? (
        <Badge className="mobile-mode-chip" tone={chip.tone} {...(chip.title ? { title: chip.title } : {})}>
          {chip.label}
        </Badge>
      ) : null}
      <span className="mobile-toolbar-spacer" />
      {virtual && device.state === "shutdown" ? (
        <Button size="sm" icon="play" loading={booting} onClick={onBoot}>
          Boot
        </Button>
      ) : null}
      {virtual && device.state === "booting" ? (
        <Button size="sm" icon="square" loading={stopping} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {virtual && device.state === "online" ? (
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
