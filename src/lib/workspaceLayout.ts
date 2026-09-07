export function gridColumnsFor(terminalCount: number): 1 | 2 {
  return terminalCount > 1 ? 2 : 1;
}
