import { emptyMobileDevFeature, type MobileDevFeature, type MobileDevHost } from "../host.js";

/**
 * Placeholder for F5, the build-failure classifier and agent brief. Stream S3 owns this file and replaces it with the mobilebuildbrief action, the zli:mobile:build:* channels, and its e2e test operations.
 * Until then the feature adds nothing.
 */
export function createBuild(_host: MobileDevHost): MobileDevFeature {
  return emptyMobileDevFeature();
}
