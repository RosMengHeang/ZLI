export function canDismissDialog({ dismissible, busy }: { dismissible: boolean; busy: boolean }): boolean {
  return dismissible && !busy;
}
