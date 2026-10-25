import type { PluginOrigin } from "@zli-v2/contracts";

import { Badge } from "../ui/Badge.js";
import { originLabel, UNKNOWN_SOURCE_TIP } from "./plugins.js";

/** Where a plugin came from. Plugins from anywhere else get a warning tone. */
export function OriginBadge({ origin }: { origin: PluginOrigin }) {
  return (
    <Badge
      tone={origin === "other" ? "warning" : origin === "zli-catalog" ? "success" : "neutral"}
      {...(origin === "other" ? { title: UNKNOWN_SOURCE_TIP } : {})}
    >
      {originLabel[origin]}
    </Badge>
  );
}
