import type { MobileDevToolModule } from "./types.js";

/** Placeholder for F4, crash detection. Stream S3 owns this file and replaces it with the mobile_crashes tool (action mobilecrashes). */
export const crashTools: MobileDevToolModule = { tools: [], format: undefined, instructions: "" };
