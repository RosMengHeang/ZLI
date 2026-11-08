import { createHash } from "node:crypto";

/** sha256 of the sorted versions, as 12 hex characters. The same versions always give the same fingerprint. */
export function fingerprintOf(versions: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(versions)
    .sort()
    .map((key) => `${key}=${versions[key]}`)
    .join("\n");
  return createHash("sha256").update(sorted, "utf8").digest("hex").slice(0, 12);
}
