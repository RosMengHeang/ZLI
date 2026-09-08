export function normalizeBrowserInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^https?:/i.test(input) && !/^localhost:\d+/i.test(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `${/^localhost(?::|\/|$)/i.test(input) ? "http" : "https"}://${input}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

export function pushBrowserHistory(history: string[], index: number, url: string) {
  const next = [...history.slice(0, index + 1), url];
  return { history: next, index: next.length - 1 };
}
