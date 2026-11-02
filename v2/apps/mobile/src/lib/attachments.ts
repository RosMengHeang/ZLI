import type { ThreadAttachmentUpload } from "@zli-v2/contracts";

/** The desktop takes up to eight attachments with each message. */
export const MAX_ATTACHMENTS = 8;

/** Phone photos are far larger than an agent needs, and each message travels in one frame. */
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.7;

export type PhotoDraft = {
  id: string;
  /** A local file for the preview. */
  uri: string;
  name: string;
  dataBase64: string;
};

/** The resize that brings the longer side down to `max`, or nothing when the photo already fits. */
export function fitWithin(
  width: number,
  height: number,
  max: number = PHOTO_MAX_SIDE,
): { width: number } | { height: number } | undefined {
  if (width <= max && height <= max) return undefined;
  return width >= height ? { width: max } : { height: max };
}

/** A file name that says it is a JPEG, since every photo is saved as one before it is sent. */
export function photoName(fileName: string | null | undefined, index: number): string {
  const base = (fileName ?? "")
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.[^.]+$/u, "")
    .replace(/[^\w .-]+/gu, "-")
    .trim()
    .slice(0, 120);
  return `${base || `photo-${index + 1}`}.jpg`;
}

export function attachmentUploads(photos: readonly PhotoDraft[]): ThreadAttachmentUpload[] {
  return photos.map((photo) => ({ name: photo.name, mimeType: "image/jpeg", dataBase64: photo.dataBase64 }));
}
