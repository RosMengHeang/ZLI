# Quiet Native UI Redesign

## Purpose

Redesign Taxzy as a clean, approachable Windows desktop application with the visual restraint and interaction clarity associated with well-made macOS utilities. The interface should feel native and calm without pretending to be a literal macOS window. It must remain efficient for terminal-heavy development work and easy for a first-time user to understand.

The redesign covers the setup flow, app chrome, navigation, agent workspace, terminal panes, browser dock, Git review, dialogs, empty states, loading states, and errors. Runtime behavior, agent launch semantics, PTY behavior, Git operations, and browser embedding contracts remain unchanged unless a visual interaction requires a small state API adjustment.

## Product Character

Taxzy is a desktop command center for running several coding agents against one local project. Its visual identity should communicate three qualities:

1. **Calm control:** many agents can be active without the interface feeling noisy.
2. **Local confidence:** project, branch, process, and error state are visible where decisions are made.
3. **Direct manipulation:** panes, browser, Git review, and agent selection feel spatial and predictable.

The memorable element is the agent workspace: each terminal reads as a tidy native work surface with subtle provider identity. Everything around it stays quiet.

## Design Principles

- Use hierarchy before decoration. Size, spacing, grouping, and material changes must explain the interface.
- Keep one primary action per region. Secondary actions use neutral treatments and destructive actions remain visually reserved.
- Prefer sentence case and plain verbs. Labels describe what happens: “Open project,” “Add agent,” “Start agents,” and “Open browser.”
- Preserve context. The browser and Git review extend beside or below the workspace instead of replacing it.
- Show status close to its owner. Agent status belongs with the agent; branch status belongs with the project; load failures belong inside the affected surface.
- Spend color only on selection, focus, provider identity, and meaningful status.
- Use rounded geometry by hierarchy rather than applying one radius to every object.
- Keep animation responsive and functional. Motion explains an opening panel, selection, reorder, or completion; it never decorates idle screens.

## Visual System

### Color

Taxzy follows the operating-system appearance for application chrome. Terminal canvases remain dark in both themes so ANSI color and long-running CLI output stay predictable.

Dark theme:

- `app-canvas`: `#161618`
- `sidebar`: `#1F1F22`
- `surface`: `#252528`
- `surface-raised`: `#2C2C30`
- `separator`: `rgba(255, 255, 255, 0.08)`
- `text-primary`: `#F4F4F5`
- `text-secondary`: `#A1A1A6`
- `accent`: `#0A84FF`

Light theme:

- `app-canvas`: `#ECECEF`
- `sidebar`: `#F4F4F6`
- `surface`: `#FFFFFF`
- `surface-raised`: `#FAFAFB`
- `separator`: `rgba(0, 0, 0, 0.09)`
- `text-primary`: `#1D1D1F`
- `text-secondary`: `#6E6E73`
- `accent`: `#007AFF`

Semantic colors use system-like values and appear only with supporting text or iconography:

- success: `#30D158` dark / `#248A3D` light
- warning: `#FFD60A` dark / `#B25000` light
- danger: `#FF453A` dark / `#D70015` light

Provider colors are narrow identity accents on terminal headers and provider icons. They do not tint entire cards or large backgrounds.

### Typography

- UI family: `"Segoe UI Variable Text", "SF Pro Text", system-ui, sans-serif`.
- Display family: the same system stack at stronger weight; no separate decorative heading face.
- Code family: `"IBM Plex Mono", "Cascadia Mono", Consolas, monospace`.
- Primary body size: 13px with 19px line height.
- Secondary and metadata size: 11–12px with 16–18px line height.
- Toolbar labels: 12px medium.
- Dialog titles: 17px semibold.
- Setup title: 28–32px semibold with tight but not negative tracking.
- Uppercase is not used for navigation or section labels. Acronyms and compact status badges are the only exceptions.

### Spacing and Geometry

- Base spacing rhythm: 4px; common gaps are 8, 12, 16, 20, 24, and 32px.
- Top toolbar: 52px high.
- Sidebar: 228px default width, resizable from 196px to 300px.
- Compact controls: 28px high; standard controls: 32px; primary setup actions: 36–40px.
- Icon-only controls: 28×28px with a 16px icon.
- Fields and segmented controls: 9–10px radius.
- Menus and popovers: 12px radius.
- Workspace tiles: 14px radius.
- Dialogs and setup cards: 16px radius.
- Pills are reserved for status, counts, and true segmented selections.
- Dividers use one physical pixel where possible and remain lower contrast than adjacent text.

### Elevation and Materials

- The base app uses flat, adjacent materials separated by low-contrast dividers.
- Popovers use a soft two-part shadow: a short contact shadow plus a broad low-opacity shadow.
- Dialogs use stronger elevation and a lightly blurred backdrop.
- Workspace tiles use a subtle border and no permanent shadow; the active tile receives an accent focus ring.
- Transparency is limited to overlays and optional sidebar material. The app must remain legible when Windows transparency effects are disabled.

### Icons

- Use one internal SVG icon set with 1.5px rounded strokes, `currentColor`, and consistent 24×24 view boxes.
- Default rendered size is 16px; primary navigation may use 18px.
- Every icon-only button has an accessible label and tooltip.
- Avoid text glyphs for arrows, reload, close, overflow, search, drag handles, and window actions.
- Provider logos remain visually distinct but fit inside the same 24px container and optical weight.

### Motion and Focus

- Interaction duration: 160ms for hover and selection, 220ms for panes and dialogs.
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Resize feedback is immediate and is not animated.
- Focus uses a 2px accent ring with a 2px offset where space permits.
- `prefers-reduced-motion` removes transforms and nonessential transitions.

## Information Architecture

### Application Shell

The app uses three stable regions:

```text
┌──────────────────────────────────────────────────────────────────┐
│ Sidebar │ Project toolbar                                        │
│         ├─────────────────────────────────────┬────────────────────┤
│         │ Agent workspace                     │ Browser inspector  │
│         │                                     │ (optional)         │
│         ├─────────────────────────────────────┴────────────────────┤
│         │ Git review (optional bottom panel)                       │
└──────────────────────────────────────────────────────────────────┘
```

- The left sidebar owns global navigation, current project, and agent selection.
- The toolbar owns project-level context and actions.
- The center workspace owns terminal panes and its layout controls.
- Browser and Git review are inspectors that preserve workspace context.
- Resizable separators receive a larger invisible pointer target than their visible line.
- Pane sizes persist locally and restore within safe minimums.

### Navigation

The sidebar has four primary destinations: Workspace, Agents, Changes, and Browser. These labels remain visible at normal width; icons support recognition but do not replace labels. The active destination uses a quiet filled selection, not an outline or high-saturation block.

Project information is grouped below navigation in one compact surface: project name, truncated path, branch, and clean/dirty state. Agent entries live below the project with provider icon, user-defined name, role/provider subtitle, and one status indicator. New-agent and project actions are positioned beside the region they affect.

Help and preferences remain at the bottom of the sidebar.

### Project Toolbar

The toolbar presents, left to right:

1. Current project name and branch context.
2. A centered workspace-layout segmented control when terminals exist.
3. Contextual actions: add terminal, add agent, toggle browser, and toggle Git review.
4. A compact aggregate running-state indicator.

Actions collapse by priority as width decreases. Text labels disappear only after tooltips and accessible names are present. Destructive operations never appear in the main toolbar.

## Core Screens and Components

### Setup Flow

The setup experience is a focused three-step window: Project, Agents, Review. It removes promotional decoration that competes with the task.

- A slim left rail contains the Taxzy mark, step progress, Help, and Preferences.
- The main column uses a maximum readable width and one surface per step.
- An optional right summary appears only when it can show selected project and planned agents; it is not a marketing panel.
- Step 1 presents one obvious “Choose project folder” action and a secondary manual-path option.
- Step 2 shows detected tools first. Users select a tool, quantity, role/name, and isolation preference in a compact editable list.
- Step 3 summarizes exactly what will launch, including unavailable tools and how to fix them.
- Progress while launching is shown per agent. A partial failure keeps successful agents and offers retry for failed rows.
- “Skip for now” remains available but visually secondary.

### Agent Workspace

- One terminal fills the available workspace.
- Two or more terminals use a two-column grid by default; four terminals form a 2×2 layout.
- Rows size evenly within the viewport when practical and scroll when the minimum readable terminal height would be violated.
- Layout presets are Focus, Grid, and Even. Their icons and tooltips explain the result.
- Empty state offers “Add agent,” “Open browser,” and a short explanation of what each does.
- An active terminal receives a subtle accent ring and stronger title text.

### Terminal Tile

The terminal tile has a 36px title bar and a dark terminal canvas.

- Header: provider icon, terminal/agent name, provider or role subtitle, running state, and overflow actions.
- Provider identity appears as a 2px top accent or a small icon detail, never a full-width saturated band.
- Split, restart, and close use SVG icons with tooltips.
- “Starting” uses a small inline progress indicator without replacing the terminal canvas.
- Errors appear in a compact recoverable strip with Retry and Details actions.
- Terminal padding, font, cursor, selection, and ANSI palette are consistent across providers.

### Browser Inspector

- Browser opens as a resizable right inspector, 30% default width, with practical minimum and maximum bounds.
- Toolbar contains back, forward, reload, address field, and external-open action.
- The empty state offers a few useful destinations without decorative cards.
- Native Tauri WebView is used in the desktop app; web preview may use an iframe fallback.
- Navigation failures explain whether the site blocked embedding and keep “Open externally” available.
- Closing the inspector releases WebView listeners and preserves the last address for the session.

### Git Review

- Git review opens below the workspace and preserves terminal context.
- Header shows branch, file count, additions/deletions, refresh, commit, merge, and discard in clear priority order.
- Changed files use a compact sidebar with status letters and readable filenames.
- Diff content prioritizes code legibility; syntax/status color never becomes the only indication of meaning.
- Commit, merge, and discard use focused dialogs with explicit targets and final action labels.
- Destructive confirmation names the affected path or branch.

### Dialogs and Popovers

- Dialogs use one title, optional concise description, content, and a right-aligned action row.
- Escape and backdrop click close safe dialogs. Busy or destructive confirmation dialogs cannot close accidentally.
- Focus is trapped inside and restored to the opening control.
- Validation appears beside the field it affects; operation failures appear above the action row.
- Menus align to their trigger and remain inside the viewport.

### Empty, Loading, and Error States

- Empty states explain the next useful action in one sentence and provide at most two primary choices.
- Skeletons are used only when layout is known and loading exceeds a perceptible delay.
- Spinners are small and local to the action that is waiting.
- Error messages state what failed and the next step. Technical details are available through disclosure rather than occupying the primary message.
- Offline or missing-tool state never appears as a generic failure; it identifies the unavailable CLI and provides a rescan action.

## Theme Behavior

- Default theme is `system` and reacts to operating-system appearance changes without restarting.
- Users may override with Light, Dark, or System in Preferences.
- Theme choice persists locally.
- Native browser child surfaces and terminal canvases coordinate background colors during creation to avoid white flashes.
- All non-terminal components meet WCAG AA contrast for normal text and controls.

## Component Boundaries

Implementation should keep responsibilities explicit:

- `AppShell` composes resizable application regions and persists panel dimensions.
- `Sidebar` owns navigation and project/agent summaries.
- `TopBar` owns project-level context and actions.
- `Workspace` chooses empty, focused, or grid presentation.
- `TerminalPane` owns one terminal tile and its controls.
- `BrowserPanel` owns browser navigation and WebView lifecycle.
- `GitReviewPanel` owns changed-file navigation and review actions.
- `SetupWizard` owns the three-step setup state; repeated controls should be extracted when it improves readability.
- `Modal` supplies accessible dialog structure and focus behavior.
- `AppIcons` is the single source for shell SVG icons.
- Theme tokens and reusable control classes live in `src/index.css`; components consume semantic tokens rather than hard-coded chrome colors.

State stores remain domain-specific. Theme preference belongs in UI preferences; it must not enter agent, terminal, or Git stores. The visual redesign must not duplicate runtime state in local component state.

## Responsive and Window Behavior

- Supported minimum window size is 900×600px.
- From 900–1099px, the sidebar may narrow, toolbar labels collapse, and the browser inspector opens wider than its desktop percentage to remain usable.
- At 1100px and above, the standard sidebar, two-column workspace, and optional browser inspector fit together.
- Terminal tiles never shrink below 360px width or 220px height; the workspace scrolls or changes layout when these minimums cannot be preserved.
- Setup summary collapses below the main content when the window cannot support three columns.
- Windows title-bar and drag-region behavior must remain usable with display scaling from 100% through 200%.

## Accessibility and Input

- Every action is keyboard reachable in a logical order.
- Focus indicators remain visible in both themes.
- Icon-only controls have `aria-label` text and native/title tooltips.
- Sidebar lists and agent selectors expose selection semantics.
- Dialog focus is trapped and restored.
- Status is communicated by text or icon in addition to color.
- Hit targets are at least 28×28px for compact desktop controls and 32×32px for primary navigation.
- Existing keyboard shortcuts continue to work and are displayed in Help or tooltips where relevant.

## Implementation Scope

The redesign is delivered as a coordinated pass rather than isolated restyling:

1. Establish semantic theme tokens, typography, geometry, focus, and motion primitives.
2. Consolidate icons and base controls.
3. Redesign shell, sidebar, toolbar, and resizable regions.
4. Redesign setup flow and empty states.
5. Redesign terminal workspace and tile states.
6. Redesign browser and Git inspectors.
7. Redesign dialogs, menus, errors, and loading states.
8. Add system theme behavior and persistence.
9. Run visual, keyboard, responsive, and runtime regression verification.

No new account system, cloud synchronization, plugin marketplace, terminal protocol, Git workflow, or browser engine is part of this redesign.

## Verification and Acceptance Criteria

The redesign is complete only when all of the following are verified:

- Fresh launch presents a focused setup flow with clear Project, Agents, and Review steps.
- A new user can select a project, choose detected tools and quantities, and start agents without needing documentation.
- One, two, and four terminal configurations render correctly; four agents visibly form a 2×2 grid.
- Terminals preserve ANSI color and remain readable in both application themes.
- Browser opens, resizes, navigates, and closes as a right-side inspector without covering or destroying terminal state.
- Git review opens below the workspace and all commit, merge, refresh, and discard actions remain functional.
- System, Light, and Dark theme modes render without hard-coded mismatched surfaces.
- The interface remains usable at 900×600, 1280×720, and 1600×1000, including 150% Windows display scaling where runtime inspection is available.
- Keyboard-only navigation reaches every primary action, dialog focus is contained, and focus returns after close.
- Reduced-motion mode removes nonessential animation.
- Automated frontend tests, lint, production build, Rust checks, and Rust tests pass.
- A visual review of setup, empty workspace, populated 2×2 workspace, browser inspector, Git review, and representative dialogs finds no clipping, inconsistent icon weight, accidental double borders, or unclear primary actions.

