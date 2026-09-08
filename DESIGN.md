# Taxzy interface direction

## Design read

Reading this as: a local developer workspace for people coordinating several
coding agents, in a restrained charcoal workbench style, dial ENERGY 1 /
RHYTHM 2 / MOTION 1.

## Identity

Taxzy is a room for work already in motion. The interface should feel like a
well-organized control room, not a marketing page: the repository is the home,
agents are the visible workers, and terminals, browser, changes, and TaxChat
are tools that share the same work surface.

## Palette

- Canvas: `#181818`, a soft charcoal that keeps terminal text comfortable.
- Sidebar: `#202020`, a slightly lifted navigation plane.
- Surface: `#212121`, shared pane and chrome color.
- Raised surface: `#262626`, reserved for controls and focused content.
- Accent: white in dark mode and `#111111` in light mode, reserved for primary actions.
- Status colors: green, amber, and red are reserved for real process state.

## Typography

- Bundled Inter Variable carries controls and body copy consistently on every
  machine, with Segoe UI Variable as the native Windows fallback.
- JetBrains Mono with SFMono-Regular and Consolas fallbacks is limited to paths,
  branches, timestamps, and terminal output.

## Composition principles

- The left tree is the persistent home for project and agent context.
- Lucide's closed and open folder glyphs mirror the familiar ChatGPT desktop
  geometry and carry project expansion state, removing the
  need for project initials, count badges, and a second disclosure icon.
- Agent rows are indented beneath their project and use bare product marks so
  identity is visible without adding another layer of colored tiles. Claude Code
  uses Claude's coral starburst rather than Anthropic's corporate mark.
- Project details appear in one raised hover card because metadata and actions
  are useful on demand but would make every navigation row noisy if persistent.
- The center workbench is the focal point. Browser, TaxChat, and Changes share
  one resizable utility column and stack vertically when used together. They
  never float above or overlap the terminal grid.
- Pane boundaries are quiet separators. Provider identity comes from the tool
  icon, while color is reserved for process and Git meaning.
- Empty states explain the next action. Numbers and status labels come from
  real project or process state.
- Motion is limited to focus, resizing, and status transitions. No decorative
  loops or entrance choreography.
