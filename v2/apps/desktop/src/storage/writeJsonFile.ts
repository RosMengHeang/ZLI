import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Writes JSON through a temporary file, so a crash mid-write never leaves half a settings file. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(temporary, path);
}

/** Antivirus and the search indexer briefly lock new files on Windows, which makes rename fail. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * (attempt + 1)));
    }
  }
}
