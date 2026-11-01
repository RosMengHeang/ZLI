import type { MobileDevice } from "@zli-v2/contracts";
import { useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { useWorkspace } from "./dev/workspace/useWorkspace.js";
import { type DevServerHint, errorText, expoUrl, openedNotice } from "./mobile.js";

/** Ports whose Expo banner was dismissed. Kept for the session only, so a new session offers it again. */
const DISMISSED_KEY = "zli.mobile.expo.v1";

/**
 * Offers to open the worktree's Expo server on the shown device. It never opens anything without a click. When the
 * server is on the worktree's own Metro port, Open uses the worktree's URL, and it is off while another worktree
 * serves that port.
 */
export function ExpoBanner({
  mobile,
  worktreeId,
  device,
  server,
  inputBlocked,
  onBlockedInput,
  onError,
  onNotice,
}: {
  mobile: Pick<MobileBridge, "openUrl" | "dev">;
  worktreeId?: string | undefined;
  device: MobileDevice;
  server: DevServerHint;
  inputBlocked: boolean;
  onBlockedInput(): void;
  onError(message: string | undefined): void;
  onNotice(message: string): void;
}) {
  const [dismissed, setDismissed] = useState<readonly number[]>(readDismissed);
  const [opening, setOpening] = useState(false);
  const api = mobile.dev?.workspace;
  const { workspace } = useWorkspace(api, worktreeId);
  if (dismissed.includes(server.port)) return null;
  const own = workspace && api && worktreeId && workspace.metroPort === server.port ? workspace : undefined;
  const heldBy = own?.metro.state === "other-worktree" ? own.metro.branch : undefined;

  const open = async () => {
    if (opening || heldBy) return;
    if (inputBlocked) return onBlockedInput();
    const url = own ? own.openUrl : expoUrl(server);
    setOpening(true);
    onError(undefined);
    try {
      if (own && api && worktreeId) {
        const result = await api.open(worktreeId, device.deviceId);
        onNotice(openedNotice(result.opened, result));
      } else onNotice(openedNotice(url, await mobile.openUrl(device.deviceId, url)));
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
      <span className="banner-message">
        {own
          ? `Metro for this worktree is on localhost:${server.port}.`
          : `Expo is running on localhost:${server.port}.`}
      </span>
      <div className="banner-actions">
        <Button
          size="xs"
          variant="primary"
          loading={opening}
          disabled={heldBy !== undefined}
          tooltip={heldBy ? `Port ${server.port} belongs to ${heldBy}` : undefined}
          onClick={() => void open()}
        >
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
