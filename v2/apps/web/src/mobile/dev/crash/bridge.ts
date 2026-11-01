import type { MobileCrashEvent, MobileCrashReport } from "@zli-v2/contracts";

/** window.zli.mobile.dev.crash: the crashes crash watch caught on each device. */
export type CrashBridge = {
  crash: {
    /** Newest first, dismissed ones included. */
    list(deviceId: string): Promise<MobileCrashReport[]>;
    dismiss(deviceId: string, crashId: string): Promise<MobileCrashReport[]>;
    /** Fires with a device's reports whenever one is caught, repeats, or is dismissed. */
    onChange(listener: (event: MobileCrashEvent) => void): () => void;
  };
};
