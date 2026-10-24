import { useRef } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

export function RestartToUpdateDialog({
  version,
  busyCount,
  onRestart,
  onCancel,
}: {
  version: string;
  busyCount: number;
  onRestart(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      label="Restart to update"
      size="sm"
      title={`Restart to update to v${version}?`}
      subtitle={
        busyCount === 1
          ? "An agent is still working. Restarting ZLI stops it in the middle of its turn."
          : `${busyCount} agents are still working. Restarting ZLI stops them in the middle of their turns.`
      }
      scrimLabel="Cancel"
      showClose={false}
      initialFocusRef={cancelRef}
      onClose={onCancel}
    >
      <div className="dialog-footer">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onRestart}>
          Restart anyway
        </Button>
      </div>
    </Dialog>
  );
}
