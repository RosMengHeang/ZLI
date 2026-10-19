let fallbackSequence = 0;

export function makeCommandId(): string {
  const cryptoApi = globalThis.crypto;
  const randomUUID = cryptoApi?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(cryptoApi);

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 10; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let sequence = ++fallbackSequence;
  for (let index = bytes.length - 1; index >= 10; index -= 1) {
    bytes[index] = sequence & 0xff;
    sequence = Math.floor(sequence / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
