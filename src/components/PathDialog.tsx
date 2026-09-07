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
    <Modal title="Open Project Path" open={open} onClose={() => setOpen(false)}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
        <p className="text-[12px] text-[#8b8b8b]">
          Folder picker needs the Tauri dialog plugin. You can still open a repository by path.
          Paths with spaces are supported.
        </p>
        <input
          className="h-7 border border-[#3e3e42] bg-[#3c3c3c] px-2 font-mono text-[12px] outline-none focus:border-[#0e639c]"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="D:\work\my project"
          autoFocus
        />
        {error ? <div className="text-[11px] text-[#f14c4c]">{error.message}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="h-7 px-3 hover:bg-[#3e3e42]" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 bg-[#0e639c] px-3 text-white hover:bg-[#1177bb] disabled:opacity-40"
            disabled={loading}
          >
            {loading ? "Opening…" : "Open"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
