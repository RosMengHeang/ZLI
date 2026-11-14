import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AgentSettings } from "@zli-v2/contracts";

/**
 * Settings the runtime applies when it starts a chat agent, saved as JSON next to the database.
 * A missing or unreadable file means every setting is at its default.
 */
export class AgentSettingsStore {
  private settings: AgentSettings = {};
  /** Saves run one after another, so the file and the cached settings always match the last save answered. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = AgentSettings.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      this.settings = parsed.success ? parsed.data : {};
    } catch {
      this.settings = {};
    }
  }

  read(): AgentSettings {
    return { ...this.settings };
  }

  async save(next: AgentSettings): Promise<AgentSettings> {
    const settings = AgentSettings.parse(next);
    const run = this.saving.then(() => this.write(settings));
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async write(settings: AgentSettings): Promise<AgentSettings> {
    await mkdir(dirname(this.path), { recursive: true });
    // Each save writes its own temporary file, so no rename can take another save's contents.
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
    this.settings = settings;
    return this.read();
  }
}
