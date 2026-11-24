import {
  adbQrPayload,
  type MobileDevice,
  MobilePairingCode,
  type MobileWifiResult,
  readAdbAddress,
  readAdbPort,
} from "@zli-v2/contracts";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { qrPath } from "../settings/mobileAccessView.js";
import { connectionLabel, deviceStateLabel, errorText, phoneStateHint } from "./mobile.js";

type Mode = "qr" | "pair" | "connect";
type Busy = { kind: "pair" } | { kind: "connect" } | { kind: "disconnect"; deviceId: string };

export type PhoneConnectionsBridge = Pick<
  MobileBridge,
  "pairWifi" | "connectWifi" | "disconnectWifi" | "pairWifiQr" | "cancelWifiQr"
>;

const QUIET_ZONE = 4;
const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const MIXED = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function randomText(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** A fresh name and password for one QR pairing; the phone advertises the name once it has scanned the code. */
function newQrCredentials(): { name: string; password: string } {
  return { name: `zli-${randomText(LETTERS, 8)}`, password: randomText(MIXED, 10) };
}

function PairingQr({ text }: { text: string }) {
  const { size, path } = useMemo(() => qrPath(text), [text]);
  const box = size + QUIET_ZONE * 2;
  return (
    <svg
      className="phone-qr"
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

/**
 * The Android phones adb can see, with Disconnect for the ones on Wi-Fi, and the two ways to reach a phone
 * over Wi-Fi: pair with the code from Wireless debugging (Android 11 and newer), or connect to an address
 * that already trusts this computer.
 */
export function PhoneConnections({
  mobile,
  devices,
  adbFound,
  focusConnect,
  onConnected,
  onChanged,
}: {
  mobile: PhoneConnectionsBridge;
  devices: readonly MobileDevice[];
  /** Without adb nothing can connect, so the forms stay disabled. */
  adbFound: boolean;
  /** Focus the first field when the section opens, as when the person picked Connect a phone. */
  focusConnect: boolean;
  /** A phone connected; the pane shows it. */
  onConnected(result: MobileWifiResult & { deviceId: string }): void;
  /** Rereads the device list after a disconnect or a pairing that did not connect. */
  onChanged(): void;
}) {
  const ids = useId();
  const canQr = !!mobile.pairWifiQr;
  const [mode, setMode] = useState<Mode>(canQr ? "qr" : "pair");
  /** Counts up for a new QR code; each code is good for one pairing. */
  const [qrRound, setQrRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round makes a new code.
  const qr = useMemo(() => newQrCredentials(), [qrRound]);
  const [waiting, setWaiting] = useState(false);
  const [pairAddress, setPairAddress] = useState("");
  const [code, setCode] = useState("");
  const [connectPort, setConnectPort] = useState("");
  const [address, setAddress] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const firstField = useRef<HTMLInputElement>(null);
  const addressField = useRef<HTMLInputElement>(null);
  const phones = devices.filter((device) => device.platform === "android" && device.kind === "physical");

  useEffect(() => {
    if (focusConnect && adbFound) firstField.current?.focus();
  }, [focusConnect, adbFound]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: finish and onChanged read the latest props on purpose.
  useEffect(() => {
    const pairQr = mobile.pairWifiQr;
    if (mode !== "qr" || !adbFound || !pairQr) return;
    let live = true;
    setWaiting(true);
    setError(undefined);
    pairQr(qr)
      .then((result) => {
        if (!live) return;
        setWaiting(false);
        finish(result);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setWaiting(false);
        setError(errorText(cause, "The phone could not be paired."));
      });
    return () => {
      live = false;
      void mobile.cancelWifiQr?.();
    };
  }, [mode, adbFound, qr]);

  const pairCheck = readAdbAddress(pairAddress);
  const codeCheck = MobilePairingCode.safeParse(code);
  const portCheck = connectPort.trim() ? readAdbPort(connectPort) : undefined;
  const addressCheck = readAdbAddress(address);
  const problems =
    mode === "qr"
      ? {}
      : mode === "pair"
        ? {
            pairAddress: pairCheck.ok ? undefined : pairCheck.problem,
            code: codeCheck.success ? undefined : codeCheck.error.issues[0]?.message,
            connectPort: portCheck && !portCheck.ok ? portCheck.problem : undefined,
          }
        : { address: addressCheck.ok ? undefined : addressCheck.problem };
  const shown = (key: keyof typeof problems) => (checked ? problems[key] : undefined);
  const disabled = !adbFound || busy !== undefined;

  const switchMode = (next: Mode) => {
    setMode(next);
    setChecked(false);
    setError(undefined);
  };

  const finish = (result: MobileWifiResult) => {
    if (result.connected && result.deviceId) {
      onConnected({ ...result, deviceId: result.deviceId });
      return;
    }
    setDone(result.message);
    onChanged();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || mode === "qr") return;
    setChecked(true);
    if (Object.values(problems).some(Boolean)) return;
    setError(undefined);
    setDone(undefined);
    if (mode === "pair") {
      const pair = mobile.pairWifi;
      if (!pair || !pairCheck.ok || !codeCheck.success) return;
      setBusy({ kind: "pair" });
      try {
        const result = await pair({
          host: pairCheck.host,
          pairPort: pairCheck.port,
          code: codeCheck.data,
          ...(portCheck?.ok ? { connectPort: portCheck.port } : {}),
        });
        setCode("");
        setChecked(false);
        if (!result.connected) {
          // The pairing stuck, so only the connect port is missing; the connect form takes it from here.
          setMode("connect");
          setAddress(`${pairCheck.host}:`);
          requestAnimationFrame(() => addressField.current?.focus());
        }
        finish(result);
      } catch (cause) {
        setError(errorText(cause, "The phone could not be paired."));
      } finally {
        setBusy(undefined);
      }
      return;
    }
    const connect = mobile.connectWifi;
    if (!connect || !addressCheck.ok) return;
    setBusy({ kind: "connect" });
    try {
      finish(await connect({ host: addressCheck.host, port: addressCheck.port }));
      setChecked(false);
    } catch (cause) {
      setError(errorText(cause, "The phone could not be connected."));
    } finally {
      setBusy(undefined);
    }
  };

  const disconnect = async (device: MobileDevice) => {
    const run = mobile.disconnectWifi;
    if (!run) return;
    setBusy({ kind: "disconnect", deviceId: device.deviceId });
    setError(undefined);
    setDone(undefined);
    try {
      await run(device.deviceId);
      setDone(`Disconnected ${device.name}.`);
    } catch (cause) {
      setError(errorText(cause, `${device.name} could not be disconnected.`));
    } finally {
      setBusy(undefined);
      onChanged();
    }
  };

  return (
    <section className="mobile-setup-section" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className="mobile-setup-title">
        Your phone
      </h3>
      <p className="mobile-setup-text">
        Connect over Wi-Fi on Android 11 and newer, or plug in with USB debugging on and it shows up here by itself.
      </p>
      {error ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{error}</span>
        </div>
      ) : null}
      <div role="status">
        {done ? (
          <div className="banner banner-info">
            <Icon name="check" size={14} />
            <span className="banner-message">{done}</span>
          </div>
        ) : null}
      </div>
      {phones.length > 0 ? (
        <ul className="mobile-avd-list" aria-label="Phones">
          {phones.map((device) => {
            const hint = phoneStateHint(device);
            const via = connectionLabel(device);
            const disconnecting = busy?.kind === "disconnect" && busy.deviceId === device.deviceId;
            return (
              <li key={device.deviceId} className="mobile-avd">
                <span className="mobile-avd-copy">
                  <span className="mobile-avd-name">{device.name}</span>
                  <span className="mobile-avd-detail">
                    {[via, device.connection === "wifi" ? device.serial : undefined, deviceStateLabel(device)]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                  {hint ? <span className="mobile-avd-detail is-warning">{hint}</span> : null}
                </span>
                {device.connection === "wifi" && mobile.disconnectWifi ? (
                  <span className="mobile-avd-actions">
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={disconnecting}
                      disabled={busy !== undefined && !disconnecting}
                      aria-label={`Disconnect ${device.name}`}
                      onClick={() => void disconnect(device)}
                    >
                      Disconnect
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!adbFound ? (
        <p className="mobile-setup-hint">
          Connecting a phone needs adb from the Android platform tools. Install them with the setup above, then refresh.
        </p>
      ) : null}
      {mobile.pairWifi && mobile.connectWifi ? (
        <form
          className="mobile-avd-form"
          aria-labelledby={`${ids}-wifi`}
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <h4 id={`${ids}-wifi`} className="mobile-avd-form-title sr-only">
            Connect over Wi-Fi
          </h4>
          <Segmented<Mode>
            label="How to connect"
            value={mode}
            options={[
              ...(canQr
                ? [{ value: "qr" as const, label: "Scan QR code", tooltip: "Scan the code with the phone's camera" }]
                : []),
              { value: "pair", label: "Pairing code", tooltip: "Type the 6-digit code the phone shows" },
              { value: "connect", label: "Address", tooltip: "For a phone that is already paired" },
            ]}
            onChange={switchMode}
          />
          {mode === "qr" ? (
            <div className="phone-qr-step">
              {adbFound ? <PairingQr text={adbQrPayload(qr.name, qr.password)} /> : null}
              <div className="phone-qr-copy">
                <ol className="mobile-setup-list">
                  <li>On the phone, open Settings, then Developer options, then Wireless debugging.</li>
                  <li>Tap Pair device with QR code and scan this code.</li>
                </ol>
                <p className="phone-qr-status" role="status">
                  {!adbFound ? null : waiting ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Waiting for your phone
                    </>
                  ) : (
                    "The code expired."
                  )}
                </p>
                <Button size="xs" variant="ghost" icon="reload" onClick={() => setQrRound((round) => round + 1)}>
                  New code
                </Button>
                <p className="mobile-setup-hint">The phone and this computer need to be on the same Wi-Fi.</p>
              </div>
            </div>
          ) : mode === "pair" ? (
            <>
              <ol className="mobile-setup-list">
                <li>On the phone, open Settings, then Developer options, then Wireless debugging, and turn it on.</li>
                <li>Tap Pair device with pairing code.</li>
                <li>Enter the IP address and port and the 6-digit code it shows.</li>
              </ol>
              <Field
                label="Pairing address"
                {...(shown("pairAddress")
                  ? { hint: shown("pairAddress"), hintTone: "warning" as const }
                  : { hint: "Shown under the code, such as 192.168.1.20:37123." })}
              >
                <input
                  ref={firstField}
                  className="input is-mono"
                  value={pairAddress}
                  placeholder="192.168.1.20:37123"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={260}
                  disabled={!adbFound}
                  aria-invalid={shown("pairAddress") ? true : undefined}
                  onChange={(event) => setPairAddress(event.target.value)}
                />
              </Field>
              <Field
                label="Pairing code"
                {...(shown("code") ? { hint: shown("code"), hintTone: "warning" as const } : {})}
              >
                <input
                  className="input is-mono"
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  disabled={!adbFound}
                  aria-invalid={shown("code") ? true : undefined}
                  onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))}
                />
              </Field>
              <Field
                label="Connect port (optional)"
                {...(shown("connectPort")
                  ? { hint: shown("connectPort"), hintTone: "warning" as const }
                  : {
                      hint: "The port under IP address & port on the Wireless debugging screen. Leave it empty and ZLI looks it up.",
                    })}
              >
                <input
                  className="input is-mono"
                  value={connectPort}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={5}
                  disabled={!adbFound}
                  aria-invalid={shown("connectPort") ? true : undefined}
                  onChange={(event) => setConnectPort(event.target.value.replace(/\D/gu, ""))}
                />
              </Field>
            </>
          ) : (
            <Field
              label="Address"
              {...(shown("address")
                ? { hint: shown("address"), hintTone: "warning" as const }
                : {
                    hint: "The IP address & port on the Wireless debugging screen, or a phone set up with adb tcpip.",
                  })}
            >
              <input
                ref={addressField}
                className="input is-mono"
                value={address}
                placeholder="192.168.1.20:39457"
                spellCheck={false}
                autoComplete="off"
                maxLength={260}
                disabled={!adbFound}
                aria-invalid={shown("address") ? true : undefined}
                onChange={(event) => setAddress(event.target.value)}
              />
            </Field>
          )}
          <div className="mobile-setup-actions" hidden={mode === "qr"}>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon="smartphone"
              loading={busy?.kind === mode}
              disabled={!adbFound || (busy !== undefined && busy.kind !== mode)}
            >
              {mode === "pair" ? "Pair and connect" : "Connect"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
