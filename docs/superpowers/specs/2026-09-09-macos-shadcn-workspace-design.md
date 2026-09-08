# Taxzy macOS-style shadcn workspace design

## Objective

Redesign the complete Taxzy desktop interface into a quiet, compact macOS-style workbench. Preserve the existing multi-agent terminal workflow while removing decorative copy, generic dashboard styling, and controls that do not perform a useful action.

## Design read

- ENERGY 1 / RHYTHM 2 / MOTION 1.
- The terminal grid is the primary visual surface.
- The top bar and sidebar form one connected application frame.
- Browser, TaxChat, and Changes remain independent resizable panes and may be open simultaneously.
- shadcn/ui source components are the interaction foundation, customized through Taxzy tokens rather than shipped with default demo styling.

## Application frame

The frame uses a 48px unified titlebar. The sidebar brand region occupies the same height and shares the titlebar bottom separator so the two areas read as a single piece of chrome. The titlebar contains only the active project and branch, a command entry, pane toggles, layout menu, and Add agent. Remove the `Workspace` overline, aggregate duplicate status, and redundant layout labels.

The left sidebar is 232px by default and collapses to a 52px icon rail. It contains the Taxzy identity, a Projects heading with one open-folder action, optional project filtering when useful, nested project and agent rows, then Preferences and Help. Remove `Local agent workspace`, the duplicated Current project block, and explanatory filler.

## Workspace and panes

The central terminal canvas stays dominant. Terminal panes use compact headers with provider identity, agent name, status, branch when present, and controls revealed on hover. Double-click or the focus control shows one existing terminal without recreating its xterm or PTY; Escape restores the grid.

Browser, TaxChat, and Changes share one resizable right utility column. A single tool uses the full column; multiple tools stack vertically with independent separators. Changes remains a restrained 340-480px inspector when opened alone. Any combination can be open without nesting horizontal splits, overlapping content, or forcing the terminal grid into unusable strips.

Pane surfaces use one-pixel separators and 6-8px radii only where a contained panel needs a visible edge. Avoid nested cards, large shadows, floating glass effects, gradients, and ornamental borders.

## Setup flow

Setup is a compact repository, agent selection, and launch flow without numbered wizard chrome. A repository is required before entering the workspace. Remove `Skip for now`, the welcome eyebrow, the marketing summary card, numbered benefit copy, and duplicate explanations.

The repository screen presents one title, one short sentence, a primary folder picker, and a secondary manual path option. Agent selection uses compact provider rows with installed state and a quantity stepper. Advanced names and worktrees remain available through a disclosure. Launch review shows only project, agent mix, availability problems, and the start action.

## Component system

Use shadcn/ui source components under `src/components/ui` for Button, Input, Dialog, Tooltip, Tabs, ScrollArea, Badge, Separator, Collapsible, DropdownMenu, and Resizable where they replace current hand-built interaction primitives. Existing `react-resizable-panels` behavior may be wrapped rather than replaced to preserve saved pane layouts.

Use Lucide icons through the shadcn convention. Controls must have labels or tooltips, visible keyboard focus, disabled states, and minimum 28px compact / 36px primary targets. Icon-only controls use accessible names.

## Visual tokens

- UI font: Inter, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- Terminal and paths: JetBrains Mono, SFMono-Regular, Consolas, monospace.
- Dark canvas `#181818`, sidebar `#202020`, surface `#212121`, raised surface `#262626`, hover `#2a2a2a`, selected `#303030`, border `#333333`, subtle border `#2b2b2b`, text `#ececec`, muted text `#a1a1aa`, accent `#ffffff`.
- Light canvas `#fafaf9`, sidebar `#f5f5f4`, surface `#ffffff`, hover `#f5f5f4`, selected `#ececea`, border `#e7e7e5`, subtle border `#efefec`, text `#171717`, muted text `#737373`, accent `#111111`.
- Success, warning, and destructive colors appear only for real status or consequences.
- No gradients, glow, uppercase utility labels, excessive pills, or decorative badges.

## Content rules

Every visible sentence must orient the user, explain a current state, or enable recovery. Empty states have one clear action. Loading copy describes the active operation. Errors describe the problem and offer the next valid action. Preview-only controls may exist in browser development mode but must be clearly identified and absent from the Tauri runtime.

## Responsive behavior

Below 1100px, hide nonessential toolbar labels and use tooltips. Below 860px, collapse the sidebar automatically or constrain it to the icon rail. Independent panes retain practical pixel minimums; when space is insufficient, the terminal tree may compress but no pane may visually overlap another.

## Acceptance criteria

- Top bar and sidebar share one aligned, continuous frame.
- Browser, TaxChat, and Changes can all be open without overlap.
- The setup flow cannot be skipped without a project.
- Dead or decorative copy listed above is absent.
- Shared controls use local shadcn source components and Taxzy tokens.
- Dark and light themes remain legible and visually consistent.
- Keyboard focus, accessible names, loading, empty, disabled, and error states are preserved.
- Existing project persistence, agents, terminal grid, browser bounds, TaxChat coordination, and Git operations continue to work.
