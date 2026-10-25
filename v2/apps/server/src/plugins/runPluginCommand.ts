import type { PluginCommand } from "@zli-v2/contracts";

import type { PluginStore } from "./PluginStore.js";

/** Answers one plugins command. Changes answer with the new list so the client never asks twice. */
export async function runPluginCommand(store: PluginStore, command: PluginCommand): Promise<unknown> {
  switch (command.type) {
    case "plugins.list":
      return store.list();
    case "plugins.previewInstall":
      return store.previewInstall(command.source);
    case "plugins.install": {
      const installed = await store.install(command.source, command.names, command.config ?? {}, command.origin);
      return { ...(await store.list()), installed };
    }
    case "plugins.setEnabled":
      await store.setEnabled(command.name, command.enabled);
      return store.list();
    case "plugins.configure":
      await store.configure(command.name, command.values);
      return store.list();
    case "plugins.update":
      await store.update(command.name);
      return store.list();
    case "plugins.remove":
      await store.remove(command.name);
      return store.list();
    case "plugins.contributions":
      return store.contributions();
    case "plugins.directory":
      return store.directory();
    case "plugins.checkUpdates":
      return store.checkUpdates();
    case "plugins.export":
      return store.exportPlugin({
        folder: command.folder,
        name: command.name,
        displayName: command.displayName,
        description: command.description,
        skills: command.skills,
        servers: command.servers,
      });
  }
}
