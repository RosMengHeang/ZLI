// Metro replaces this with the value at build time. The app has no Node types.
declare const process: { env: { EXPO_PUBLIC_ZLI_DEMO?: string } };

/**
 * Runs the app against the demo desktop in `lib/demoDesktop.ts` instead of a paired one. CI sets it to
 * build the screenshot preview; a build for people must never set it.
 */
export const demoMode = process.env.EXPO_PUBLIC_ZLI_DEMO === "1";
