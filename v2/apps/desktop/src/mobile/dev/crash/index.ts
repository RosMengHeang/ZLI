import { emptyMobileDevFeature, type MobileDevFeature, type MobileDevHost } from "../host.js";

/**
 * Placeholder for F4, the live device log with crash detection. Stream S3 owns this file and replaces it with the mobilecrashes action, a decorate hook that adds new crashes to agent results, the zli:mobile:crash:* channels, and its e2e test operations.
 * Until then the feature adds nothing.
 */
export function createCrash(_host: MobileDevHost): MobileDevFeature {
  return emptyMobileDevFeature();
}
