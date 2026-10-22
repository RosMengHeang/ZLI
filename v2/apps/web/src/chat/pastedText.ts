/** Pastes this long become an attachment, so the message the person types stays readable. */
export const LONG_PASTE_LINES = 40;
export const LONG_PASTE_CHARS = 4_000;
export const MAX_TEXT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n").length;
}

export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_CHARS || lineCount(text) >= LONG_PASTE_LINES;
}

/** UTF-8 bytes as base64, in chunks so a large paste does not overflow the argument list. */
export function textBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The stand-in sent when the person attaches something without typing a message. */
export function attachmentOnlyMessage(images: number, texts: number): string {
  if (images > 0 && texts > 0) return "See the attached files.";
  if (texts > 0) return texts === 1 ? "See the attached text." : "See the attached texts.";
  return "See the attached images.";
}
