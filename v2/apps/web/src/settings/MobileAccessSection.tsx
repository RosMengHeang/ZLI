import type { MobileAccessStatus, MobileDevice } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCopyFeedback } from "../review/links.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Switch } from "../ui/Switch.js";
import { countdown, deviceDetail, newlyPaired, qrPath } from "./mobileAccessView.js";
import { SectionHeader, SettingRow } from "./SectionHeader.js";
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

type PairingOutcome = { kind: "paired"; name: string } | { kind: "ended" };

/** Remembers how the last pairing code ended: a phone paired with it, or it expired or was used. */
function usePairingOutcome(status: MobileAccessStatus | undefined) {
  const [outcome, setOutcome] = useState<PairingOutcome>();
  const opened = useRef<{ devices: readonly MobileDevice[] } | undefined>(undefined);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!status) return;
    if (status.pairing) {
      opened.current ??= { devices: status.devices };
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
    setOutcome(added ? { kind: "paired", name: added.name } : { kind: "ended" });
  }, [status]);
  return {
    outcome,
    markCancelled: () => {
      cancelled.current = true;
    },
    clear: () => setOutcome(undefined),
  };
}

export function MobileAccessSection() {
  const access = useMobileAccess();
  const status = access.state.status === "ready" ? access.state.value : undefined;
  const pairing = usePairingOutcome(status);
  const now = useNow(Boolean(status?.pairing) || Boolean(status?.devices.length));
  const [copyState, copy] = useCopyFeedback();
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const header = (
    <SectionHeader title="Mobile access">
      Follow agents, answer their requests, and send messages from the ZLI phone app. The phone has to be on the same
      network as this computer.
    </SectionHeader>
  );

  if (access.state.status === "unavailable") {
    return (
      <>
        {header}
        <p className="settings-empty">Mobile access is available in the ZLI desktop app only.</p>
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
  const address = value.port ? value.hosts.map((host) => `${host}:${value.port}`).join(", ") : "";

  return (
    <>
      {header}
      <div className="setting-list">
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
          <SettingRow label="Address" description="Paired phones reach this computer here.">
            <span className="settings-value is-mono" title={address}>
              {address || "No network connection"}
            </span>
          </SettingRow>
        ) : null}
      </div>
      {value.state === "starting" ? (
        <p className="loading-line">
          <span className="spinner" aria-hidden="true" />
          Starting phone access
        </p>
      ) : null}
      {value.errorMessage ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {value.errorMessage}
        </p>
      ) : null}
      {access.actionError ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {access.actionError}
        </p>
      ) : null}

      {listening && value.pairing ? (
        <section className="mobile-pairing" aria-label="Pair a new phone">
          <PairingCode code={value.pairing.code} />
          <div className="mobile-pairing-copy">
            <h4 className="mobile-pairing-title">Scan with the ZLI app</h4>
            <p className="settings-footnote">
              On the phone, open ZLI and choose Scan pairing code. If the camera is not available, copy the code and
              paste it there instead.
            </p>
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
          </div>
        </section>
      ) : null}

      {listening && !value.pairing ? (
        <>
          {pairing.outcome?.kind === "paired" ? (
            <p className="settings-done" role="status">
              <Icon name="check" size={13} />
              Paired with {pairing.outcome.name}.
            </p>
          ) : null}
          {pairing.outcome?.kind === "ended" ? (
            <p className="settings-empty" role="status">
              The pairing code expired or was already used. Make a new one to pair a phone.
            </p>
          ) : null}
          <div className="settings-actions">
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
          </div>
        </>
      ) : null}

      <h3 className="mcp-subhead">Paired phones</h3>
      {value.devices.length === 0 ? (
        <p className="settings-empty">
          {value.enabled ? "No phones are paired yet." : "No phones are paired. Turn on phone access to pair one."}
        </p>
      ) : (
        <ul className="mcp-rows" aria-label="Paired phones">
          {[...value.devices].reverse().map((device) => (
            <li className="mcp-row" key={device.deviceId}>
              <span
                className={`mcp-status-dot${device.connected ? " is-ok" : ""}`}
                role="img"
                aria-label={device.connected ? "Connected" : "Not connected"}
              />
              <span className="mcp-row-copy">
                <strong>{device.name}</strong>
                <span className="mcp-row-detail">{deviceDetail(device, now)}</span>
              </span>
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
            </li>
          ))}
        </ul>
      )}
      <p className="settings-footnote">
        Messages between a paired phone and this computer are encrypted with keys made when they paired. A paired phone
        can start agents and type into terminals in your projects, so revoke any phone you no longer use. Revoking
        disconnects it right away.
      </p>
    </>
  );
}
