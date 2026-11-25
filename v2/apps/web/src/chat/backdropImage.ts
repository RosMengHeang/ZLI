import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The picture the person chose for the chat background. It lives in its own storage key, apart from the
 * settings, because it is much larger than they are. It is shrunk before it is saved, so it fits.
 */
const STORAGE_KEY = "zli.chatBackdropImage.v1";
/** The longest side a saved picture keeps. Larger than any chat panel, small enough to store. */
export const MAX_IMAGE_SIDE = 2048;
/** Pictures larger than this are refused before they are read. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

let cache: string | null | undefined;
const listeners = new Set<() => void>();

export function readBackdropImage(): string | null {
  if (cache !== undefined) return cache;
  try {
    cache = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    cache = null;
  }
  return cache;
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useBackdropImageUrl(): string | null {
  return useSyncExternalStore(subscribe, readBackdropImage, () => null);
}

/** Saves the picture, or throws when the window cannot store it. */
export function saveBackdropImage(dataUrl: string) {
  window.localStorage.setItem(STORAGE_KEY, dataUrl);
  cache = dataUrl;
  notify();
}

export function clearBackdropImage() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more to do: the picture is already unreachable once the cache is cleared.
  }
  cache = null;
  notify();
}

/** The side lengths a picture keeps once its longest side is at most `max`. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Reads a picture file, shrinks it to fit, and returns it as a JPEG data URL ready to save. */
export async function prepareBackdropImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not a picture.");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("That picture is larger than 25 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const size = fitWithin(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This window cannot read pictures.");
    ctx.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That picture could not be opened."));
    image.src = src;
  });
}

/** The saved picture as a loaded image element, or undefined while it loads or when there is none. */
export function useBackdropImage(): HTMLImageElement | undefined {
  const url = useBackdropImageUrl();
  const [image, setImage] = useState<HTMLImageElement>();
  useEffect(() => {
    if (!url) {
      setImage(undefined);
      return;
    }
    let live = true;
    loadImage(url)
      .then((loaded) => {
        if (live) setImage(loaded);
      })
      .catch(() => {
        if (live) setImage(undefined);
      });
    return () => {
      live = false;
    };
  }, [url]);
  return image;
}
