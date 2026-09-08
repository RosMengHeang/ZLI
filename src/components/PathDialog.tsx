import { useState } from "react";
import { Modal } from "./Modal";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

export function PathDialog() {
  const open = useUiStore((s) => s.pathDialogOpen);
  const setOpen = useUiStore((s) => s.setPathDialogOpen);
  const openFromPath = useProjectStore((s) => s.openFromPath);
  const error = useProjectStore((s) => s.error);
  const loading = useProjectStore((s) => s.loading);
  const [path, setPath] = useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await openFromPath(path);
    if (ok) {
      setOpen(false);
      setPath("");
    }
  }

  return (
    <Modal title="Open project" description="Enter the path to a local Git repository." open={open} busy={loading} onClose={() => setOpen(false)}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <p className="text-[13px] leading-5 text-mute">
          Folder picker needs the Tauri dialog plugin. You can still open a repository by path.
          Paths with spaces are supported.
        </p>
        <input
          className="field font-mono"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="D:\work\my project"
          aria-label="Repository path"
          autoFocus
        />
        {error ? <div className="banner banner-error">{error.message}</div> : null}
        <div data-dialog-actions className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? "Opening…" : "Open project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
