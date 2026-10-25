import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_MOBILE_SETTINGS, MobileSettings } from "@zli-v2/contracts";

/** The person's mobile settings. Only the main process writes the file, so the cached copy stays current. */
export class MobileSettingsStore {
  readonly #path: string;
  #cache: MobileSettings | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async get(): Promise<MobileSettings> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = MobileSettings.safeParse(JSON.parse(await readFile(this.#path, "utf8")));
      this.#cache = parsed.success ? parsed.data : { ...DEFAULT_MOBILE_SETTINGS };
    } catch {
      this.#cache = { ...DEFAULT_MOBILE_SETTINGS };
    }
    return this.#cache;
  }

  async set(patch: Partial<MobileSettings>): Promise<MobileSettings> {
    const next = MobileSettings.parse({ ...(await this.get()), ...patch });
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.#path);
    this.#cache = next;
    return next;
  }
}
