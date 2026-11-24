type LocalFont = { family: string };
type QueryLocalFonts = () => Promise<readonly LocalFont[]>;

let families: Promise<readonly string[]> | undefined;

/**
 * The font families installed on this computer, sorted by name, or none where the browser cannot list them.
 * Chromium only lists them after a click or key press, so call this from one.
 */
export function loadLocalFonts(): Promise<readonly string[]> {
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof query !== "function") return Promise.resolve([]);
  families ??= query()
    .then((fonts) => [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)))
    .catch(() => {
      families = undefined;
      return [];
    });
  return families;
}
