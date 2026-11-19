import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The environment variable the desktop app hands its sealing key over in. Read once, then removed. */
export const SECRETS_KEY_ENV = "ZLI_SECRETS_KEY";
const PREFIX = "sealed:v1:";

/**
 * Seals secrets ZLI keeps on disk (the Composio key): AES-256-GCM with a key the
 * desktop app keeps in the OS keychain (Electron safeStorage) and hands to this process at start. The files then hold
 * only ciphertext, so an agent that reads them, or a copied backup, learns nothing. The key lives only in this
 * process's memory: it is taken out of the environment before any agent starts, so no agent inherits it.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** The box for the key the desktop app passed, or undefined (tests, or no OS keychain): files then stay as before. */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): SecretBox | undefined {
    const value = env[SECRETS_KEY_ENV];
    delete env[SECRETS_KEY_ENV];
    if (!value) return undefined;
    const key = Buffer.from(value, "base64");
    return key.length === 32 ? new SecretBox(key) : undefined;
  }

  static withKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error("A secret box key is 32 bytes.");
    return new SecretBox(Buffer.from(key));
  }

  static isSealed(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  seal(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
  }

  /** The text, or undefined when it was sealed with another key or changed since. */
  open(sealed: string): string | undefined {
    if (!SecretBox.isSealed(sealed)) return undefined;
    try {
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}
