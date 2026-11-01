import type { FetchLike } from "../../download.js";
import { DIRECTORY_BASE } from "./directory.js";

export type DirectoryAnswer = { status?: number; body: unknown } | "hang";

export const checkUrl = (...names: string[]) =>
  `${DIRECTORY_BASE}/libraries/check?packages=${names.map(encodeURIComponent).join(",")}`;
export const libraryUrl = (name: string) => `${DIRECTORY_BASE}/library?name=${encodeURIComponent(name)}`;

/** A fetch that answers React Native Directory URLs from a table and records every URL asked for. */
export function directoryFetch(answers: Record<string, DirectoryAnswer>) {
  const urls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    const answer = answers[url];
    if (answer === "hang")
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const status = answer?.status ?? (answer ? 200 : 404);
    const text =
      answer === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body: null,
      headers: { get: () => null },
      text: async () => text,
    });
  };
  return { fetch, urls };
}
