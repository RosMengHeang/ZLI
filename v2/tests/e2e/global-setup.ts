import { createRequire } from "node:module";

import { prepareTestApp } from "./packagedApp.js";

/**
 * Loading the electron package downloads and unpacks its binary when node_modules/electron/dist is missing
 * or holds another version. Playwright loads it in every worker, so two workers starting at once unpack
 * into the same folder and one fails with "failed to create directory ...\electron\dist\locales". Loading
 * it here first, before any worker starts, leaves the binary in place for all of them.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.ZLI_ELECTRON_EXECUTABLE) return;
  // The packaged app refuses --inspect, which Playwright needs, so the tests run a copy that takes it.
  if (process.env.ZLI_E2E_PACKAGED === "1") {
    await prepareTestApp();
    return;
  }
  createRequire(import.meta.url)("electron");
}
