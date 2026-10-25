import { MobileAvdName, type MobileAvdList, type MobileDevice } from "@zli-v2/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { FormSection } from "../ui/Choice.js";
import { Field, Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { errorText, stateLabel, suggestAvdName, systemImageLabel } from "./mobile.js";

const AVD_PREFIX = "android-avd:";

type Busy = { kind: "create" } | { kind: "delete"; name: string };

/**
 * The Android virtual devices on this computer, with Boot and Delete for each and a form to create one
 * from a system image that is already installed.
 */
export function VirtualDevices({
  mobile,
  devices,
  focusCreate,
  booting,
  onBoot,
  onChanged,
}: {
  mobile: Pick<MobileBridge, "listAvds" | "createAvd" | "deleteAvd">;
  devices: readonly MobileDevice[];
  /** Focus the name field when the section opens, as when the person picked New virtual device. */
  focusCreate: boolean;
  booting: boolean;
  onBoot(device: MobileDevice): void;
  /** Rereads the device list and the setup status after a device is created or deleted. */
  onChanged(): void;
}) {
  const ids = useId();
  const [list, setList] = useState<MobileAvdList>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [image, setImage] = useState<string>();
  const [profile, setProfile] = useState<string>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let disposed = false;
    mobile
      .listAvds()
      .then((next) => {
        if (!disposed) setList(next);
      })
      .catch((cause: unknown) => {
        if (!disposed) setLoadError(errorText(cause, "ZLI could not read the virtual devices."));
      });
    return () => {
      disposed = true;
    };
  }, [mobile]);

  const shownImage = image && list?.systemImages.includes(image) ? image : list?.systemImages.at(-1);
  const shownProfile = profile ?? list?.defaultDeviceProfile;
  const profileName = list?.deviceProfiles.find((entry) => entry.id === shownProfile)?.name ?? "Device";
  const taken = list?.avds.map((avd) => avd.name) ?? [];
  const shownName = nameEdited ? name : suggestAvdName(profileName, shownImage, taken);
  const canChange = Boolean(list?.avdmanager);
  const canCreate = canChange && Boolean(shownImage);

  useEffect(() => {
    if (focusCreate && canCreate) nameRef.current?.focus();
  }, [focusCreate, canCreate]);

  const nameCheck = MobileAvdName.safeParse(shownName);
  const nameProblem = !nameCheck.success
    ? nameCheck.error.issues[0]?.message
    : taken.some((existing) => existing.toLowerCase() === shownName.toLowerCase())
      ? "A virtual device with this name already exists."
      : undefined;

  const change = async (next: Busy, work: () => Promise<MobileAvdList>, success: string, fallback: string) => {
    setBusy(next);
    setError(undefined);
    setDone(undefined);
    try {
      setList(await work());
      setDone(success);
      return true;
    } catch (cause) {
      setError(errorText(cause, fallback));
      return false;
    } finally {
      setBusy(undefined);
      onChanged();
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!shownImage || nameProblem || busy) return;
    const created = shownName;
    const ok = await change(
      { kind: "create" },
      () =>
        mobile.createAvd({ name: created, systemImage: shownImage, ...(shownProfile ? { device: shownProfile } : {}) }),
      `Created ${created}. Boot it from the list.`,
      `${created} could not be created.`,
    );
    if (ok) {
      setName("");
      setNameEdited(false);
    }
  };

  const remove = async (avd: MobileAvdList["avds"][number]) => {
    const ok = await change(
      { kind: "delete", name: avd.name },
      () => mobile.deleteAvd(avd.name),
      `Deleted ${avd.displayName}.`,
      `${avd.displayName} could not be deleted.`,
    );
    if (ok) setConfirming(undefined);
  };

  const closeConfirm = (avdName: string) => {
    setConfirming(undefined);
    requestAnimationFrame(() => deleteRefs.current.get(avdName)?.focus());
  };

  return (
    <section className="mobile-setup-section" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className="mobile-setup-title">
        Virtual devices
      </h3>
      {loadError ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert" size={14} />
          <span className="banner-message">{loadError}</span>
        </div>
      ) : null}
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
        ) : busy?.kind === "create" ? (
          <p className="mobile-setup-hint">Creating {shownName}. This can take a minute.</p>
        ) : null}
      </div>
      {!list && !loadError ? <p className="mobile-setup-hint">Looking for virtual devices</p> : null}
      {list && !list.avdmanager ? (
        <p className="mobile-setup-text">
          Creating and deleting virtual devices needs avdmanager, which comes with the Android command-line tools.
          Install them from Android Studio's SDK Manager, under SDK Tools, then refresh.
        </p>
      ) : null}
      {list && list.avds.length === 0 ? <p className="mobile-setup-text">There are no virtual devices yet.</p> : null}
      {list && list.avds.length > 0 ? (
        <ul className="mobile-avd-list" aria-label="Virtual devices">
          {list.avds.map((avd) => {
            const device = devices.find((candidate) => candidate.deviceId === `${AVD_PREFIX}${avd.name}`);
            const off = !device || device.state === "shutdown";
            const deleting = busy?.kind === "delete" && busy.name === avd.name;
            return (
              <li key={avd.name} className="mobile-avd">
                <span className="mobile-avd-copy">
                  <span className="mobile-avd-name">{avd.displayName}</span>
                  <span className="mobile-avd-detail">
                    {[
                      avd.systemImage ? systemImageLabel(avd.systemImage) : avd.name,
                      device ? stateLabel(device.state) : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </span>
                {confirming === avd.name ? (
                  <fieldset className="mobile-avd-actions" aria-label={`Delete ${avd.displayName}?`}>
                    <span className="mobile-avd-confirm">Delete it and its data?</span>
                    <Button
                      size="xs"
                      variant="danger"
                      loading={deleting}
                      aria-label={`Delete ${avd.displayName} for good`}
                      onClick={() => void remove(avd)}
                    >
                      Delete
                    </Button>
                    <Button
                      ref={cancelRef}
                      size="xs"
                      variant="ghost"
                      disabled={deleting}
                      onClick={() => closeConfirm(avd.name)}
                    >
                      Keep it
                    </Button>
                  </fieldset>
                ) : (
                  <span className="mobile-avd-actions">
                    {device && off ? (
                      <Button
                        size="xs"
                        icon="play"
                        disabled={booting}
                        aria-label={`Boot ${avd.displayName}`}
                        onClick={() => onBoot(device)}
                      >
                        Boot
                      </Button>
                    ) : null}
                    <Button
                      ref={(element) => {
                        if (element) deleteRefs.current.set(avd.name, element);
                        else deleteRefs.current.delete(avd.name);
                      }}
                      size="xs"
                      variant="ghost"
                      icon="trash"
                      disabled={!canChange || !off || busy !== undefined}
                      tooltip={!canChange ? "Needs avdmanager" : !off ? "Shut it down before deleting it" : undefined}
                      aria-label={`Delete ${avd.displayName}`}
                      onClick={() => {
                        setConfirming(avd.name);
                        requestAnimationFrame(() => cancelRef.current?.focus());
                      }}
                    >
                      Delete
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {list?.avdmanager ? (
        list.systemImages.length === 0 ? (
          <p className="mobile-setup-text">
            No system images are installed, so there is nothing to create a device from. Install one with Android
            Studio's SDK Manager or sdkmanager, then refresh.
          </p>
        ) : (
          <form className="mobile-avd-form" aria-labelledby={`${ids}-create`} onSubmit={(event) => void create(event)}>
            <h4 id={`${ids}-create`} className="mobile-avd-form-title">
              Create a virtual device
            </h4>
            <Field label="Name" {...(nameProblem ? { hint: nameProblem, hintTone: "warning" as const } : {})}>
              <input
                ref={nameRef}
                className="input is-mono"
                value={shownName}
                maxLength={60}
                spellCheck={false}
                aria-invalid={nameProblem ? true : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
              />
            </Field>
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
                onChange={setImage}
              />
            </FormSection>
            <FormSection label="Device profile" htmlFor={`${ids}-profile`}>
              <Select<string>
                id={`${ids}-profile`}
                label="Device profile"
                value={shownProfile ?? ""}
                options={list.deviceProfiles.map((entry) => ({ value: entry.id, label: entry.name }))}
                onChange={setProfile}
              />
            </FormSection>
            <div className="mobile-setup-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon="plus"
                loading={busy?.kind === "create"}
                disabled={Boolean(nameProblem) || (busy !== undefined && busy.kind !== "create")}
              >
                Create
              </Button>
            </div>
          </form>
        )
      ) : null}
    </section>
  );
}
