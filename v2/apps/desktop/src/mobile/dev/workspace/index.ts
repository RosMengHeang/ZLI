import { emptyMobileDevFeature, type MobileDevFeature, type MobileDevHost } from "../host.js";

/**
 * Placeholder for F1, per-worktree Metro port and device isolation. Stream S1 owns this file and replaces it with the mobileworkspace action, the zli:mobile:workspace:* channels, and its e2e test operations.
 * Until then the feature adds nothing.
 */
export function createWorkspace(_host: MobileDevHost): MobileDevFeature {
  return emptyMobileDevFeature();
}
