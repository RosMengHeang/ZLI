import type { MobileAvdList, MobileDevice } from "@zli-v2/contracts";
import { useEffect, useId, useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { errorText, stateLabel, systemImageLabel } from "./mobile.js";
import { NewDeviceDialog } from "./NewDeviceDialog.js";

const AVD_PREFIX = "android-avd:";

type Busy = { kind: "delete"; name: string };

/**
 * The Android virtual devices on this computer, with Boot and Delete for each, and New device to create one
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
  /** Open New device when the section opens, as when the person picked New virtual device. */
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
  const [creating, setCreating] = useState(false);
  const askedRef = useRef(false);
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

  const canChange = Boolean(list?.avdmanager);
  const canCreate = canChange && (list?.systemImages.length ?? 0) > 0;

  useEffect(() => {
    if (!focusCreate) askedRef.current = false;
    else if (canCreate && !askedRef.current) {
      askedRef.current = true;
      setCreating(true);
    }
  }, [focusCreate, canCreate]);

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
          <div className="mobile-setup-actions">
            <Button size="sm" icon="plus" disabled={busy !== undefined} onClick={() => setCreating(true)}>
              New device…
            </Button>
          </div>
        )
      ) : null}
      {creating ? (
        <NewDeviceDialog
          mobile={mobile}
          platforms={["android"]}
          devices={devices}
          onCreated={(created) => {
            setCreating(false);
            if (created.platform === "android") setList(created.avds);
            setError(undefined);
            setDone(`Created ${created.name}. Boot it from the list.`);
            onChanged();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </section>
  );
}
