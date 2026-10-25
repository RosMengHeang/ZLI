import type { Ref } from "react";

import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

/**
 * Who holds the device. While an agent does, Take over gives the person control; once the person has it,
 * Hand back lets agents drive again.
 */
export function LeaseBanner({
  lease,
  busy,
  takeOverRef,
  onTakeOver,
  onRelease,
}: {
  lease: { kind: "agent" | "person"; text: string };
  busy: boolean;
  /** Input the agent's lease blocks moves focus here. */
  takeOverRef: Ref<HTMLButtonElement>;
  onTakeOver(): void;
  onRelease(): void;
}) {
  return (
    <div className={`banner ${lease.kind === "agent" ? "banner-warning" : "banner-info"}`} role="status">
      <Icon name={lease.kind === "agent" ? "bot" : "user"} size={14} />
      <span className="banner-message">{lease.text}</span>
      <div className="banner-actions">
        {lease.kind === "agent" ? (
          <Button ref={takeOverRef} size="xs" variant="primary" loading={busy} onClick={onTakeOver}>
            Take over
          </Button>
        ) : (
          <Button size="xs" loading={busy} onClick={onRelease}>
            Hand back to agents
          </Button>
        )}
      </div>
    </div>
  );
}
