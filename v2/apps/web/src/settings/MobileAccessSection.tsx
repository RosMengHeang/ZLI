import type { MobileAccessStatus, PairedPhone } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCopyFeedback } from "../review/links.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Switch } from "../ui/Switch.js";
import { countdown, deviceDetail, newlyPaired, qrPath } from "./mobileAccessView.js";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";
import { useMobileAccess } from "./useMobileAccess.js";

const QUIET_ZONE = 4;

function PairingCode({ code }: { code: string }) {
  const { size, path } = useMemo(() => qrPath(code), [code]);
  const box = size + QUIET_ZONE * 2;
  return (
    <svg
      className="mobile-qr"
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${box} ${box}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const RELAY_NOTE =
  "Your phone reaches this PC through your relay when it isn't on the same Wi-Fi. The relay can't read your traffic, but it sees when each side connects and from which network address.";
const RELAY_OFF_WARNING =
  "Turning it off stops paired phones from using the relay. Turned back on, it gets a new address, which each phone picks up the next time it connects on the same network.";

/** The one line under Connect from anywhere. Undefined while there is nothing to say. */
function relayLine(status: MobileAccessStatus): { text: string; problem?: boolean } | undefined {
  if (!status.relay.enabled) return undefined;
  if (status.state !== "listening") return { text: "Starts when Allow phones on this network is on." };
  switch (status.relay.state) {
    case "connecting":
      return { text: "Connecting…" };
    case "online":
      return { text: "Online" };
    case "offline":
      return { text: "Offline, retrying", problem: true };
    case "budget-exhausted":
      return { text: "Daily relay limit reached, retrying tomorrow", problem: true };
    default:
      return undefined;
  }
}

/** How long an allowed phone has to show up in the list before Settings says it was not paired. */
const ALLOWED_GRACE_MS = 5_000;
/** Allow stays off this long after a request shows, so a click aimed at the code's buttons cannot land on it. */
const ALLOW_DELAY_MS = 1_000;

type PairingOutcome = { kind: "paired"; name: string } | { kind: "ended" } | { kind: "not-allowed" };

function stopTimer(timer: { current: ReturnType<typeof setTimeout> | undefined }) {
  clearTimeout(timer.current);
  timer.current = undefined;
}

/**
 * Remembers how the last pairing code ended: a phone paired with it, it expired or was used, or a phone used it through
 * the relay and was not allowed.
 */
function usePairingOutcome(status: MobileAccessStatus | undefined) {
  const [outcome, setOutcome] = useState<PairingOutcome>();
  const opened = useRef<{ devices: readonly PairedPhone[]; asked: boolean; allowed: boolean } | undefined>(undefined);
  const cancelled = useRef(false);
  const grace = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => stopTimer(grace), []);
  useEffect(() => {
    if (!status) return;
    // A relay phone used the code but waits for an answer, so the pairing has not ended yet.
    if (status.pairing || status.pairingRequest) {
      opened.current ??= { devices: status.devices, asked: false, allowed: false };
      if (status.pairingRequest) opened.current.asked = true;
      setOutcome(undefined);
      return;
    }
    const before = opened.current;
    opened.current = undefined;
    if (!before) return;
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const added = newlyPaired(before.devices, status.devices);
    // An allowed phone shows up in the list a moment after the request ends, unless it left first.
    if (!added && before.allowed) {
      opened.current = before;
      grace.current ??= setTimeout(() => {
        grace.current = undefined;
        if (opened.current !== before) return;
        opened.current = undefined;
        setOutcome({ kind: "not-allowed" });
      }, ALLOWED_GRACE_MS);
      return;
    }
    stopTimer(grace);
    setOutcome(
      added ? { kind: "paired", name: added.name } : before.asked ? { kind: "not-allowed" } : { kind: "ended" },
    );
  }, [status]);
  return {
    outcome,
    markCancelled: () => {
      cancelled.current = true;
    },
    markAllowed: () => {
      if (opened.current) opened.current.allowed = true;
    },
    clear: () => {
      stopTimer(grace);
      opened.current = undefined;
      setOutcome(undefined);
    },
  };
}

export function MobileAccessSection() {
  const access = useMobileAccess();
  const status = access.state.status === "ready" ? access.state.value : undefined;
  const pairing = usePairingOutcome(status);
  const now = useNow(Boolean(status?.pairing) || Boolean(status?.pairingRequest) || Boolean(status?.devices.length));
  const requestId = status?.pairingRequest?.id;
  const [armedId, setArmedId] = useState<string>();
  useEffect(() => {
    if (!requestId) return;
    const timer = setTimeout(() => setArmedId(requestId), ALLOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [requestId]);
  const [copyState, copy] = useCopyFeedback();
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const header = (
    <SettingsPageHeader title="Phone access">
      Follow agents, answer their requests, and start new work from the ZLI Remote app.{" "}
      {status?.relay.enabled
        ? "The phone connects on the same network as this computer, or through your relay when it is away."
        : "The phone has to be on the same network as this computer."}
    </SettingsPageHeader>
  );

  if (access.state.status === "unavailable") {
    return (
      <>
        {header}
        <p className="settings-empty">Phone access is available in the ZLI desktop app only.</p>
      </>
    );
  }
  if (access.state.status === "loading") {
    return (
      <>
        {header}
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Loading phone access
        </p>
      </>
    );
  }
  if (access.state.status === "error") {
    return (
      <>
        {header}
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {access.state.message}
        </p>
        <div className="settings-actions">
          <Button size="sm" onClick={access.reload}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const value = access.state.value;
  const listening = value.state === "listening";
  const addresses = value.port ? value.hosts.map((host) => `${host}:${value.port}`) : [];
  const devices = [...value.devices].reverse();
  const connected = value.devices.filter((device) => device.connected).length;
  const relay = value.relay;
  const relayStatus = relayLine(value);
  const request = value.pairingRequest;

  return (
    <>
      {header}

      <SettingsGroup
        title="Connection"
        actions={
          value.state === "starting" ? (
            <Badge tone="neutral" spinner>
              Starting
            </Badge>
          ) : listening ? (
            <Badge tone="success" dot>
              Listening
            </Badge>
          ) : (
            <Badge tone="quiet">Off</Badge>
          )
        }
      >
        <Switch
          label="Allow phones on this network"
          hint={
            value.port
              ? `ZLI listens on port ${value.port}. Only paired phones get past the handshake.`
              : "Off until you turn it on. Only paired phones get past the handshake."
          }
          checked={value.enabled}
          disabled={access.busy || value.state === "starting"}
          onChange={(enabled) => {
            pairing.clear();
            void access.setEnabled(enabled);
          }}
        />
        {listening ? (
          <SettingsRow label="Address" description="Paired phones reach this computer here.">
            {addresses.length > 0 ? (
              <span className="settings-value is-mono mobile-addresses">
                {addresses.map((address) => (
                  <span key={address}>{address}</span>
                ))}
              </span>
            ) : (
              <span className="settings-value">No network connection</span>
            )}
          </SettingsRow>
        ) : null}
        <Switch
          label="Connect from anywhere"
          hint={
            !relay.available
              ? "This build has no relay set up."
              : relay.enabled
                ? `${RELAY_NOTE} ${RELAY_OFF_WARNING}`
                : RELAY_NOTE
          }
          checked={relay.enabled}
          // Still turns off if a build without a relay finds it on, so the old room can be dropped.
          disabled={access.busy || (!relay.available && !relay.enabled)}
          onChange={(enabled) => void access.setRelayEnabled(enabled)}
        />
        {relay.errorMessage ? (
          <p className="setting-placeholder is-problem" role="alert">
            {relay.errorMessage}
          </p>
        ) : null}
        {relayStatus ? (
          <p className={`setting-placeholder${relayStatus.problem ? " is-problem" : ""}`} role="status">
            {relayStatus.text}
          </p>
        ) : null}
        {relay.enabled && listening && relay.state === "replaced" ? (
          <SettingsRow
            label="Relay"
            description="Another PC is using this pairing. Taking it back disconnects that PC from the relay."
          >
            <Button size="sm" disabled={access.busy} onClick={() => void access.retryRelay()}>
              Take it back
            </Button>
          </SettingsRow>
        ) : null}
        {relay.enabled ? (
          <Switch
            label="Allow terminal input from anywhere"
            hint="When off, a phone away from this network can read terminals but cannot open one or type into it. Agents it starts or messages can still run commands, as their approval settings allow."
            checked={relay.remoteTerminalInput}
            disabled={access.busy}
            onChange={(enabled) => void access.setRemoteTerminalInput(enabled)}
          />
        ) : null}
        {value.errorMessage ? (
          <p className="setting-placeholder is-problem" role="alert">
            {value.errorMessage}
          </p>
        ) : null}
        {access.actionError ? (
          <p className="setting-placeholder is-problem" role="alert">
            {access.actionError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Pair a phone">
        {request ? (
          <section aria-label="Pairing request">
            <SettingsRow
              label={
                <>
                  Allow "<bdi>{request.deviceName}</bdi>" to control this PC from anywhere?
                </>
              }
              description={
                <>
                  It used your pairing code through your relay. Allow only if your phone shows this code. Expires in{" "}
                  <span className="mobile-countdown">{countdown(request.expiresAt, now)}</span>.
                </>
              }
            >
              <div className="mobile-pairing-actions">
                <span className="mobile-confirm-code">{`${request.code.slice(0, 3)} ${request.code.slice(3)}`}</span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={access.busy || armedId !== request.id}
                  onClick={() => {
                    pairing.markAllowed();
                    void access.respondToPairing(request.id, true);
                  }}
                >
                  Allow
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={access.busy}
                  onClick={() => void access.respondToPairing(request.id, false)}
                >
                  Don't allow
                </Button>
              </div>
            </SettingsRow>
          </section>
        ) : null}
        {!listening ? (
          <p className="setting-placeholder">Turn on Allow phones on this network to pair a phone.</p>
        ) : request && !value.pairing ? null : value.pairing ? (
          <section className="mobile-pairing" aria-label="Pair a new phone">
            <PairingCode code={value.pairing.code} />
            <div className="mobile-pairing-copy">
              <h5 className="mobile-pairing-title">Scan with ZLI Remote</h5>
              <ol className="mobile-steps">
                <li>Open ZLI Remote on the phone.</li>
                <li>Choose Scan pairing code and point the camera here.</li>
                <li>Check the desktop name on the phone, then choose Pair.</li>
              </ol>
              <p className="settings-footnote" aria-live="polite">
                Works for one phone. Expires in{" "}
                <span className="mobile-countdown">{countdown(value.pairing.expiresAt, now)}</span>.
              </p>
              <div className="mobile-pairing-actions">
                <Button size="sm" icon="copy" onClick={() => copy(value.pairing?.code ?? "")}>
                  {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={access.busy}
                  onClick={() => {
                    pairing.markCancelled();
                    void access.cancelPairing();
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="settings-footnote">No camera? Copy the code and paste it into the app.</p>
            </div>
          </section>
        ) : (
          <>
            {pairing.outcome?.kind === "paired" ? (
              <p className="settings-done" role="status">
                <Icon name="check" size={13} />
                Paired with {pairing.outcome.name}.
              </p>
            ) : null}
            {pairing.outcome?.kind === "not-allowed" ? (
              <p className="setting-placeholder" role="status">
                The phone was not paired. Make a new code to try again.
              </p>
            ) : null}
            {pairing.outcome?.kind === "ended" ? (
              <p className="setting-placeholder" role="status">
                The pairing code expired or was already used. Make a new one to pair a phone.
              </p>
            ) : null}
            <SettingsRow
              label="New phone"
              description={
                value.hosts.length === 0
                  ? "This computer has no network connection, so a phone cannot reach it."
                  : "Shows a one-time code for the ZLI Remote app. It works for 5 minutes."
              }
            >
              <Button
                size="sm"
                variant="primary"
                icon="smartphone"
                loading={access.busy}
                disabled={value.hosts.length === 0}
                onClick={() => {
                  pairing.clear();
                  void access.startPairing();
                }}
              >
                Pair a new phone
              </Button>
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Paired phones"
        actions={
          value.devices.length > 0 ? (
            <span className="mobile-paired-count">
              {connected > 0 ? `${connected} of ${value.devices.length} connected` : `${value.devices.length} paired`}
            </span>
          ) : null
        }
      >
        {devices.length === 0 ? (
          <p className="setting-placeholder">
            {value.enabled ? "No phones are paired yet." : "No phones are paired. Turn on phone access to pair one."}
          </p>
        ) : (
          <ul className="mobile-device-rows" aria-label="Paired phones">
            {devices.map((device) => (
              <li className="mobile-device-row" key={device.deviceId}>
                <span className="mobile-device-tile" aria-hidden="true">
                  <Icon name="smartphone" size={15} />
                </span>
                <span className="mobile-device-copy">
                  <span className="mobile-device-name">{device.name}</span>
                  <span className="mobile-device-meta">{deviceDetail(device, now)}</span>
                  {device.push ? (
                    <span className="mobile-device-meta">Gets alerts while ZLI Remote is closed</span>
                  ) : null}
                </span>
                {device.connected ? (
                  <Badge tone="success" dot>
                    Connected
                  </Badge>
                ) : null}
                <span className="mobile-device-action">
                  {confirmRemove === device.deviceId ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="is-danger"
                        disabled={access.busy}
                        aria-label={`Remove ${device.name} for good`}
                        onClick={() => {
                          setConfirmRemove(undefined);
                          void access.revoke(device.deviceId);
                        }}
                      >
                        Remove
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(undefined)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={access.busy}
                      aria-label={`Revoke ${device.name}`}
                      onClick={() => setConfirmRemove(device.deviceId)}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <p className="settings-footnote mobile-security">
        <Icon name="lock" size={13} />
        <span>
          Messages between a paired phone and this computer are encrypted with keys made when they paired. A paired
          phone can start agents and type into terminals in your projects, so revoke any phone you no longer use.
          Revoking disconnects it right away.
        </span>
      </p>
    </>
  );
}
