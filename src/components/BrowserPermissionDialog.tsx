import { IconShield } from "./AppIcons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useBrowserStore } from "../stores/browserStore";
import type { BrowserCapability } from "../lib/browser/browserProtocol";

const PERMISSIONS: Array<{
  capability: BrowserCapability;
  title: string;
  description: string;
}> = [
  {
    capability: "browser.read",
    title: "Read pages",
    description: "Inspect the page structure, console messages, and page errors.",
  },
  {
    capability: "browser.control",
    title: "Control pages",
    description: "Navigate, click, type, press keys, and capture the visible page.",
  },
  {
    capability: "browser.javascript",
    title: "Run JavaScript",
    description: "Execute custom code in the page. Grant only when an agent truly needs it.",
  },
];

export function BrowserPermissionDialog() {
  const open = useBrowserStore((state) => state.permissionOpen);
  const surface = useBrowserStore((state) => state.surface);
  const pending = useBrowserStore((state) => state.pendingCapability);
  const error = useBrowserStore((state) => state.error);
  const setOpen = useBrowserStore((state) => state.setPermissionOpen);
  const setCapability = useBrowserStore((state) => state.setCapability);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md gap-0 overflow-hidden border-line bg-panel p-0 shadow-xl">
        <DialogHeader className="border-b border-line px-5 py-4 text-left">
          <div className="flex items-center gap-2">
            <IconShield className="h-4 w-4 text-paper" />
            <DialogTitle className="text-[14px]">Browser access</DialogTitle>
          </div>
          <DialogDescription className="text-[12px] leading-5 text-mute">
            Permissions apply only to this project and its default browser profile.
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-line">
          {PERMISSIONS.map(({ capability, title, description }) => {
            const granted = surface?.capabilities.includes(capability) ?? false;
            return (
              <div key={capability} className="flex items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-paper">{title}</div>
                  <p className="mt-1 text-[12px] leading-5 text-mute">{description}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={granted ? "secondary" : "default"}
                  className="mt-0.5 min-w-16"
                  disabled={!surface || pending !== null}
                  onClick={() => void setCapability(capability, !granted)}
                >
                  {pending === capability ? "Saving…" : granted ? "Revoke" : "Allow"}
                </Button>
              </div>
            );
          })}
        </div>
        {surface ? (
          <div className="border-t border-line px-5 py-3 text-[11px] text-mute">
            Project: <span className="text-paper">{surface.projectId}</span>
          </div>
        ) : null}
        {error ? <p role="alert" className="border-t border-line px-5 py-3 text-[12px] text-danger">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
