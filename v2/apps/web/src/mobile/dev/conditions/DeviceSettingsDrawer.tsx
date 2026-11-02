import {
  type ConditionSupport,
  DEVICE_PERMISSION_LABELS,
  DEVICE_PERMISSIONS,
  DEVICE_TEXT_SIZE_LABELS,
  type DeviceAppearance,
  DeviceAppId,
  type DeviceConditions,
  type DeviceLocation,
  type DevicePermission,
  type DeviceTextSize,
  DeviceTextSize as DeviceTextSizes,
  deviceConditionSupport,
  Latitude,
  LOCATION_PRESETS,
  Longitude,
  type MobileConditionResult,
  type MobileDevice,
} from "@zli-v2/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button, IconButton } from "../../../ui/Button.js";
import { Select } from "../../../ui/Field.js";
import { Icon } from "../../../ui/Icon.js";
import { MenuButton } from "../../../ui/Menu.js";
import { Segmented } from "../../../ui/Segmented.js";
import { errorText } from "../../mobile.js";
import type { DoctorApi } from "../doctor/bridge.js";
import type { ConditionsApi } from "./bridge.js";
import "./conditions.css";

type Row = "appearance" | "textSize" | "location" | "permission" | "notification";
type Result = { readonly tone: "done" | "error"; readonly text: string };

/**
 * Appearance, text size, location, app permissions, and a test notification for the shown device, under the
 * device buttons. Each change reports what it did, or why it failed, on the line under its control. While an
 * agent holds the device the drawer waits for Take over, as the logs drawer does.
 */
export function DeviceSettingsDrawer({
  conditions,
  doctor,
  worktreeId,
  device,
  inputBlocked,
  onBlockedInput,
  onClose,
}: {
  conditions: ConditionsApi;
  /** Fills the app id from the project's app.json or Gradle file when the person has not typed one. */
  doctor?: Pick<DoctorApi, "check"> | undefined;
  worktreeId?: string | undefined;
  device: MobileDevice;
  inputBlocked: boolean;
  onBlockedInput(): void;
  onClose(): void;
}) {
  const deviceId = device.deviceId;
  const support = deviceConditionSupport(device);
  const [current, setCurrent] = useState<DeviceConditions>({});
  const [results, setResults] = useState<Partial<Record<Row, Result>>>({});
  const [busy, setBusy] = useState<ReadonlySet<Row>>(() => new Set());
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [appId, setAppId] = useState("");
  const appIdTyped = useRef(false);
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (inputBlocked) return;
    let live = true;
    // What the device reports only marks the pressed segment, so a failed read leaves none pressed.
    conditions.get(deviceId).then(
      (read) => live && setCurrent(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [conditions, deviceId, inputBlocked]);

  useEffect(() => {
    if (!doctor || !worktreeId) return;
    let live = true;
    doctor.check(worktreeId).then(
      (facts) => {
        const id = facts.appIds?.[device.platform];
        if (live && id && !appIdTyped.current && DeviceAppId.safeParse(id).success) setAppId(id);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [doctor, worktreeId, device.platform]);

  const show = (row: Row, result: Result | undefined) => setResults((all) => ({ ...all, [row]: result }));

  const run = async (row: Row, action: () => Promise<MobileConditionResult>, fallback: string) => {
    if (inputBlocked) return onBlockedInput();
    if (busy.has(row)) return;
    setBusy((rows) => new Set(rows).add(row));
    show(row, undefined);
    try {
      show(row, { tone: "done", text: (await action()).message });
      return true;
    } catch (cause) {
      show(row, { tone: "error", text: errorText(cause, fallback) });
      return false;
    } finally {
      setBusy((rows) => {
        const next = new Set(rows);
        next.delete(row);
        return next;
      });
    }
  };

  const changeAppearance = async (appearance: DeviceAppearance) => {
    if (await run("appearance", () => conditions.setAppearance(deviceId, appearance), "The appearance did not change."))
      setCurrent((read) => ({ ...read, appearance }));
  };
  const changeTextSize = async (textSize: DeviceTextSize) => {
    if (await run("textSize", () => conditions.setTextSize(deviceId, textSize), "The text size did not change."))
      setCurrent((read) => ({ ...read, textSize }));
  };
  const setLocation = (location: DeviceLocation) =>
    void run("location", () => conditions.setLocation(deviceId, location), "The location did not change.");
  const submitLocation = () => {
    const parsed = parseLocation(latitude, longitude);
    if ("error" in parsed) return show("location", { tone: "error", text: parsed.error });
    setLatitude(String(parsed.latitude));
    setLongitude(String(parsed.longitude));
    setLocation(parsed);
  };
  const checkedAppId = (row: Row): string | undefined => {
    const id = appId.trim();
    if (!id) {
      show(row, { tone: "error", text: "Type the app id first, such as com.example.app." });
      return undefined;
    }
    const parsed = DeviceAppId.safeParse(id);
    if (!parsed.success) {
      show(row, { tone: "error", text: "Use an app id such as com.example.app." });
      return undefined;
    }
    return parsed.data;
  };
  const changePermission = (grant: boolean) => {
    const id = checkedAppId("permission");
    if (!id) return;
    void run(
      "permission",
      () => conditions.setPermission(deviceId, { appId: id, permission, grant }),
      grant ? "The permission was not granted." : "The permission was not revoked.",
    );
  };
  const sendNotification = () => {
    const id = checkedAppId("notification");
    if (!id) return;
    if (!title.trim() && !body.trim())
      return show("notification", { tone: "error", text: "Give the notification a title or a body." });
    void run(
      "notification",
      () => conditions.sendNotification(deviceId, { appId: id, title: title.trim(), body: body.trim() }),
      "The notification was not sent.",
    );
  };

  const permissionSupport = support.permissions[permission];

  return (
    <section className="mobile-tools" aria-label="Device settings">
      <div className="mobile-tools-head">
        <Icon name="settings" size={12} />
        <span className="mobile-tools-title">Device settings</span>
        <IconButton icon="x" size="xs" label="Close device settings" onClick={onClose} />
      </div>
      {inputBlocked ? (
        <p className="mobile-tools-note">Take over to change this device's settings.</p>
      ) : (
        <div className="mobile-tools-body">
          <ToolRow label="Appearance" support={support.appearance} result={results.appearance}>
            <Segmented<DeviceAppearance>
              label="Appearance"
              value={current.appearance}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(value) => void changeAppearance(value)}
            />
            {busy.has("appearance") ? <span className="spinner" aria-hidden="true" /> : null}
          </ToolRow>
          <ToolRow label="Text size" support={support.textSize} result={results.textSize}>
            <Segmented<DeviceTextSize>
              label="Text size"
              value={current.textSize}
              options={DeviceTextSizes.options.map((size) => ({ value: size, label: DEVICE_TEXT_SIZE_LABELS[size] }))}
              onChange={(value) => void changeTextSize(value)}
            />
            {busy.has("textSize") ? <span className="spinner" aria-hidden="true" /> : null}
          </ToolRow>
          <ToolRow label="Location" support={support.location} result={results.location}>
            <form
              className="mobile-tools-inline"
              onSubmit={(event) => {
                event.preventDefault();
                submitLocation();
              }}
            >
              <input
                className="input input-sm mobile-tools-number"
                aria-label="Latitude"
                placeholder="Latitude"
                inputMode="decimal"
                spellCheck={false}
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
              />
              <input
                className="input input-sm mobile-tools-number"
                aria-label="Longitude"
                placeholder="Longitude"
                inputMode="decimal"
                spellCheck={false}
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
              />
              <Button type="submit" size="sm" loading={busy.has("location")}>
                Set
              </Button>
              <MenuButton
                label="Set a city's location"
                tooltip="Set a city's location"
                icon="globe"
                items={() =>
                  LOCATION_PRESETS.map((place) => ({
                    id: place.id,
                    label: place.label,
                    run: () => {
                      setLatitude(String(place.latitude));
                      setLongitude(String(place.longitude));
                      setLocation({ latitude: place.latitude, longitude: place.longitude });
                    },
                  }))
                }
              >
                Cities
              </MenuButton>
              {support.clearLocation.ok ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run("location", () => conditions.clearLocation(deviceId), "The location was not cleared.")
                  }
                >
                  Clear
                </Button>
              ) : null}
            </form>
          </ToolRow>
          <div className="mobile-tools-row">
            <span className="mobile-tools-label">App</span>
            <div className="mobile-tools-controls">
              <input
                className="input input-sm mobile-tools-app"
                aria-label="App id"
                placeholder="com.example.app"
                spellCheck={false}
                autoCapitalize="off"
                value={appId}
                onChange={(event) => {
                  appIdTyped.current = true;
                  setAppId(event.target.value);
                }}
              />
            </div>
          </div>
          <ToolRow label="Permission" support={{ ok: true }} result={results.permission}>
            <Select<DevicePermission>
              label="Permission"
              className="mobile-tools-permission"
              value={permission}
              options={DEVICE_PERMISSIONS.map((value) => {
                const entry = support.permissions[value];
                return {
                  value,
                  label: DEVICE_PERMISSION_LABELS[value],
                  ...(entry.ok ? {} : { description: "Not available on this device" }),
                };
              })}
              onChange={(value) => {
                setPermission(value);
                show("permission", undefined);
              }}
            />
            <Button
              size="sm"
              disabled={!permissionSupport.ok}
              loading={busy.has("permission")}
              onClick={() => changePermission(true)}
            >
              Grant
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!permissionSupport.ok || busy.has("permission")}
              onClick={() => changePermission(false)}
            >
              Revoke
            </Button>
            {permissionSupport.ok ? null : <p className="mobile-tools-note">{permissionSupport.reason}</p>}
          </ToolRow>
          <ToolRow label="Notification" support={support.notification} result={results.notification}>
            <form
              className="mobile-tools-inline"
              onSubmit={(event) => {
                event.preventDefault();
                sendNotification();
              }}
            >
              <input
                className="input input-sm"
                aria-label="Notification title"
                placeholder="Title"
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <input
                className="input input-sm"
                aria-label="Notification text"
                placeholder="Text"
                maxLength={500}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <Button type="submit" size="sm" loading={busy.has("notification")}>
                Send
              </Button>
            </form>
          </ToolRow>
        </div>
      )}
    </section>
  );
}

/** One setting: its label, then the controls, or the reason this device has none, then what the last change did. */
function ToolRow({
  label,
  support,
  result,
  children,
}: {
  label: string;
  support: ConditionSupport;
  result: Result | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mobile-tools-row">
      <span className="mobile-tools-label">{label}</span>
      <div className="mobile-tools-controls">
        {support.ok ? children : <p className="mobile-tools-note">{support.reason}</p>}
      </div>
      {result ? (
        <p
          className={`mobile-tools-result${result.tone === "error" ? " is-error" : ""}`}
          role={result.tone === "error" ? "alert" : "status"}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}

/** Reads the two fields, and also takes "37.77, -122.42" pasted whole into the first one. */
export function parseLocation(latitudeText: string, longitudeText: string): DeviceLocation | { error: string } {
  let latText = latitudeText.trim();
  let lonText = longitudeText.trim();
  if (!lonText && latText.includes(",")) [latText = "", lonText = ""] = latText.split(",").map((part) => part.trim());
  if (!latText || !lonText) return { error: "Type a latitude and a longitude, such as 37.7749 and -122.4194." };
  const lat = Latitude.safeParse(Number(latText));
  const lon = Longitude.safeParse(Number(lonText));
  if (!/^-?\d+(\.\d+)?$/u.test(latText) || !lat.success)
    return { error: "Latitude is a number from -90 to 90, such as 37.7749." };
  if (!/^-?\d+(\.\d+)?$/u.test(lonText) || !lon.success)
    return { error: "Longitude is a number from -180 to 180, such as -122.4194." };
  return { latitude: lat.data, longitude: lon.data };
}
