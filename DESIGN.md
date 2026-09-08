# Taxzy interface direction

## Design read

Reading this as: a local developer workspace for people coordinating several
coding agents, in a restrained graphite workbench style, dial ENERGY 2 /
RHYTHM 2 / MOTION 1.

## Identity

Taxzy is a room for work already in motion. The interface should feel like a
well-organized control room, not a marketing page: the repository is the home,
agents are the visible workers, and terminals, browser, changes, and TaxChat
are tools that share the same work surface.

## Palette

- Canvas: `#15171A`, a deep neutral that keeps terminal text comfortable.
- Sidebar: `#1B1E22`, a slightly lifted graphite plane for navigation.
- Surface: `#23272D`, the shared pane and chrome surface.
- Raised surface: `#2B3037`, reserved for controls and focused content.
- Accent: `#6EA8FE`, used only for active workspace state and the primary action.
- Status colors: green, amber, and red are reserved for real process state.

## Typography

- Bricolage Grotesque carries the Taxzy name and screen headings because its
  compact, slightly human shapes make a technical tool feel authored.
- Segoe UI Variable carries controls and body copy because it is native-feeling
  and legible on Windows.
- IBM Plex Mono is limited to paths, branches, timestamps, and terminal output.

## Composition principles

- The left tree is the persistent home for project and agent context.
- The center workbench is the focal point. Browser and TaxChat dock beside it,
  never float above it.
- Pane borders are quiet separators. A single active blue spine communicates
  focus; provider colors appear only on terminal headers because they identify
  the running tool.
- Empty states explain the next action. Numbers and status labels come from
  real project or process state.
- Motion is limited to focus, resizing, and status transitions. No decorative
  loops or entrance choreography.
