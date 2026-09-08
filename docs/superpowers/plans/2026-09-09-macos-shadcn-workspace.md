# Taxzy macOS-style shadcn workspace implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the complete Taxzy interface with a compact, accessible shadcn-based macOS-style workbench while preserving all agent, terminal, browser, TaxChat, Git, and workspace behavior.

**Architecture:** Add a local shadcn primitive layer and a centralized Taxzy token theme, then migrate the application frame and feature surfaces in vertical slices. Keep the established Zustand state and `react-resizable-panels` topology so Browser, TaxChat, and Changes remain independent and simultaneous.

**Tech Stack:** React 19, TypeScript 6, Tauri 2, Tailwind CSS 4, shadcn/ui, Radix primitives, Lucide, Zustand, xterm, react-resizable-panels, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-09-macos-shadcn-workspace-design.md`

## Global Constraints

- ENERGY 1 / RHYTHM 2 / MOTION 1.
- Browser, TaxChat, and Changes remain independent resizable panes and may be open simultaneously.
- The setup flow cannot be skipped without a project.
- No gradients, glow, uppercase utility labels, excessive pills, decorative badges, or dead controls.
- Preserve saved workspace, terminal, browser bounds, TaxChat, and Git behavior.
- Use test-first red-green-refactor for every behavior change.

---

### Task 1: Establish the shadcn foundation and Taxzy tokens

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vite.config.ts`
- Create: `components.json`
- Create: `src/lib/utils.ts`
- Create: `src/components/ui/button.tsx`
- Create: `src/components/ui/input.tsx`
- Create: `src/components/ui/badge.tsx`
- Create: `src/components/ui/separator.tsx`
- Create: `src/components/ui/tooltip.tsx`
- Create: `src/components/ui/dialog.tsx`
- Create: `src/components/ui/tabs.tsx`
- Create: `src/components/ui/scroll-area.tsx`
- Create: `src/components/ui/collapsible.tsx`
- Create: `src/components/ui/dropdown-menu.tsx`
- Create: `src/components/ui/resizable.tsx`
- Modify: `src/index.css`
- Test: `tests/uiDesignContract.test.mjs`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` and local shadcn primitive exports consumed by all later tasks.

- [ ] Write assertions that require `components.json`, the `@/*` alias, local UI primitives, system font tokens, ENERGY 1, and the absence of gradients/glow/uppercase utility styles.
- [ ] Run `npm test -- tests/uiDesignContract.test.mjs` and verify failure because the shadcn foundation and new contract do not exist.
- [ ] Configure the existing Vite/Tailwind project following the official shadcn Vite installation, add only the listed primitives, and replace global tokens with the exact spec values.
- [ ] Run the focused test, `npm run lint`, and `npm run build`; verify all pass.
- [ ] Commit the foundation as `feat: add Taxzy shadcn design foundation`.

### Task 2: Join the top bar and sidebar into one app frame

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/TopBar.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/AppIcons.tsx`
- Modify: `src/lib/chromePresentation.ts`
- Modify: `src/index.css`
- Test: `tests/chromePresentation.test.mjs`
- Test: `tests/presentationBehavior.test.mjs`

**Interfaces:**
- Consumes: shadcn Button, Input, Tooltip, ScrollArea, Separator, DropdownMenu.
- Produces: a 48px `app-frame-header`, a 232px/52px sidebar, and compact toolbar density rules.

- [ ] Add failing presentation tests for the 48px connected header, 232px/52px sidebar sizes, compact breakpoints, and removal of `Workspace`, `Workspace layout`, `Local agent workspace`, and `Current project` filler.
- [ ] Run the focused tests and verify they fail for the old dimensions and copy.
- [ ] Recompose AppShell so the brand header and TopBar share one row; migrate all interactive controls to shadcn primitives while preserving shortcuts and state actions.
- [ ] Simplify Sidebar to projects, nested agents, Open project, Preferences, and Help; preserve collapse, search, persistence, and project switching.
- [ ] Run focused tests, lint, and build; verify all pass.
- [ ] Commit as `feat: redesign the Taxzy application frame`.

### Task 3: Simplify repository and agent setup

**Files:**
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/setup/SetupProjectStep.tsx`
- Modify: `src/components/setup/SetupAgentsStep.tsx`
- Modify: `src/components/setup/SetupReviewStep.tsx`
- Modify: `src/index.css`
- Test: `tests/setupModel.test.mjs`
- Test: `tests/presentationBehavior.test.mjs`

**Interfaces:**
- Consumes: shadcn Button, Input, Badge, Collapsible, Tooltip.
- Produces: required repository gate and compact provider quantity rows.

- [ ] Add failing tests proving setup exposes no `Skip for now`, no marketing side card, and still supports provider quantities from zero through six.
- [ ] Run focused tests and verify the old setup copy causes failure.
- [ ] Replace the two-column marketing layout with one centered workflow, migrate inputs/buttons/disclosure to shadcn primitives, and retain all launch/retry/error behavior.
- [ ] Run focused tests, lint, and build; verify all pass.
- [ ] Commit as `feat: simplify workspace setup`.

### Task 4: Redesign the terminal canvas and pane headers

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/PaneTreeView.tsx`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/StatusBadge.tsx`
- Modify: `src/components/ProviderIcon.tsx`
- Modify: `src/index.css`
- Test: `tests/statusPresentation.test.mjs`
- Test: `tests/terminalSessions.test.mjs`
- Test: `tests/uiDesignContract.test.mjs`

**Interfaces:**
- Consumes: shadcn Button, Badge, Tooltip, DropdownMenu, Resizable.
- Produces: compact terminal header and unchanged pane-tree operations.

- [ ] Add failing structural assertions for compact terminal chrome, semantic provider markers, one-action empty states, and no decorative panel copy.
- [ ] Run focused tests and verify failure against the current markup.
- [ ] Migrate terminal and pane controls to shared primitives, reduce header height and copy, preserve xterm mount/focus/resize/retry/close behavior, and keep provider identity accessible without decorative color washes.
- [ ] Run focused tests, lint, and build; verify all pass.
- [ ] Commit as `feat: refine terminal workspace chrome`.

### Task 5: Restyle simultaneous Browser, TaxChat, and Changes panes

**Files:**
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/BrowserPanel.tsx`
- Modify: `src/components/TaxChatPanel.tsx`
- Modify: `src/components/GitReviewPanel.tsx`
- Modify: `src/components/DiffViewer.tsx`
- Modify: `src/lib/chromePresentation.ts`
- Modify: `src/index.css`
- Test: `tests/chromePresentation.test.mjs`
- Test: `tests/browserNavigation.test.mjs`
- Test: `tests/taxChatPresentation.test.mjs`

**Interfaces:**
- Consumes: shared UI primitives and existing independent `browserOpen`, `taxChatOpen`, and `gitPanelOpen` state.
- Produces: overlap-free right browser, side TaxChat, and bottom Changes layouts that can coexist.

- [ ] Add failing tests for simultaneous-pane layout constraints, practical pixel minimums, compact pane toolbars, and removal of `Agent room`/decorative badges.
- [ ] Run focused tests and verify failure against existing copy and layout contract.
- [ ] Migrate all three pane toolbars and states to shared primitives; keep each pane independent and adjust compression/minimum sizing so all combinations stay inside the shell.
- [ ] Run focused tests, lint, and build; verify all pass.
- [ ] Commit as `feat: redesign workspace utility panes`.

### Task 6: Migrate dialogs and complete visual verification

**Files:**
- Modify: `src/components/Modal.tsx`
- Modify: `src/components/AddAgentDialog.tsx`
- Modify: `src/components/PathDialog.tsx`
- Modify: `src/components/CommitDialog.tsx`
- Modify: `src/components/DiscardDialog.tsx`
- Modify: `src/components/MergeDialog.tsx`
- Modify: `src/components/HelpDialog.tsx`
- Modify: `src/components/PreferencesDialog.tsx`
- Modify: `src/index.css`
- Test: `tests/presentationBehavior.test.mjs`
- Test: `tests/uiTheme.test.mjs`

**Interfaces:**
- Consumes: shadcn Dialog, Button, Input, Tabs, Badge, Tooltip.
- Produces: consistent accessible modal behavior with unchanged store actions.

- [ ] Add failing tests for shared dialog structure, destructive action treatment, theme consistency, accessible labels, and removal of obsolete modal wrappers.
- [ ] Run focused tests and verify failure against the hand-built modal layer.
- [ ] Migrate dialogs to the shared Dialog primitive, preserve focus/escape/submit behavior, and remove duplicate descriptions.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`; verify clean output.
- [ ] Run the Vite preview and visually inspect repository setup, agent quantities, expanded/collapsed sidebar, 2x2 terminals, Browser only, TaxChat only, Changes only, all three panes together, dialogs, empty/error/loading states, and dark/light themes.
- [ ] Commit as `feat: complete the Taxzy interface redesign`.
