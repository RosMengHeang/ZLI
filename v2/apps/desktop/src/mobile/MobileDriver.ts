import type { MobileButton, MobileDevice, MobilePlatform } from "@zli-v2/contracts";

import type { UiTree } from "./uiTree.js";

/** A device as a driver sees it; leases are added by the DeviceManager. */
export type DriverDevice = Omit<MobileDevice, "lease">;

export type Orientation = "portrait" | "landscape" | "portrait-reverse" | "landscape-reverse";

export type Screenshot = { readonly data: Buffer; readonly width: number; readonly height: number };

export type LogQuery = { readonly appId?: string; readonly lines: number; readonly filter?: string };

export type BootOptions = {
  readonly window?: boolean;
  readonly wipeData?: boolean;
  /** The Android emulator console port to use when it is free, so each worktree's emulator keeps its serial. */
  readonly preferredPort?: number;
};

/** What one platform can do with its devices. Coordinates are in the unit the platform's tree reports. */
export type MobileDriver = {
  readonly platform: MobilePlatform;
  list(): Promise<DriverDevice[]>;
  boot(device: DriverDevice, options: BootOptions): Promise<DriverDevice>;
  shutdown(device: DriverDevice): Promise<void>;
  install(device: DriverDevice, path: string): Promise<string>;
  launch(device: DriverDevice, appId: string, options: { stop?: boolean }): Promise<void>;
  openUrl(device: DriverDevice, url: string): Promise<{ reversedPort?: number }>;
  snapshot(device: DriverDevice): Promise<UiTree>;
  tap(device: DriverDevice, x: number, y: number, longPress: boolean): Promise<void>;
  swipe(
    device: DriverDevice,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void>;
  type(device: DriverDevice, text: string): Promise<void>;
  press(device: DriverDevice, button: MobileButton): Promise<void>;
  rotate(device: DriverDevice, orientation: Orientation | undefined): Promise<Orientation>;
  screenshot(device: DriverDevice): Promise<Screenshot>;
  logs(device: DriverDevice, query: LogQuery): Promise<string[]>;
  /** The size tap and swipe coordinates are measured in. */
  screenSize(device: DriverDevice): Promise<{ width: number; height: number }>;
  /** Stops processes this driver started, such as emulators, when ZLI quits. */
  dispose(): Promise<void>;
  /** Follows the device's log from now on. Rejects when the log tool is missing. */
  streamLogs(device: DriverDevice): Promise<LogStream>;
};

export class MobileDriverError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MobileDriverError";
  }
}

/** A device log that keeps coming, line by line, until stop() or the log process ends. */
export type LogStream = {
  onLine(listener: (line: string) => void): void;
  stop(): void;
  readonly exited: Promise<void>;
};

/** Splits output chunks into lines, keeping a partial line until the rest of it arrives. */
export function lineSplitter(emit: (line: string) => void): { push(chunk: Buffer | string): void; end(): void } {
  let partial = "";
  return {
    push(chunk) {
      const lines = `${partial}${chunk.toString()}`.split("\n");
      partial = lines.pop() ?? "";
      // A runaway line without a newline must not grow forever.
      if (partial.length > 64 * 1024) partial = partial.slice(-64 * 1024);
      for (const line of lines) emit(line.endsWith("\r") ? line.slice(0, -1) : line);
    },
    end() {
      if (partial) emit(partial);
      partial = "";
    },
  };
}

/** A LogStream over a process that prints log lines to stdout. */
export function processLogStream(process: {
  onStdout(listener: (chunk: Buffer) => void): void;
  kill(): void;
  readonly exited: Promise<unknown>;
}): LogStream {
  const listeners: ((line: string) => void)[] = [];
  const splitter = lineSplitter((line) => {
    for (const listener of listeners) listener(line);
  });
  process.onStdout((chunk) => splitter.push(chunk));
  const exited = process.exited.then(() => splitter.end());
  return {
    onLine: (listener) => {
      listeners.push(listener);
    },
    stop: () => process.kill(),
    exited,
  };
}
