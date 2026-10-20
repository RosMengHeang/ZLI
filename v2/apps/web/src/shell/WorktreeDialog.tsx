import { useRef, useState } from "react";

import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Field } from "../ui/Field.js";

export function WorktreeDialog({
  onClose,
  onSubmit,
}: {
  onClose(): void;
  onSubmit(branch: string, baseRef: string): void;
}) {
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const branchRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      label="Create worktree"
      size="sm"
      title="New worktree"
      subtitle="A separate folder and branch, so agents never edit the same files."
      scrimLabel="Close worktree dialog"
      initialFocusRef={branchRef}
      onClose={onClose}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(branch, baseRef);
        }}
      >
        <div className="dialog-body">
          <Field label="Branch name">
            <input
              ref={branchRef}
              className="input is-mono"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="feature/my-change"
              spellCheck={false}
            />
          </Field>
          <Field label="Start from" hint="Any branch, tag, or commit. Leave it empty to start from the current HEAD.">
            <input
              className="input is-mono"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
              placeholder="HEAD"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!branch.trim()}>
            Create worktree
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
