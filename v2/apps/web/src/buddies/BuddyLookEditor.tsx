import { type BuddyLook, type BuddyProjection, MAX_BUDDY_IMAGE } from "@zli-v2/contracts";
import { useEffect, useRef, useState } from "react";

import { type AvatarMood, BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BUDDY_COLOR_NAMES, buddyHex, buddyName } from "../teammates/buddies.js";
import { BODIES, BUDDY_LOOKS, defaultLook, lookOf } from "../teammates/pixelBuddies.js";
import { Icon } from "../ui/Icon.js";
import type { Run } from "./useRun.js";

type Tab = "body" | "upload";

/** The picture's side in pixels: enough for the largest face, small enough to keep in the buddy's record. */
const IMAGE_SIDE = 128;

/** Reads a picture file and squares it to a small image, cropped from the middle. */
async function squareImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = IMAGE_SIDE;
    canvas.height = IMAGE_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This picture could not be read.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      IMAGE_SIDE,
      IMAGE_SIDE,
    );
    for (const [type, quality] of [
      ["image/webp", 0.86],
      ["image/jpeg", 0.82],
      ["image/jpeg", 0.6],
    ] as const) {
      const data = canvas.toDataURL(type, quality);
      if (data.startsWith(`data:${type}`) && data.length <= MAX_BUDDY_IMAGE) return data;
    }
    throw new Error("This picture is too detailed to keep. Try a simpler one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The buddy's face in its details, with a pencil on hover. A click opens a small editor: its body and color, or a
 * picture of the person's own, and Reset to go back to its default body with no picture.
 */
export function BuddyLookEditor({ buddy, mood, run }: { buddy: BuddyProjection; mood: AvatarMood; run: Run }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(buddy.image ? "upload" : "body");
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const look = lookOf(buddy);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const update = (changes: Record<string, unknown>) => run({ type: "buddy.update", buddyId: buddy.buddyId, changes });
  // Picking a body shows it, so a picture in its place goes.
  const pickLook = (next: BuddyLook) => void update(buddy.image ? { look: next, image: "" } : { look: next });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setNote(undefined);
    setBusy(true);
    try {
      await update({ image: await squareImage(file) });
    } catch (error) {
      setNote(error instanceof Error ? error.message : "This picture could not be used.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="buddy-look" ref={box}>
      <button
        type="button"
        className="buddy-look-face"
        aria-label={`Change how ${buddy.name} looks`}
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <BuddyAvatar buddy={buddy.color} look={look} image={buddy.image} size={72} mood={mood} name={buddy.name} />
        <span className="buddy-look-pencil" aria-hidden="true">
          <Icon name="pencil" size={16} />
        </span>
      </button>
      {open ? (
        <div className="buddy-look-panel" role="dialog" aria-label={`How ${buddy.name} looks`}>
          <div className="buddy-look-tabs">
            {(["body", "upload"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                className="buddy-look-tab"
                aria-pressed={tab === entry}
                onClick={() => setTab(entry)}
              >
                {entry === "body" ? "Body" : "Upload"}
              </button>
            ))}
            <span className="buddy-look-spacer" />
            <button
              type="button"
              className="buddy-look-tab"
              onClick={() => void update({ look: defaultLook(buddy.buddyId), image: "" })}
            >
              Reset
            </button>
          </div>
          {tab === "body" ? (
            <>
              <div className="buddy-look-bodies">
                {BUDDY_LOOKS.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className="buddy-look-body"
                    aria-label={BODIES[entry].label}
                    aria-pressed={!buddy.image && look === entry}
                    data-tooltip={BODIES[entry].label}
                    onClick={() => pickLook(entry)}
                  >
                    <BuddyAvatar buddy={buddy.color} look={entry} size={40} />
                  </button>
                ))}
              </div>
              <div className="buddy-look-colors">
                {BUDDY_COLOR_NAMES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="buddy-look-color"
                    aria-label={buddyName(color)}
                    aria-pressed={buddy.color === color}
                    style={{ background: buddyHex(color) }}
                    onClick={() => void update({ color })}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="buddy-look-upload">
              {buddy.image ? <img src={buddy.image} alt="" className="buddy-look-preview" /> : null}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => picker.current?.click()}
              >
                <Icon name="upload" size={13} />
                {buddy.image ? "Choose another picture" : "Choose a picture"}
              </button>
              {buddy.image ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void update({ image: "" })}>
                  Use its body again
                </button>
              ) : null}
              <p className="buddy-look-hint">
                {note ?? "Square pictures look best. It is cropped to a square and kept small."}
              </p>
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  void upload(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
