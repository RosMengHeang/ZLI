# ZLI interface direction

## Design read

ZLI is a local workspace for developers who run several coding agents at once.
The style is a restrained charcoal workbench, close to desktop tools such as
Codex, Cursor, and T3 Code. Dials: ENERGY 1, RHYTHM 2, MOTION 1. The interface
stays quiet so agent output, diffs, and terminal text carry the contrast.

## Identity

ZLI is a room for work already in motion, not a marketing page. The repository
is home, agents are the visible workers, and Terminal, Files, Browser, and
Changes are tools on the same work surface. Every number and status on screen
comes from real project, process, or Git state.

## Where the system lives

- `v2/packages/ui/src/tokens.css` holds every color, size, radius, shadow,
  duration, and z-index. Component CSS uses these variables, not raw values.
- `v2/packages/ui/src/primitives.css` styles the shared building blocks:
  buttons, key caps, fields, badges, status dots, segmented controls,
  tooltips, dialogs, pane headers, toolbars, banners, empty states, and
  spinners.
- `v2/apps/web/src/ui` has the React side of those primitives: `Button`,
  `IconButton`, `Kbd`, `Tooltip`, `Dialog`, `Segmented`, `Badge`, `Field`,
  `Select`, `PaneHeader`, `EmptyState`, and `LoadingState`.
- Each feature keeps its own stylesheet next to its components, for example
  `sidebar/sidebar.css`, `sessions/tile.css`, `chat/chat.css`, and
  `files/files.css`.

New UI should be built from these pieces. If a screen needs something they do
not cover, add it to the primitives instead of styling it locally.

## Palette

- Surfaces step up from the canvas: canvas `#0b0b0c`, sidebar `#0e0e0f`,
  surface `#121213`, raised `#19191a`, overlay `#202022`. Panes and tiles sit
  flat on these layers; only popovers and dialogs get a shadow.
- Borders are low-alpha white hairlines at three strengths: resting, strong,
  and hover.
- Text has three readable steps (text, muted, dim). Each one passes WCAG AA
  (4.5:1) on every surface, including the overlay. The disabled color is only
  for disabled controls and decorative glyphs.
- There is one accent, blue `oklch(.571 .21 264)`. It marks primary actions,
  keyboard focus, and the selected agent, and nothing else. Selected choice
  cards use a neutral fill with a small accent radio mark, not a blue panel.
- Green, amber, and red mean process or Git state: running or ready, working
  or modified, failed or deleted. They are not decoration.

## Typography

- No fonts are bundled. The UI asks for Inter and falls back to Segoe UI
  Variable, then the system UI font, so ZLI looks native when Inter is not
  installed.
- Monospace asks for JetBrains Mono, then SFMono-Regular, Cascadia Mono, and
  Consolas. It is used for paths, branches, diffs, timestamps, and terminal
  output.
- The type scale runs from 10.5px to 20px. Body copy and controls are 13px;
  dense lists and metadata use 11px to 12px. Tabular numbers are used wherever
  counts or sizes line up.

## Spacing and sizing

- Spacing uses a 4px scale with 2px, 6px, and 10px half-steps for dense
  chrome.
- Controls come in four heights: 20, 24, 28, and 32px. The top bar is 44px,
  pane headers 40px, and toolbars 36px, so the rows line up across panels.
- Radii are 4 to 8px on controls and 12px on dialogs and large containers.
  Pills are only for counts.

## Composition

- The left sidebar is the home for projects, agents, and worktrees.
  Collapsing it removes it completely so the workbench gets the full width.
- Agent rows sit under their project with the provider mark. A row shows a
  status badge only when the agent needs attention or is starting. Otherwise
  it shows how recently the agent was active.
- The center is a grid of agent tiles. Each tile switches between the agent's
  terminal and a chat view, can be maximized, and docks a restart bar when
  its process ends.
- Terminal, Files, Browser, and Changes open from the top bar. Files,
  Browser, and Changes share one resizable column on the right. The terminal
  drawer sits under the grid. Panels never float over the agent grid.
- Every panel starts with the same pane header: icon, title, context, then
  actions. Toolbars below it use the same height and control sizes.

## Interaction

- Every icon-only button has an accessible name and a tooltip. When an action
  has a shortcut, the tooltip shows it.
- Shortcuts appear as key caps in the command palette, on buttons, in empty
  states, and in the help dialog. Ctrl and Cmd both work. The main ones are
  Mod+K for the command palette, Mod+N for a new agent, Mod+P to go to a file,
  Mod+Shift+F to search in files, Mod+B for the sidebar, and Mod+J for the
  terminal drawer.
- Every control has hover, active, focus-visible, and disabled states. All
  focusable elements share one focus ring; text fields replace it with an
  accent border and a soft glow.
- Dialogs trap Tab, give focus back when they close, and close on Escape or a
  click outside.

## States

- Empty states say what is missing and offer the action that fills the view,
  with its shortcut when it has one.
- Loading states name what is loading next to a small spinner. There are no
  skeletons for data that does not exist yet.
- Errors appear next to the thing that failed: a banner in the panel for file
  conflicts and page load failures, inline text under a form for command
  errors. They say what happened and what the person can do next.
- While the runtime starts, the shell shows that it is connecting. A window
  opened without the desktop bridge explains how to start ZLI properly.

## Motion

Motion is limited to hover and focus feedback, resizing, chevrons, and status
spinners, at 100 to 160ms. There are no decorative loops or entrance
animations. With reduced motion turned on, transitions and animations are
switched off.
