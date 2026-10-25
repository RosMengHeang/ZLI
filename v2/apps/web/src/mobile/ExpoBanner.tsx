import type { MobileDevice } from "@zli-v2/contracts";
import { useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { type DevServerHint, errorText, expoUrl, openedNotice } from "./mobile.js";

/** Ports whose Expo banner was dismissed. Kept for the session only, so a new session offers it again. */
const DISMISSED_KEY = "zli.mobile.expo.v1";

/** Offers to open the worktree's Expo server on the shown device. It never opens anything without a click. */
export function ExpoBanner({
  mobile,
  device,
  server,
  inputBlocked,
  onBlockedInput,
  onError,
  onNotice,
}: {
  mobile: Pick<MobileBridge, "openUrl">;
  device: MobileDevice;
  server: DevServerHint;
  inputBlocked: boolean;
  onBlockedInput(): void;
  onError(message: string | undefined): void;
  onNotice(message: string): void;
}) {
  const [dismissed, setDismissed] = useState<readonly number[]>(readDismissed);
  const [opening, setOpening] = useState(false);
  if (dismissed.includes(server.port)) return null;

  const open = async () => {
    if (opening) return;
    if (inputBlocked) return onBlockedInput();
    const url = expoUrl(server);
    setOpening(true);
    onError(undefined);
    try {
      onNotice(openedNotice(url, await mobile.openUrl(device.deviceId, url)));
    } catch (cause) {
      onError(errorText(cause, `${device.name} could not open ${url}.`));
    } finally {
      setOpening(false);
    }
  };
  const dismiss = () => {
    const next = [...dismissed, server.port];
    setDismissed(next);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Without storage the banner stays hidden until the pane reloads.
    }
  };

  return (
    <div className="banner banner-info" role="status">
      <Icon name="play" size={14} />
      <span className="banner-message">Expo is running on localhost:{server.port}.</span>
      <div className="banner-actions">
        <Button size="xs" variant="primary" loading={opening} onClick={() => void open()}>
          Open on {device.name}
        </Button>
        <IconButton
          label="Dismiss the Expo banner"
          tooltip="Dismiss"
          icon="x"
          size="xs"
          iconSize={12}
          onClick={dismiss}
        />
      </div>
    </div>
  );
}

function readDismissed(): number[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((port): port is number => typeof port === "number") : [];
  } catch {
    return [];
  }
}
