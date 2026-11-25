import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessSample = {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
  /** Resident memory, the closest Windows match to the RSS that ADEMark adds up on macOS. */
  workingSetBytes: number;
  /** Memory only this process holds (committed private bytes). */
  privateBytes: number;
  /** User plus kernel CPU time so far. */
  cpuMs: number;
};

export type TreeSample = {
  at: number;
  processes: ProcessSample[];
  workingSetMb: number;
  privateMb: number;
  /** The same without agent CLIs and what they started: ADEMark's "app" group. */
  appWorkingSetMb: number;
  appPrivateMb: number;
  agentProcesses: number;
  cpuMs: number;
};

/** Every process on the machine, read in one call so the whole tree is from the same moment. */
export async function allProcesses(): Promise<ProcessSample[]> {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; c=$_.CommandLine; ws=$_.WorkingSetSize; pr=$_.PrivatePageCount; t=($_.UserModeTime + $_.KernelModeTime) } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    const rows = JSON.parse(stdout) as Array<{
      p: number;
      pp: number;
      n: string;
      c: string | null;
      ws: number;
      pr: number;
      t: number;
    }>;
    return rows.map((row) => ({
      pid: row.p,
      parentPid: row.pp,
      name: row.n,
      commandLine: row.c ?? "",
      workingSetBytes: Number(row.ws),
      privateBytes: Number(row.pr),
      cpuMs: Number(row.t) / 10_000,
    }));
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, rss, time, ...name] = line.trim().split(/\s+/u);
      return {
        pid: Number(pid),
        parentPid: Number(ppid),
        name: name.join(" "),
        commandLine: name.join(" "),
        workingSetBytes: Number(rss) * 1024,
        privateBytes: Number(rss) * 1024,
        cpuMs: cpuTimeMs(time ?? "0:0"),
      };
    });
}

function cpuTimeMs(value: string): number {
  const parts = value.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds * 1000;
}

/**
 * The app's processes: everything under the roots, plus anything whose command line names the run's own
 * folder. The runtime runs as a detached daemon, so it is not under the Electron process.
 */
export async function sampleTree(roots: number[], marker: string): Promise<TreeSample> {
  const processes = await allProcesses();
  const byParent = new Map<number, ProcessSample[]>();
  for (const entry of processes) {
    const siblings = byParent.get(entry.parentPid) ?? [];
    siblings.push(entry);
    byParent.set(entry.parentPid, siblings);
  }
  const lowerMarker = marker.toLowerCase();
  const seeds = new Set(roots);
  for (const entry of processes) {
    if (entry.commandLine.toLowerCase().includes(lowerMarker)) seeds.add(entry.pid);
  }
  const found = new Map<number, ProcessSample>();
  const queue = processes.filter((entry) => seeds.has(entry.pid));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || found.has(next.pid)) continue;
    found.set(next.pid, next);
    queue.push(...(byParent.get(next.pid) ?? []));
  }
  const tree = [...found.values()];
  const mb = (bytes: number) => bytes / (1024 * 1024);
  // An agent is a CLI ZLI started for a chat; it and everything under it count as the agent, not the app.
  const agentRoots = tree.filter((entry) => kindOf(entry).startsWith("agent"));
  const inAgent = new Set<number>();
  const agentQueue = [...agentRoots];
  while (agentQueue.length > 0) {
    const next = agentQueue.shift();
    if (!next || inAgent.has(next.pid)) continue;
    inAgent.add(next.pid);
    agentQueue.push(...(byParent.get(next.pid) ?? []));
  }
  const app = tree.filter((entry) => !inAgent.has(entry.pid));
  return {
    at: Date.now(),
    processes: tree,
    workingSetMb: mb(tree.reduce((sum, entry) => sum + entry.workingSetBytes, 0)),
    privateMb: mb(tree.reduce((sum, entry) => sum + entry.privateBytes, 0)),
    appWorkingSetMb: mb(app.reduce((sum, entry) => sum + entry.workingSetBytes, 0)),
    appPrivateMb: mb(app.reduce((sum, entry) => sum + entry.privateBytes, 0)),
    agentProcesses: agentRoots.length,
    cpuMs: tree.reduce((sum, entry) => sum + entry.cpuMs, 0),
  };
}

/** Groups a sample by what each process is, so a report can say where the memory went. */
export function breakdown(sample: TreeSample): Record<string, { count: number; workingSetMb: number }> {
  const groups: Record<string, { count: number; workingSetMb: number }> = {};
  for (const entry of sample.processes) {
    const key = kindOf(entry);
    const group = groups[key] ?? { count: 0, workingSetMb: 0 };
    group.count += 1;
    group.workingSetMb += entry.workingSetBytes / (1024 * 1024);
    groups[key] = group;
  }
  return groups;
}

function kindOf(entry: ProcessSample): string {
  const line = entry.commandLine.toLowerCase();
  const name = entry.name.toLowerCase();
  if (line.includes("zli-tool-host.js")) return "tool host (shared)";
  if (line.includes("zli-browser.js")) return "tool server (zli-browser)";
  if (line.includes("zli-mobile.js")) return "tool server (zli-mobile)";
  if (/zli\.js"? +mcp/u.test(line)) return "tool server (zli)";
  if (line.includes("connect-entry") || line.includes("zli-connect")) return "tool server (sign-in bridge)";
  if (line.includes("claude") && !line.includes("electron")) return "agent (claude)";
  if (line.includes("daemon-entry") || line.includes("server-entry")) return "runtime";
  if (line.includes("--type=renderer")) return "electron renderer";
  if (line.includes("--type=gpu-process")) return "electron gpu";
  if (line.includes("--type=utility")) return "electron utility";
  if (line.includes("--type=crashpad")) return "electron crashpad";
  if (name.startsWith("electron") || name.startsWith("zli")) return "electron main";
  if (name.includes("conhost")) return "console host";
  return name;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}
