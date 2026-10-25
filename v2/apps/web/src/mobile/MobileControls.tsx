import type { MobileButton, MobileDevice } from "@zli-v2/contracts";
import { useRef, useState } from "react";

import type { MobileBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { errorText, sendTextInput } from "./mobile.js";

/**
 * The bar under a running device: its system buttons, Type text, Rotate, and the screenshot. Every control
 * that sends input checks inputBlocked first, so an agent's lease sends the person to Take over instead.
 */
export function MobileControls({
  mobile,
  device,
  inputBlocked,
  onBlockedInput,
  onError,
  screenshotBusy,
  onScreenshot,
}: {
  mobile: MobileBridge;
  device: MobileDevice;
  inputBlocked: boolean;
  onBlockedInput(): void;
  /** Shows an error in the pane's banner, or clears it with undefined. */
  onError(message: string | undefined): void;
  screenshotBusy: boolean;
  onScreenshot(): void;
}) {
  const android = device.platform === "android";
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const typeToggleRef = useRef<HTMLButtonElement>(null);

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
  const closeTyping = () => {
    setTyping(false);
    typeToggleRef.current?.focus();
  };

  return (
    <>
      {typing ? (
        <form
          className="mobile-type-row"
          onSubmit={(event) => {
            event.preventDefault();
            void sendDraft();
          }}
        >
          <input
            className="input input-sm"
            aria-label={`Text to type on ${device.name}`}
            placeholder="Type text, then press Enter"
            value={draft}
            readOnly={sending}
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to type.
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              closeTyping();
            }}
          />
          <Button type="submit" size="sm" loading={sending} disabled={!draft}>
            Send
          </Button>
        </form>
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
          tooltip={typing ? "Close Type text" : "Type text on the device"}
          pressed={typing}
          onClick={() => (typing ? closeTyping() : setTyping(true))}
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
      </nav>
    </>
  );
}
