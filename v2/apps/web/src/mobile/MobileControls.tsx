import type { MobileButton, MobileDevice } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { MenuButton, type MenuEntry } from "../ui/Menu.js";
import { errorText, openedNotice, sendTextInput, urlToOpen } from "./mobile.js";

type Row = "type" | "url";

/**
 * The bar under a running device: its system buttons, Type text, Open URL, Rotate, the screenshot, and a menu
 * with Power, Volume, and Copy screenshot. Every control that sends input checks inputBlocked first, so an agent's lease sends the
 * person to Take over instead.
 */
export function MobileControls({
  mobile,
  device,
  inputBlocked,
  onBlockedInput,
  onError,
  onNotice,
  screenshotBusy,
  onScreenshot,
  onCopyScreenshot,
}: {
  mobile: Pick<MobileBridge, "input" | "openUrl">;
  device: MobileDevice;
  inputBlocked: boolean;
  onBlockedInput(): void;
  /** Shows an error in the pane's banner, or clears it with undefined. */
  onError(message: string | undefined): void;
  /** Shows a short confirmation that clears itself. */
  onNotice(message: string): void;
  screenshotBusy: boolean;
  onScreenshot(): void;
  onCopyScreenshot(): void;
}) {
  const android = device.platform === "android";
  const [row, setRow] = useState<Row>();
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState("");
  const [sending, setSending] = useState(false);
  const typeToggleRef = useRef<HTMLButtonElement>(null);
  const urlToggleRef = useRef<HTMLButtonElement>(null);

  const press = (button: MobileButton) => {
    if (inputBlocked) return onBlockedInput();
    onError(undefined);
    mobile
      .input({ deviceId: device.deviceId, type: "button", button })
      .catch((cause: unknown) => onError(errorText(cause, "The device did not accept that button.")));
  };
  const rotate = () => {
    if (inputBlocked) return onBlockedInput();
    onError(undefined);
    mobile
      .input({ deviceId: device.deviceId, type: "rotate" })
      .catch((cause: unknown) => onError(errorText(cause, "The device did not rotate.")));
  };
  const closeRow = () => {
    const toggle = row === "url" ? urlToggleRef : typeToggleRef;
    setRow(undefined);
    toggle.current?.focus();
  };
  const toggleRow = (next: Row) => (row === next ? closeRow() : setRow(next));
  const sendDraft = async () => {
    if (!draft || sending) return;
    if (inputBlocked) return onBlockedInput();
    setSending(true);
    onError(undefined);
    try {
      await sendTextInput(mobile, device.deviceId, draft);
      setDraft("");
    } catch (cause) {
      onError(errorText(cause, "The device did not accept that text."));
    } finally {
      setSending(false);
    }
  };
  const openTypedUrl = async () => {
    const target = urlToOpen(url);
    if (!target || sending) return;
    if (inputBlocked) return onBlockedInput();
    setSending(true);
    onError(undefined);
    try {
      onNotice(openedNotice(target, await mobile.openUrl(device.deviceId, target)));
      closeRow();
    } catch (cause) {
      onError(errorText(cause, "The device could not open that URL."));
    } finally {
      setSending(false);
    }
  };
  // idb can press the iOS lock button but has no volume buttons.
  const menuItems: MenuEntry[] = [
    { id: "power", label: "Power", icon: "power", run: () => press("power") },
    ...(android
      ? [
          { id: "volume_up", label: "Volume up", icon: "volumeUp", run: () => press("volume_up") } as const,
          { id: "volume_down", label: "Volume down", icon: "volumeDown", run: () => press("volume_down") } as const,
        ]
      : []),
    "separator",
    { id: "copy-screenshot", label: "Copy screenshot", icon: "copy", disabled: screenshotBusy, run: onCopyScreenshot },
  ];

  return (
    <>
      {row === "type" ? (
        <InputRow
          label={`Text to type on ${device.name}`}
          placeholder="Type text, then press Enter"
          value={draft}
          submitLabel="Send"
          sending={sending}
          onChange={setDraft}
          onSubmit={() => void sendDraft()}
          onClose={closeRow}
        />
      ) : null}
      {row === "url" ? (
        <InputRow
          label={`URL to open on ${device.name}`}
          placeholder="localhost:3000 or https://example.com"
          value={url}
          submitLabel="Open"
          sending={sending}
          url
          onChange={setUrl}
          onSubmit={() => void openTypedUrl()}
          onClose={closeRow}
        />
      ) : null}
      <nav className="mobile-controls" aria-label="Device buttons">
        {android ? (
          <Button size="sm" variant="ghost" icon="arrowLeft" onClick={() => press("back")}>
            Back
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="circle" onClick={() => press("home")}>
          Home
        </Button>
        {android ? (
          <Button size="sm" variant="ghost" icon="square" onClick={() => press("recents")}>
            Recents
          </Button>
        ) : null}
        <span className="mobile-toolbar-spacer" />
        <IconButton
          ref={typeToggleRef}
          icon="keyboard"
          size="sm"
          iconSize={14}
          label="Type text"
          tooltip={row === "type" ? "Close Type text" : "Type text on the device"}
          pressed={row === "type"}
          onClick={() => toggleRow("type")}
        />
        <IconButton
          ref={urlToggleRef}
          icon="globe"
          size="sm"
          iconSize={14}
          label="Open URL"
          tooltip={row === "url" ? "Close Open URL" : "Open a URL on the device"}
          pressed={row === "url"}
          onClick={() => toggleRow("url")}
        />
        {android ? <IconButton icon="rotate" size="sm" iconSize={14} label="Rotate" onClick={rotate} /> : null}
        <IconButton
          icon="download"
          size="sm"
          iconSize={14}
          label="Save a screenshot"
          disabled={screenshotBusy}
          onClick={onScreenshot}
        />
        <MenuButton label="More device buttons" icon="more" items={menuItems} />
      </nav>
    </>
  );
}

/** A one-line field above the controls. Enter submits and Escape closes it. */
function InputRow({
  label,
  placeholder,
  value,
  submitLabel,
  sending,
  url = false,
  onChange,
  onSubmit,
  onClose,
}: {
  label: string;
  placeholder: string;
  value: string;
  submitLabel: string;
  sending: boolean;
  url?: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}) {
  return (
    <form
      className="mobile-type-row"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        className="input input-sm"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        readOnly={sending}
        // type="url" would refuse localhost:3000, which has no scheme, so only the keyboard hint says URL.
        {...(url ? { inputMode: "url" as const, spellCheck: false, autoCapitalize: "off" } : {})}
        // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked for it.
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      />
      <Button type="submit" size="sm" loading={sending} disabled={!value}>
        {submitLabel}
      </Button>
    </form>
  );
}
