import type { OpenInApp, OpenInKind } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Menu, type MenuItem, type MenuRequest } from "../ui/Menu.js";

const STORAGE_KEY = "zli.openIn.v1";
const GAP = 4;

const KIND_ICONS: Record<OpenInKind, IconName> = {
  editor: "code",
  agent: "bot",
  terminal: "terminal",
  files: "folderOpen",
};
const KIND_ORDER: readonly OpenInKind[] = ["editor", "agent", "terminal", "files"];

function readPreferred(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePreferred(appId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, appId);
  } catch {
    // Storage can be unavailable; the choice still holds until the window closes.
  }
}

/** The app the main button opens: the one picked last, else the first editor, else the file manager. */
export function primaryApp(apps: readonly OpenInApp[], preferred: string | undefined): OpenInApp | undefined {
  return apps.find((app) => app.id === preferred) ?? apps.find((app) => app.kind === "editor") ?? apps[0];
}

/** Menu entries grouped by kind, with a rule between groups. */
export function openInMenuItems(apps: readonly OpenInApp[], open: (app: OpenInApp) => void): MenuItem[] {
  const items: MenuItem[] = [];
  for (const kind of KIND_ORDER) {
    const group = apps.filter((app) => app.kind === kind);
    if (group.length === 0) continue;
    if (items.length > 0) items.push({ separator: true });
    for (const app of group) {
      items.push({
        label: app.name,
        ...(app.icon ? { image: app.icon } : { icon: KIND_ICONS[app.kind] }),
        run: () => open(app),
      });
    }
  }
  return items;
}

function errorText(cause: unknown, app: OpenInApp): string {
  const message = cause instanceof Error ? cause.message : "";
  // Electron prefixes errors thrown in the main process with the IPC channel.
  const plain = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
  return plain || `${app.name} could not open this folder.`;
}

function AppMark({ app }: { app: OpenInApp }) {
  return app.icon ? (
    <img className="open-in-icon" src={app.icon} alt="" width={16} height={16} draggable={false} />
  ) : (
    <Icon name={KIND_ICONS[app.kind]} size={13} />
  );
}

/** Opens the worktree folder in an editor or another app; the arrow picks which one. Desktop only. */
export function OpenInButton({ worktreeId, onError }: { worktreeId: string; onError(message: string): void }) {
  const { bridge } = useRuntime();
  const openIn = bridge?.openIn;
  const [apps, setApps] = useState<OpenInApp[]>();
  const [preferred, setPreferred] = useState(readPreferred);
  const [menu, setMenu] = useState<MenuRequest>();
  const closeMenu = useCallback(() => setMenu(undefined), []);

  const refresh = useCallback(() => {
    if (!openIn) return;
    void openIn
      .apps()
      .then(setApps)
      .catch(() => setApps((current) => current ?? []));
  }, [openIn]);
  useEffect(refresh, [refresh]);

  if (!openIn || !apps || apps.length === 0) return null;
  const primary = primaryApp(apps, preferred);
  if (!primary) return null;

  const open = (app: OpenInApp) => {
    setPreferred(app.id);
    writePreferred(app.id);
    openIn.open(worktreeId, app.id).catch((cause: unknown) => onError(errorText(cause, app)));
  };

  return (
    <div className="open-in">
      <button
        type="button"
        className="btn btn-ghost btn-sm open-in-main"
        aria-label={`Open in ${primary.name}`}
        data-tooltip={`Open in ${primary.name}`}
        onClick={() => open(primary)}
      >
        <AppMark app={primary} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm open-in-more"
        aria-label="Open in another app"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-tooltip={menu ? undefined : "Open in another app"}
        onClick={(event) => {
          if (menu) {
            closeMenu();
            return;
          }
          refresh();
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu({
            x: rect.right,
            y: rect.bottom + GAP,
            align: "end",
            anchor,
            label: "Open in",
            items: openInMenuItems(apps, open),
          });
        }}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {menu ? <Menu request={menu} onClose={closeMenu} /> : null}
    </div>
  );
}
