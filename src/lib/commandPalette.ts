export interface CommandPaletteItem {
  id: string;
  label: string;
  keywords?: readonly string[];
}

export function filterCommandItems<T extends CommandPaletteItem>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    [item.label, ...(item.keywords ?? [])].some((value) => value.toLocaleLowerCase().includes(needle)),
  );
}
