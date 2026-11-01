import { emptyMobileDevFeature, type MobileDevFeature, type MobileDevHost } from "../host.js";

/**
 * Placeholder for F2, the mobile doctor and the AGENTS.md block. Stream S2 owns this file and replaces it with the mobiledoctor action, the zli:mobile:doctor:* channels, and its e2e test operations.
 * Until then the feature adds nothing.
 */
export function createDoctor(_host: MobileDevHost): MobileDevFeature {
  return emptyMobileDevFeature();
}
