import { emptyMobileDevFeature, type MobileDevFeature, type MobileDevHost } from "../host.js";

/**
 * Placeholder for F3, the package guard. Stream S2 owns this file and replaces it with the mobilecheckpackage action, the zli:mobile:packages:* channels, and its e2e test operations.
 * Until then the feature adds nothing.
 */
export function createPackages(_host: MobileDevHost): MobileDevFeature {
  return emptyMobileDevFeature();
}
