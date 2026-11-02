/**
 * Byte helpers that behave the same in Node and in React Native, where Buffer does not exist and
 * TextDecoder is not guaranteed.
 */

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map([...BASE64URL].map((character, index) => [character, index]));

export function toBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += BASE64URL[(triple >> 18) & 63];
    output += BASE64URL[(triple >> 12) & 63];
    if (index + 1 < bytes.length) output += BASE64URL[(triple >> 6) & 63];
    if (index + 2 < bytes.length) output += BASE64URL[triple & 63];
  }
  return output;
}

export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("Invalid base64url text.");
  const output = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const character of text) {
    const digit = BASE64URL_VALUES.get(character);
    if (digit === undefined) throw new Error("Invalid base64url text.");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset] = (value >> bits) & 0xff;
      offset += 1;
    }
  }
  // Leftover bits must be zero, so every byte string has exactly one encoding.
  if ((value & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base64url text.");
  return output;
}

export function utf8Encode(text: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) output.push(code);
    else if (code < 0x800) output.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else output.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(output);
}

/** Follows the WHATWG decoder, so malformed input becomes U+FFFD exactly as TextDecoder replaces it. */
export function utf8Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  const emit = (code: number) => {
    if (code >= 0x10000) {
      const offset = code - 0x10000;
      chunk.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      chunk.push(code);
    }
    if (chunk.length >= 8_192) {
      parts.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  };
  let code = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (needed === 0) {
      index += 1;
      if (byte < 0x80) emit(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        code = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        code = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        code = byte & 0x07;
      } else emit(0xfffd);
      continue;
    }
    if (byte < lower || byte > upper) {
      // The byte is not consumed: it may start the next sequence.
      code = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      emit(0xfffd);
      continue;
    }
    index += 1;
    lower = 0x80;
    upper = 0xbf;
    code = (code << 6) | (byte & 0x3f);
    seen += 1;
    if (seen === needed) {
      emit(code);
      code = 0;
      needed = 0;
      seen = 0;
    }
  }
  if (needed !== 0) emit(0xfffd);
  parts.push(String.fromCharCode(...chunk));
  return parts.join("");
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Compares in time that depends only on the lengths, so a mismatch does not reveal where it is. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/** An 8-byte big-endian counter. Counters stay below 2^53, the largest exact integer. */
export function counterBytes(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Counter is out of range.");
  const output = new Uint8Array(8);
  const high = Math.floor(counter / 2 ** 32);
  const low = counter >>> 0;
  output[0] = high >>> 24;
  output[1] = (high >>> 16) & 0xff;
  output[2] = (high >>> 8) & 0xff;
  output[3] = high & 0xff;
  output[4] = low >>> 24;
  output[5] = (low >>> 16) & 0xff;
  output[6] = (low >>> 8) & 0xff;
  output[7] = low & 0xff;
  return output;
}

export function readCounter(bytes: Uint8Array): number {
  if (bytes.length !== 8) throw new Error("Counter must be 8 bytes.");
  const high = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
  const low = (((bytes[4] ?? 0) << 24) | ((bytes[5] ?? 0) << 16) | ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) >>> 0;
  return high * 2 ** 32 + low;
}

export type RandomBytes = (length: number) => Uint8Array;

/** Web Crypto's generator, which Node and browsers provide. React Native passes its own. */
export const webCryptoRandomBytes: RandomBytes = (length) => {
  const source = (globalThis as { crypto?: { getRandomValues?<T extends Uint8Array>(array: T): T } }).crypto;
  if (!source?.getRandomValues) throw new Error("No secure random source is available.");
  return source.getRandomValues(new Uint8Array(length));
};
