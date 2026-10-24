import { type KeyboardEvent, useState } from "react";

import { Dialog } from "../ui/Dialog.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";

export type PaletteCommand = {
  label: string;
  icon: IconName;
  group: "Create" | "Go to" | "View" | "App" | "Plugins";
  /** A shortcut that runs the same command, for example "Mod+N". */
  shortcut?: string;
  action(): void;
};

const groupOrder: PaletteCommand["group"][] = ["Create", "Go to", "View", "App", "Plugins"];

export function CommandPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const needle = query.trim().toLowerCase();
  const filtered = groupOrder.flatMap((group) =>
    commands.filter((command) => command.group === group && command.label.toLowerCase().includes(needle)),
  );
  const run = (command: PaletteCommand) => {
    onClose();
    command.action();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[activeIndex];
      if (command) run(command);
    }
  };

  return (
    <Dialog label="Command palette" className="command-palette" scrimLabel="Close command palette" onClose={onClose}>
      <div className="palette-search">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commands"
          aria-label="Search commands"
        />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-list">
        {filtered.length === 0 ? (
          <p className="palette-empty">No commands match "{query.trim()}".</p>
        ) : (
          filtered.map((command, index) => {
            const startsGroup = index === 0 || filtered[index - 1]?.group !== command.group;
            return (
              <div key={command.label} className="palette-entry">
                {startsGroup ? (
                  <p className="palette-group" aria-hidden="true">
                    {command.group}
                  </p>
                ) : null}
                <button
                  className={`palette-item${index === activeIndex ? " is-active" : ""}`}
                  type="button"
                  aria-label={command.label}
                  onClick={() => run(command)}
                  onMouseMove={() => setActiveIndex(index)}
                >
                  <Icon name={command.icon} size={15} />
                  <span className="palette-label">{command.label}</span>
                  {command.shortcut ? <Kbd shortcut={command.shortcut} /> : null}
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="palette-footer" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to run
        </span>
      </div>
    </Dialog>
  );
}
