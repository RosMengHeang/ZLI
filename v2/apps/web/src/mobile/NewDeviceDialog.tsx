import {
  type MobileAvdList,
  MobileAvdName,
  type MobileDevice,
  type MobileSimulatorCatalog,
  MobileSimulatorName,
} from "@zli-v2/contracts";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { ChoiceSegmented, FormSection } from "../ui/Choice.js";
import { Dialog } from "../ui/Dialog.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { LoadingState } from "../ui/Pane.js";
import { errorText, suggestAvdName, suggestSimulatorName, systemImageLabel } from "./mobile.js";

import "./newDevice.css";

export type NewDevicePlatform = "android" | "ios";

export type CreatedDevice =
  | { platform: "android"; name: string; avds: MobileAvdList }
  | { platform: "ios"; name: string; deviceId: string };

export type NewDeviceBridge = Pick<MobileBridge, "listAvds" | "createAvd" | "listSimulators" | "createSimulator">;

const PLATFORM_OPTIONS = [
  { value: "android", label: "Android emulator" },
  { value: "ios", label: "iPhone simulator" },
] as const;

/**
 * Creates an Android virtual device or an iPhone or iPad simulator from what is installed: a device profile and
 * system image for Android, a model and iOS version for the simulator. Nothing is downloaded here.
 */
export function NewDeviceDialog({
  mobile,
  platforms,
  devices,
  onCreated,
  onClose,
}: {
  mobile: NewDeviceBridge;
  /** The platforms this computer can create devices for, the one to start on first. */
  platforms: readonly NewDevicePlatform[];
  /** The devices already listed, so a new name does not repeat one. */
  devices: readonly MobileDevice[];
  onCreated(created: CreatedDevice): void;
  onClose(): void;
}) {
  const ids = useId();
  const [platform, setPlatform] = useState<NewDevicePlatform>(platforms[0] ?? "android");
  const [switched, setSwitched] = useState(false);
  const picker =
    platforms.length > 1 ? (
      <FormSection label="Platform">
        <ChoiceSegmented<NewDevicePlatform>
          name={`${ids}-platform`}
          label="Platform"
          value={platform}
          options={PLATFORM_OPTIONS.filter((option) => platforms.includes(option.value))}
          onChange={(next) => {
            setPlatform(next);
            setSwitched(true);
          }}
        />
      </FormSection>
    ) : null;
  return (
    <Dialog stacked label="New device" title="New device" scrimLabel="Close new device" onClose={onClose}>
      {/* Outside the forms, so switching platforms keeps focus on the switch. */}
      {picker ? <div className="dialog-body new-device-platform">{picker}</div> : null}
      {platform === "ios" ? (
        <IosForm mobile={mobile} devices={devices} autoFocus={!switched} onCreated={onCreated} onClose={onClose} />
      ) : (
        <AndroidForm mobile={mobile} autoFocus={!switched} onCreated={onCreated} onClose={onClose} />
      )}
    </Dialog>
  );
}

type FormProps = {
  mobile: NewDeviceBridge;
  /** Put focus in the name field once the lists have loaded. */
  autoFocus: boolean;
  onCreated(created: CreatedDevice): void;
  onClose(): void;
};

/** Loads once on mount. A load that returns nothing means the bridge cannot do it, which shows the fallback. */
function useLoaded<T>(load: () => Promise<T> | undefined, fallback: string) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  useEffect(() => {
    let disposed = false;
    const pending = loadRef.current();
    if (!pending) {
      setError(fallback);
      return;
    }
    pending
      .then((next) => {
        if (!disposed) setValue(next);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(errorText(cause, fallback));
      });
    return () => {
      disposed = true;
    };
  }, [fallback]);
  return { value, error };
}

function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className="inline-error" role="alert">
      <Icon name="alert" size={13} />
      {children}
    </p>
  );
}

function Footer({
  busy,
  busyText,
  canSubmit,
  onClose,
}: {
  busy: boolean;
  busyText: string;
  canSubmit: boolean;
  onClose(): void;
}) {
  return (
    <footer className="dialog-footer">
      <span className="dialog-footer-note" role="status">
        {busy ? busyText : null}
      </span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!canSubmit}>
        Create
      </Button>
    </footer>
  );
}

function AndroidForm({ mobile, autoFocus, onCreated, onClose }: FormProps) {
  const ids = useId();
  const { value: list, error: loadError } = useLoaded(
    () => mobile.listAvds(),
    "ZLI could not read the system images and device profiles.",
  );
  const [image, setImage] = useState<string>();
  const [profile, setProfile] = useState<string>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);

  const shownImage = image && list?.systemImages.includes(image) ? image : list?.systemImages.at(-1);
  const shownProfile = profile ?? list?.defaultDeviceProfile;
  const profileName = list?.deviceProfiles.find((entry) => entry.id === shownProfile)?.name ?? "Device";
  const taken = list?.avds.map((avd) => avd.name) ?? [];
  const shownName = nameEdited ? name : suggestAvdName(profileName, shownImage, taken);
  const ready = Boolean(list?.avdmanager && shownImage);

  useEffect(() => {
    if (ready && autoFocus) nameRef.current?.focus();
  }, [ready, autoFocus]);

  const nameCheck = MobileAvdName.safeParse(shownName);
  const nameProblem = !nameCheck.success
    ? nameCheck.error.issues[0]?.message
    : taken.some((existing) => existing.toLowerCase() === shownName.toLowerCase())
      ? "A virtual device with this name already exists."
      : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !shownImage || nameProblem || busy) return;
    const created = shownName;
    setBusy(true);
    setError(undefined);
    try {
      const avds = await mobile.createAvd({
        name: created,
        systemImage: shownImage,
        ...(shownProfile ? { device: shownProfile } : {}),
      });
      onCreated({ platform: "android", name: created, avds });
    } catch (cause) {
      setError(errorText(cause, `${created} could not be created.`));
      setBusy(false);
    }
  };

  let fields: ReactNode;
  if (loadError) fields = <InlineError>{loadError}</InlineError>;
  else if (!list) fields = <LoadingState label="Reading system images and device profiles" />;
  else if (!list.avdmanager)
    fields = (
      <p className="new-device-text">
        Creating virtual devices needs avdmanager, which comes with the Android command-line tools. Install them from
        Android Studio's SDK Manager, under SDK Tools, then try again.
      </p>
    );
  else if (list.systemImages.length === 0)
    fields = (
      <p className="new-device-text">
        No system images are installed, so there is nothing to create a device from. Install one with Android Studio's
        SDK Manager or sdkmanager, then try again.
      </p>
    );
  else
    fields = (
      <>
        <Field label="Name" {...(nameProblem ? { hint: nameProblem, hintTone: "warning" as const } : {})}>
          <input
            ref={nameRef}
            className="input is-mono"
            value={shownName}
            maxLength={60}
            spellCheck={false}
            disabled={busy}
            aria-invalid={nameProblem ? true : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
          />
        </Field>
        <FormSection label="Device profile" htmlFor={`${ids}-profile`}>
          <Select<string>
            id={`${ids}-profile`}
            label="Device profile"
            value={shownProfile ?? ""}
            options={list.deviceProfiles.map((entry) => ({ value: entry.id, label: entry.name }))}
            disabled={busy}
            onChange={setProfile}
          />
        </FormSection>
        <FormSection
          label="System image"
          htmlFor={`${ids}-image`}
          hint="Only system images already on this computer are listed. ZLI does not download new ones here."
        >
          <Select<string>
            id={`${ids}-image`}
            label="System image"
            value={shownImage ?? ""}
            options={list.systemImages.map((entry) => ({
              value: entry,
              label: systemImageLabel(entry),
              description: entry,
            }))}
            disabled={busy}
            onChange={setImage}
          />
        </FormSection>
      </>
    );

  return (
    <form className="new-device-form" aria-label="New Android emulator" onSubmit={(event) => void submit(event)}>
      <div className="dialog-body">
        {fields}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
      <Footer
        busy={busy}
        busyText={`Creating ${shownName}. This can take a minute.`}
        canSubmit={ready && !nameProblem}
        onClose={onClose}
      />
    </form>
  );
}

/** The newest iPhone the newest iOS version runs, or its first model when it runs no iPhone. */
function defaultModel(catalog: MobileSimulatorCatalog): string | undefined {
  const newest = catalog.runtimes.at(-1);
  if (!newest) return undefined;
  const iPhones = catalog.deviceTypes.filter(
    (type) => type.family === "iPhone" && newest.deviceTypeIds.includes(type.id),
  );
  return iPhones.at(-1)?.id ?? newest.deviceTypeIds[0];
}

function IosForm({ mobile, devices, autoFocus, onCreated, onClose }: FormProps & { devices: readonly MobileDevice[] }) {
  const ids = useId();
  const { value: catalog, error: loadError } = useLoaded(
    () => mobile.listSimulators?.(),
    "ZLI could not read the iPhone models and iOS versions from Xcode.",
  );
  const [model, setModel] = useState<string>();
  const [runtime, setRuntime] = useState<string>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameRef = useRef<HTMLInputElement>(null);

  const offered = catalog
    ? catalog.deviceTypes.filter((type) => catalog.runtimes.some((entry) => entry.deviceTypeIds.includes(type.id)))
    : [];
  const shownModel = model && offered.some((type) => type.id === model) ? model : catalog && defaultModel(catalog);
  const modelName = offered.find((type) => type.id === shownModel)?.name ?? "iPhone";
  const versions = (catalog?.runtimes ?? []).filter((entry) => shownModel && entry.deviceTypeIds.includes(shownModel));
  const shownRuntime = runtime && versions.some((entry) => entry.id === runtime) ? runtime : versions.at(-1)?.id;
  const taken = devices.filter((device) => device.platform === "ios").map((device) => device.name);
  const shownName = nameEdited ? name : suggestSimulatorName(modelName, taken);
  const ready = Boolean(catalog?.simctl && shownModel && shownRuntime);

  useEffect(() => {
    if (ready && autoFocus) nameRef.current?.focus();
  }, [ready, autoFocus]);

  const nameCheck = MobileSimulatorName.safeParse(shownName);
  const nameProblem = !nameCheck.success
    ? nameCheck.error.issues[0]?.message
    : taken.some((existing) => existing.toLowerCase() === shownName.toLowerCase())
      ? "A simulator with this name already exists."
      : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !shownModel || !shownRuntime || nameProblem || busy || !mobile.createSimulator) return;
    const created = shownName;
    setBusy(true);
    setError(undefined);
    try {
      const result = await mobile.createSimulator({ name: created, deviceTypeId: shownModel, runtimeId: shownRuntime });
      onCreated({ platform: "ios", name: result.name, deviceId: result.deviceId });
    } catch (cause) {
      setError(errorText(cause, `${created} could not be created.`));
      setBusy(false);
    }
  };

  let fields: ReactNode;
  if (loadError) fields = <InlineError>{loadError}</InlineError>;
  else if (!catalog) fields = <LoadingState label="Reading iPhone models and iOS versions from Xcode" />;
  else if (!catalog.simctl)
    fields = (
      <p className="new-device-text">
        iPhone simulators need Xcode. Install it from the App Store, open it once, then try again.
      </p>
    );
  else if (catalog.runtimes.length === 0)
    fields = (
      <p className="new-device-text">
        Xcode has no iOS version installed for simulators. Add one in Xcode under Settings &gt; Components, then try
        again.
      </p>
    );
  else
    fields = (
      <>
        <Field label="Name" {...(nameProblem ? { hint: nameProblem, hintTone: "warning" as const } : {})}>
          <input
            ref={nameRef}
            className="input"
            value={shownName}
            maxLength={60}
            spellCheck={false}
            disabled={busy}
            aria-invalid={nameProblem ? true : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
          />
        </Field>
        <FormSection label="Model" htmlFor={`${ids}-model`}>
          <Select<string>
            id={`${ids}-model`}
            label="Model"
            value={shownModel ?? ""}
            options={offered.map((type) => ({ value: type.id, label: type.name, group: type.family }))}
            disabled={busy}
            onChange={setModel}
          />
        </FormSection>
        <FormSection
          label="iOS version"
          htmlFor={`${ids}-runtime`}
          hint="Only iOS versions installed in Xcode that run this model are listed. Add others in Xcode under Settings > Components."
        >
          <Select<string>
            id={`${ids}-runtime`}
            label="iOS version"
            value={shownRuntime ?? ""}
            options={[...versions].reverse().map((entry) => ({ value: entry.id, label: entry.name }))}
            disabled={busy}
            onChange={setRuntime}
          />
        </FormSection>
      </>
    );

  return (
    <form className="new-device-form" aria-label="New iPhone simulator" onSubmit={(event) => void submit(event)}>
      <div className="dialog-body">
        {fields}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
      <Footer busy={busy} busyText={`Creating ${shownName}.`} canSubmit={ready && !nameProblem} onClose={onClose} />
    </form>
  );
}
