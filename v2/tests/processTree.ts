export function getProcessTreeTerminationOrder(rootPid: number, processTable: string): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const line of processTable.split(/\r?\n/u)) {
    const [pidText, parentText] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
    const siblings = childrenByParent.get(parentPid) ?? [];
    siblings.push(pid);
    childrenByParent.set(parentPid, siblings);
  }

  const visited = new Set<number>();
  const order: number[] = [];
  const visit = (pid: number): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    order.push(pid);
  };
  visit(rootPid);
  return order;
}
