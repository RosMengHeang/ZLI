# Quiet Native UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Taxzy’s complete desktop interface as a calm, system-aware, macOS-inspired Windows application while preserving agent, terminal, browser, and Git behavior.

**Architecture:** Introduce a small theme/presentation layer around the existing Zustand stores, semantic CSS tokens, internal SVG icons, and resizable shell. Keep runtime stores domain-specific; pure helpers own theme resolution, setup planning, URL normalization, and pane arrangement so behavior is testable without a browser DOM.

**Tech Stack:** React 19, TypeScript 6, Zustand, Tailwind CSS 4, Tauri 2, react-resizable-panels 4, xterm.js 6, Node test runner, Rust/Cargo.

**Spec:** `docs/superpowers/specs/2026-09-08-quiet-native-ui-design.md`

## Global Constraints

- Default appearance is `system`; users may override with `light` or `dark`.
- Terminal canvases remain dark in every application theme.
- UI font is `"Segoe UI Variable Text", "SF Pro Text", system-ui, sans-serif`; code uses `"IBM Plex Mono", "Cascadia Mono", Consolas, monospace`.
- Spacing follows a 4px rhythm; common gaps are 8, 12, 16, 20, 24, and 32px.
- Compact controls are 28px high; standard controls are 32px; setup primary actions are 36–40px.
- Corners use 9–10px for controls, 12px for menus, 14px for workspace tiles, and 16px for dialogs.
- Shell icons use internal SVGs with 1.5px rounded strokes and `currentColor`; text glyphs are not control icons.
- Motion uses 160ms interaction and 220ms panel/dialog durations; reduced-motion removes transforms and nonessential transitions.
- Supported minimum window size is 900×600px; terminal tiles remain at least 360×220px.
- Browser remains a right inspector and Git review remains a bottom inspector.
- Every icon-only action has an accessible name and tooltip; status is never communicated by color alone.
- Existing runtime, PTY, agent launch, browser embedding, and Git command contracts remain unchanged.
- The worktree contained pre-existing uncommitted changes when this plan was written. Do not reset or overwrite them; inspect overlaps and stage only files owned by each task.

---

## File Structure

### New files

- `src/lib/theme.ts` — pure theme types, normalization, and resolution.
- `src/hooks/useTheme.ts` — applies and watches the resolved OS appearance.
- `src/components/PreferencesDialog.tsx` — System, Light, and Dark appearance selection.
- `src/lib/chromePresentation.ts` — shell dimensions and compact-toolbar decisions.
- `src/components/setup/setupModel.ts` — pure setup row/count/launch-plan helpers.
- `src/components/setup/SetupProjectStep.tsx` — project selection step.
- `src/components/setup/SetupAgentsStep.tsx` — agent configuration step.
- `src/components/setup/SetupReviewStep.tsx` — launch summary and progress step.
- `src/lib/browserNavigation.ts` — pure address normalization and history transitions.
- `src/lib/statusPresentation.ts` — user-visible status labels, tones, and animation state.
- `src/lib/dialogBehavior.ts` — safe dialog-dismissal decisions.
- `src/lib/gitPresentation.ts` — accessible changed-file status labels.
- `tests/uiTheme.test.mjs` — theme preference and resolution regression tests.
- `tests/statusPresentation.test.mjs` — visible status behavior tests.
- `tests/chromePresentation.test.mjs` — responsive shell presentation tests.
- `tests/setupModel.test.mjs` — setup count and launch-plan tests.
- `tests/browserNavigation.test.mjs` — browser address/history tests.
- `tests/presentationBehavior.test.mjs` — dialog dismissal and Git status-label tests.

### Existing files with focused changes

- `src/index.css` — semantic light/dark tokens and reusable native control/surface classes.
- `src/stores/uiStore.ts` — theme preference and browser-session address.
- `src/lib/preferences.ts` — persisted theme preference and safe chrome bounds.
- `src/components/AppIcons.tsx` — complete the consistent SVG set.
- `src/components/AppShell.tsx` — theme hook, fixed sidebar bounds, inspector geometry.
- `src/components/Sidebar.tsx` — quiet navigation, project summary, agent list hierarchy.
- `src/components/TopBar.tsx` — project context, layout segment, responsive actions.
- `src/components/SetupWizard.tsx` — coordinator for extracted steps and launch progress.
- `src/components/Workspace.tsx` — empty/single/multi-pane presentation.
- `src/components/PaneTreeView.tsx` — panel minimums and accessible resize handles.
- `src/components/TerminalPane.tsx` — native tile header, provider identity, local status/error actions.
- `src/stores/paneTree.ts` — deterministic 2×2 grid arrangement.
- `src/components/BrowserPanel.tsx` — persistent address, native inspector states, error recovery.
- `src/components/GitReviewPanel.tsx` — calmer hierarchy and responsive changed-files list.
- `src/components/Modal.tsx` — native dialog geometry and safe dismissal rules.
- `src/components/AddAgentDialog.tsx`, `CommitDialog.tsx`, `MergeDialog.tsx`, `DiscardDialog.tsx`, `PathDialog.tsx`, `HelpDialog.tsx` — consistent copy and action hierarchy.
- `tests/terminalSessions.test.mjs`, `tests/perfUsability.test.mjs` — pane and interaction regressions.

---

### Task 1: System-aware theme engine

**Files:**
- Create: `src/lib/theme.ts`
- Create: `src/hooks/useTheme.ts`
- Create: `src/components/PreferencesDialog.tsx`
- Create: `tests/uiTheme.test.mjs`
- Modify: `src/lib/preferences.ts`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/Sidebar.tsx`

**Interfaces:**
- Produces: `ThemeMode`, `ResolvedTheme`, `normalizeThemeMode(value)`, `resolveTheme(mode, systemDark)`, and `useTheme()`.
- Produces: `useUiStore().themeMode`, `useUiStore().setThemeMode(mode)`, `preferencesOpen`, and `setPreferencesOpen(open)`.
- Consumes: existing safe local-storage helpers in `src/lib/preferences.ts`.

- [ ] **Step 1: Write the failing theme test**

```js
// tests/uiTheme.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("normalizes stored theme values", async () => {
  const { normalizeThemeMode } = await import("../src/lib/theme.ts");
  assert.equal(normalizeThemeMode("light"), "light");
  assert.equal(normalizeThemeMode("dark"), "dark");
  assert.equal(normalizeThemeMode("system"), "system");
  assert.equal(normalizeThemeMode("sepia"), "system");
  assert.equal(normalizeThemeMode(null), "system");
});

test("resolves system appearance without changing explicit choices", async () => {
  const { resolveTheme } = await import("../src/lib/theme.ts");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --experimental-strip-types --test tests/uiTheme.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/theme.ts`.

- [ ] **Step 3: Implement the pure theme contract**

```ts
// src/lib/theme.ts
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}
```

Add `THEME_MODE_KEY = "taxzy:theme-mode"`, `getThemePreference()`, and `setThemePreference()` to `src/lib/preferences.ts`. Initialize `themeMode` from `getThemePreference()` in `uiStore` and persist changes inside its setter. Add `preferencesOpen` and `setPreferencesOpen(open)` beside the existing dialog state.

```ts
// src/hooks/useTheme.ts
import { useEffect } from "react";
import { resolveTheme } from "../lib/theme";
import { useUiStore } from "../stores/uiStore";

export function useTheme(): void {
  const mode = useUiStore((state) => state.themeMode);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(mode, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}
```

Call `useTheme()` once near the top of `AppShell`.

Create `PreferencesDialog` with one accessible radiogroup containing System, Light, and Dark. Each option calls `setThemeMode(mode)` immediately; the description for System reads “Match Windows appearance.” Render the dialog from `AppShell` and open it from the existing Settings control at the bottom of `Sidebar`.

- [ ] **Step 4: Run theme tests, lint, and build**

Run: `node --experimental-strip-types --test tests/uiTheme.test.mjs`

Expected: 2 tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully; the existing chunk-size advisory is non-blocking.

- [ ] **Step 5: Commit only theme-engine files**

```powershell
git add src/lib/theme.ts src/hooks/useTheme.ts src/components/PreferencesDialog.tsx tests/uiTheme.test.mjs src/lib/preferences.ts src/stores/uiStore.ts src/components/AppShell.tsx src/components/Sidebar.tsx
git commit -m "feat(ui): add system-aware theme engine"
```

---

### Task 2: Quiet Native tokens, controls, and icon contract

**Files:**
- Create: `src/lib/statusPresentation.ts`
- Create: `tests/statusPresentation.test.mjs`
- Modify: `src/index.css`
- Modify: `src/components/AppIcons.tsx`
- Modify: `src/components/ProviderIcon.tsx`
- Modify: `src/components/StatusBadge.tsx`

**Interfaces:**
- Consumes: `[data-theme="light"]` and `[data-theme="dark"]` from Task 1.
- Produces: semantic tokens `--app-canvas`, `--sidebar`, `--surface`, `--surface-raised`, `--separator`, `--text-primary`, `--text-secondary`, `--accent`, `--control-radius`, `--tile-radius`, `--dialog-radius`, `--motion-fast`, and `--motion-panel`.
- Produces: reusable `.btn`, `.btn-primary`, `.btn-quiet`, `.btn-icon`, `.field`, `.surface-dialog`, `.workspace-tile`, `.nav-item`, `.banner`, and `.status-dot` contracts.
- Produces: `statusPresentation(status)` so status text, semantic tone, and animation are derived from one tested contract.

- [ ] **Step 1: Write the failing status-presentation test**

```js
// tests/statusPresentation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("maps process state to text, semantic tone, and motion", async () => {
  const { statusPresentation } = await import("../src/lib/statusPresentation.ts");
  assert.deepEqual(statusPresentation("running"), { label: "Running", tone: "success", animated: true });
  assert.deepEqual(statusPresentation("starting"), { label: "Starting", tone: "warning", animated: true });
  assert.deepEqual(statusPresentation("failed"), { label: "Failed", tone: "danger", animated: false });
  assert.deepEqual(statusPresentation("stopped"), { label: "Stopped", tone: "neutral", animated: false });
});
```

- [ ] **Step 2: Run the focused test and verify the helper is missing**

Run: `node --experimental-strip-types --test tests/statusPresentation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/statusPresentation.ts`.

- [ ] **Step 3: Replace legacy chrome colors with the semantic token system**

Define dark defaults and a light override in `src/index.css`:

```css
:root,
[data-theme="dark"] {
  --app-canvas: #161618;
  --sidebar: #1f1f22;
  --surface: #252528;
  --surface-raised: #2c2c30;
  --separator: rgb(255 255 255 / 8%);
  --text-primary: #f4f4f5;
  --text-secondary: #a1a1a6;
  --accent: #0a84ff;
  --control-radius: 10px;
  --tile-radius: 14px;
  --dialog-radius: 16px;
  --motion-fast: 160ms cubic-bezier(0.22, 1, 0.36, 1);
  --motion-panel: 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

[data-theme="light"] {
  --app-canvas: #ececef;
  --sidebar: #f4f4f6;
  --surface: #ffffff;
  --surface-raised: #fafafb;
  --separator: rgb(0 0 0 / 9%);
  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;
  --accent: #007aff;
}
```

Map existing Tailwind theme aliases (`ink`, `panel`, `chrome`, `raised`, `line`, `paper`, `mute`) to these semantic tokens so current component classes migrate safely. Rebuild base controls to exact 28px/32px heights, visible focus rings, hierarchy-specific radii, and restrained hover fills. Add a reduced-motion block that sets transition and animation durations to `0.01ms` and removes transforms.

Add the missing icons using the existing `Svg` wrapper and shared 1.5px rounded-stroke object. Keep provider logos in their uniform 24px optical container. Update `StatusBadge` so every color state has visible text and an `aria-label`.

Implement `statusPresentation(status)` as a total switch returning the four literal objects asserted above, and make `StatusBadge` consume it. CSS and SVG rendering are verified by TypeScript/Vite compilation and the real visual acceptance in Task 8; they do not receive source-text change-detector tests.

- [ ] **Step 4: Run contract tests, the complete Node suite, lint, and build**

Run: `node --experimental-strip-types --test tests/statusPresentation.test.mjs`

Expected: 1 test passes.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 5: Commit the visual foundation**

```powershell
git add src/lib/statusPresentation.ts tests/statusPresentation.test.mjs src/index.css src/components/AppIcons.tsx src/components/ProviderIcon.tsx src/components/StatusBadge.tsx
git commit -m "feat(ui): establish quiet native design system"
```

---

### Task 3: Native shell, sidebar, and project toolbar

**Files:**
- Create: `src/lib/chromePresentation.ts`
- Create: `tests/chromePresentation.test.mjs`
- Modify: `src/lib/preferences.ts`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TopBar.tsx`
- Modify: `src/hooks/useAppShortcuts.ts`

**Interfaces:**
- Consumes: Task 2 surface/control/icon contracts.
- Produces: `SHELL_LIMITS`, `toolbarDensityForWidth(width)`, persisted sidebar/browser/Git sizes, and responsive action-label rules.

- [ ] **Step 1: Write failing shell-presentation tests**

```js
// tests/chromePresentation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("uses compact toolbar chrome below the full desktop width", async () => {
  const { toolbarDensityForWidth } = await import("../src/lib/chromePresentation.ts");
  assert.equal(toolbarDensityForWidth(900), "compact");
  assert.equal(toolbarDensityForWidth(1099), "compact");
  assert.equal(toolbarDensityForWidth(1100), "comfortable");
});

test("publishes pixel-safe shell limits", async () => {
  const { SHELL_LIMITS } = await import("../src/lib/chromePresentation.ts");
  assert.deepEqual(SHELL_LIMITS.sidebar, { default: "228px", min: "196px", max: "300px" });
  assert.deepEqual(SHELL_LIMITS.browser, { default: "30%", min: "320px", max: "48%" });
  assert.deepEqual(SHELL_LIMITS.git, { default: "34%", min: "220px", max: "68%" });
});
```

- [ ] **Step 2: Run the tests and verify the helper is missing**

Run: `node --experimental-strip-types --test tests/chromePresentation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement shell dimensions and responsive chrome**

```ts
// src/lib/chromePresentation.ts
export type ToolbarDensity = "compact" | "comfortable";

export const SHELL_LIMITS = {
  sidebar: { default: "228px", min: "196px", max: "300px" },
  browser: { default: "30%", min: "320px", max: "48%" },
  git: { default: "34%", min: "220px", max: "68%" },
} as const;

export function toolbarDensityForWidth(width: number): ToolbarDensity {
  return width < 1100 ? "compact" : "comfortable";
}
```

Use pixel constraints on the sidebar `Panel`, percentage/pixel constraints on inspectors, and `resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}` on each `Group`. Preserve the current `onLayoutChanged` persistence path and safely clamp legacy stored percentages before applying them.

Restructure `Sidebar` into visually distinct navigation, project, agents, and utility regions. Remove the decorative `BETA` badge from the primary identity row. Keep project branch and clean/dirty state together. Use `aria-current="page"` for navigation and listbox/option semantics for agents.

Restructure `TopBar` so project/branch context is left aligned, layout presets form one segmented control, and actions are ordered Terminal, Agent, Browser, Changes. At compact density, hide text spans with CSS while retaining icons, `aria-label`, shortcut labels, and tooltips.

- [ ] **Step 4: Verify responsive contracts and compile**

Run: `node --experimental-strip-types --test tests/chromePresentation.test.mjs`

Expected: 2 tests pass.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 5: Commit the shell redesign**

```powershell
git add src/lib/chromePresentation.ts tests/chromePresentation.test.mjs src/lib/preferences.ts src/components/AppShell.tsx src/components/Sidebar.tsx src/components/TopBar.tsx src/hooks/useAppShortcuts.ts
git commit -m "feat(ui): redesign native workspace chrome"
```

---

### Task 4: Focused three-step setup experience

**Files:**
- Create: `src/components/setup/setupModel.ts`
- Create: `src/components/setup/SetupProjectStep.tsx`
- Create: `src/components/setup/SetupAgentsStep.tsx`
- Create: `src/components/setup/SetupReviewStep.tsx`
- Create: `tests/setupModel.test.mjs`
- Modify: `src/components/SetupWizard.tsx`

**Interfaces:**
- Produces: `AgentDraft`, `clampAgentCount(count)`, `plannedAgentCount(rows)`, and `expandLaunchPlan(rows)`.
- Step components receive values and callbacks; they do not read global stores directly.
- `SetupWizard` remains the only setup component that reads project/agent/UI stores and performs launch side effects.

- [ ] **Step 1: Write failing setup-model tests**

```js
// tests/setupModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("clamps agent quantities and totals the launch plan", async () => {
  const { clampAgentCount, plannedAgentCount } = await import("../src/components/setup/setupModel.ts");
  assert.equal(clampAgentCount(-2), 1);
  assert.equal(clampAgentCount(3), 3);
  assert.equal(clampAgentCount(12), 6);
  assert.equal(plannedAgentCount([{ count: 2 }, { count: 3 }]), 5);
});

test("expands rows into stable user-facing agent names", async () => {
  const { expandLaunchPlan } = await import("../src/components/setup/setupModel.ts");
  assert.deepEqual(
    expandLaunchPlan([{ id: "a", provider: "codex", role: "Reviewer", count: 2, useWorktree: true }]),
    [
      { provider: "codex", name: "Reviewer 1", useWorktree: true },
      { provider: "codex", name: "Reviewer 2", useWorktree: true },
    ],
  );
});
```

- [ ] **Step 2: Run the test and verify the setup model is missing**

Run: `node --experimental-strip-types --test tests/setupModel.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extract setup state and render three quiet task-focused steps**

Implement `setupModel.ts` with a per-row maximum of 6 and deterministic name expansion. Move current project controls into `SetupProjectStep`, provider picker/reorder/count controls into `SetupAgentsStep`, and launch summary/progress/errors into `SetupReviewStep`.

```ts
export interface AgentDraft {
  id: string;
  provider: AgentProviderId;
  role: string;
  count: number;
  useWorktree: boolean;
}

export function expandLaunchPlan(rows: AgentDraft[]) {
  return rows.flatMap((row) =>
    Array.from({ length: clampAgentCount(row.count) }, (_, index) => ({
      provider: row.provider,
      name: row.count > 1 ? `${row.role.trim() || row.provider} ${index + 1}` : row.role.trim() || row.provider,
      useWorktree: row.useWorktree,
    })),
  );
}
```

Remove the current promotional right rail and feature cards. Replace it with an optional live summary of selected project and planned agents at wide widths; stack it below the main step at narrow widths. Keep one primary button per step. Show unavailable CLIs inline with a Rescan action. During launch, show one row per planned agent with waiting, starting, running, or failed text; keep successful launches if another row fails and provide Retry failed agents.

- [ ] **Step 4: Verify model behavior and setup compilation**

Run: `node --experimental-strip-types --test tests/setupModel.test.mjs`

Expected: 2 tests pass.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 5: Commit the setup redesign**

```powershell
git add src/components/setup src/components/SetupWizard.tsx tests/setupModel.test.mjs
git commit -m "feat(ui): simplify workspace setup flow"
```

---

### Task 5: Agent workspace and terminal tile polish

**Files:**
- Modify: `src/stores/paneTree.ts`
- Modify: `src/stores/layoutStore.ts`
- Modify: `src/lib/workspaceLayout.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/PaneTreeView.tsx`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/terminal/registry.ts`
- Modify: `tests/terminalSessions.test.mjs`

**Interfaces:**
- Consumes: existing `PaneNode`, `arrangeLeaves`, persisted split sizes, and terminal registry lifecycle.
- Produces: deterministic one-pane, two-column, and four-pane 2×2 arrangements with readable minimum dimensions.

- [ ] **Step 1: Add failing 2×2 and minimum-size tests**

Add to `tests/terminalSessions.test.mjs`:

```js
test("arranges four terminals as two columns with two rows", async () => {
  const { arrangeLeaves, collectLeaves } = await import("../src/stores/paneTree.ts");
  const leaves = ["a", "b", "c", "d"].map((id) => ({ id, terminalId: `t-${id}` }));
  const grid = arrangeLeaves(leaves, "grid");
  assert.equal(grid.direction, "horizontal");
  assert.equal(grid.first.direction, "vertical");
  assert.equal(grid.second.direction, "vertical");
  assert.deepEqual(collectLeaves(grid).map((leaf) => leaf.terminalId), ["t-a", "t-c", "t-b", "t-d"]);
});

test("publishes readable terminal minimums", async () => {
  const { TERMINAL_MINIMUM } = await import("../src/lib/workspaceLayout.ts");
  assert.deepEqual(TERMINAL_MINIMUM, { width: 360, height: 220 });
});
```

- [ ] **Step 2: Run the focused tests and verify the new expectations fail**

Run: `node --experimental-strip-types --test tests/terminalSessions.test.mjs`

Expected: FAIL on missing `TERMINAL_MINIMUM` or incorrect grid nesting/order.

- [ ] **Step 3: Implement deterministic layout and native terminal tiles**

Export `TERMINAL_MINIMUM = { width: 360, height: 220 } as const` from `workspaceLayout.ts`. Make the grid preset split even/odd leaves into left/right vertical stacks so four panes are visibly 2×2. Preserve explicit user resize values until a preset is selected.

Give `PaneTreeView` separators an 8px invisible hit region, keyboard separator semantics from `react-resizable-panels`, and pixel minimums derived from terminal count. Allow workspace scrolling only when 360×220 minimums cannot fit.

Rebuild `TerminalPane` header with provider icon, name, role/provider subtitle, text status, and icon actions. Keep the existing 2px provider top accent. Starting state overlays a small local progress row without replacing the terminal canvas. Error state contains exact Retry and Details actions. Keep the canvas dark and preserve xterm’s ANSI palette in both themes.

- [ ] **Step 4: Run focused and full runtime checks**

Run: `node --experimental-strip-types --test tests/terminalSessions.test.mjs`

Expected: all tests in the file pass.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`

Expected: all PTY, agent, Git, and command tests pass.

- [ ] **Step 5: Commit the workspace redesign**

```powershell
git add src/stores/paneTree.ts src/stores/layoutStore.ts src/lib/workspaceLayout.ts src/components/Workspace.tsx src/components/PaneTreeView.tsx src/components/TerminalPane.tsx src/terminal/registry.ts tests/terminalSessions.test.mjs
git commit -m "feat(ui): polish agent terminal workspace"
```

---

### Task 6: Persistent right-side browser inspector

**Files:**
- Create: `src/lib/browserNavigation.ts`
- Create: `tests/browserNavigation.test.mjs`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/components/BrowserPanel.tsx`
- Modify: `src/components/AppShell.tsx`

**Interfaces:**
- Produces: `normalizeBrowserInput(value)`, `pushBrowserHistory(history, index, url)`, and browser-session URL state in `uiStore`.
- Consumes: native Tauri child WebView lifecycle and shell inspector bounds.

- [ ] **Step 1: Write failing browser navigation tests**

```js
// tests/browserNavigation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("normalizes browser input into navigable URLs", async () => {
  const { normalizeBrowserInput } = await import("../src/lib/browserNavigation.ts");
  assert.equal(normalizeBrowserInput("github.com/openai"), "https://github.com/openai");
  assert.equal(normalizeBrowserInput("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeBrowserInput("   "), null);
});

test("drops forward history when navigating after Back", async () => {
  const { pushBrowserHistory } = await import("../src/lib/browserNavigation.ts");
  assert.deepEqual(pushBrowserHistory(["https://a.test", "https://b.test"], 0, "https://c.test"), {
    history: ["https://a.test", "https://c.test"],
    index: 1,
  });
});
```

- [ ] **Step 2: Run the test and verify the browser helper is missing**

Run: `node --experimental-strip-types --test tests/browserNavigation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement navigation helpers and inspector persistence**

Use the platform `URL` constructor in `normalizeBrowserInput`; allow only `http:` and `https:`. Move browser URL persistence for the current app session into `uiStore` as `browserUrl` and `setBrowserUrl(url)`. Initialize `BrowserPanel` history from that value and update it after successful navigation so closing/reopening the inspector restores the address.

Keep the native child WebView path, requestAnimationFrame-throttled bounds updates, cleanup of `ResizeObserver` and window listeners, and iframe fallback. Render a quiet empty state with starter destinations. On navigation failure, show “This page could not open inside Taxzy” with Retry and Open externally actions.

- [ ] **Step 4: Verify navigation and WebView compilation**

Run: `node --experimental-strip-types --test tests/browserNavigation.test.mjs`

Expected: 2 tests pass.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 5: Commit the browser inspector**

```powershell
git add src/lib/browserNavigation.ts tests/browserNavigation.test.mjs src/stores/uiStore.ts src/components/BrowserPanel.tsx src/components/AppShell.tsx
git commit -m "feat(ui): refine browser inspector experience"
```

---

### Task 7: Git review, dialogs, and failure-state hierarchy

**Files:**
- Create: `src/lib/dialogBehavior.ts`
- Create: `src/lib/gitPresentation.ts`
- Create: `tests/presentationBehavior.test.mjs`
- Modify: `src/components/GitReviewPanel.tsx`
- Modify: `src/components/DiffViewer.tsx`
- Modify: `src/components/Modal.tsx`
- Modify: `src/components/AddAgentDialog.tsx`
- Modify: `src/components/CommitDialog.tsx`
- Modify: `src/components/MergeDialog.tsx`
- Modify: `src/components/DiscardDialog.tsx`
- Modify: `src/components/PathDialog.tsx`
- Modify: `src/components/HelpDialog.tsx`
- Modify: `tests/perfUsability.test.mjs`

**Interfaces:**
- Consumes: Task 2 dialog/control/banner contracts and existing Git store actions.
- Produces: consistent dialog title/description/content/action structure and readable Git review at narrow heights.
- Produces: `canDismissDialog({ dismissible, busy })` and `changedFileLabel({ status, path })`.

- [ ] **Step 1: Write failing dialog and Git presentation tests**

```js
// tests/presentationBehavior.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

test("prevents incidental dismissal while a dialog is busy", async () => {
  const { canDismissDialog } = await import("../src/lib/dialogBehavior.ts");
  assert.equal(canDismissDialog({ dismissible: true, busy: false }), true);
  assert.equal(canDismissDialog({ dismissible: true, busy: true }), false);
  assert.equal(canDismissDialog({ dismissible: false, busy: false }), false);
});

test("describes changed files without relying on status color", async () => {
  const { changedFileLabel } = await import("../src/lib/gitPresentation.ts");
  assert.equal(changedFileLabel({ status: "M", path: "src/App.tsx" }), "Modified: src/App.tsx");
  assert.equal(changedFileLabel({ status: "A", path: "README.md" }), "Added: README.md");
  assert.equal(changedFileLabel({ status: "?", path: "notes.txt" }), "Untracked: notes.txt");
});
```

- [ ] **Step 2: Run focused tests and verify both helpers are missing**

Run: `node --experimental-strip-types --test tests/presentationBehavior.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dialogBehavior.ts` or `gitPresentation.ts`.

- [ ] **Step 3: Implement native dialog and Git review hierarchy**

Extend `ModalProps` with `description?: string` and `dismissible?: boolean`. Render the description below the title, connect it with `aria-describedby`, and mark the footer container with `data-dialog-actions`. Escape and backdrop close only when `dismissible !== false`; focus trapping and restoration remain unchanged.

Implement `canDismissDialog({ dismissible, busy })` as `dismissible && !busy` and use it for Escape, backdrop, and close-button behavior. Implement `changedFileLabel` with explicit `M`, `A`, `D`, `R`, and `?` mappings plus a `Changed` fallback; `GitReviewPanel` uses the returned label for each file option.

Update each dialog to provide explicit descriptions and action labels: “Add agent,” “Commit changes,” “Merge branch,” “Discard changes,” and “Open project.” Busy destructive dialogs pass `dismissible={false}`. Put validation beside its field and operation failures above the action row.

In `GitReviewPanel`, keep branch, count, and additions/deletions in the left header group; order actions Refresh, Commit changes, Merge branch, Discard. Give each changed-file status an accessible label such as `Modified: src/App.tsx`. Keep status letters visible. At widths below 980px, reduce the changed-file rail from 260px to 210px without hiding filenames. Preserve diff windowing and code typography.

- [ ] **Step 4: Run focused, frontend, and Rust checks**

Run: `node --experimental-strip-types --test tests/presentationBehavior.test.mjs tests/perfUsability.test.mjs`

Expected: all tests in both files pass.

Run: `npm test`

Expected: all Node tests pass.

Run: `npm run lint`

Expected: exit 0.

Run: `npm run build`

Expected: TypeScript and Vite complete successfully.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: exit 0.

- [ ] **Step 5: Commit inspector and dialog polish**

```powershell
git add src/lib/dialogBehavior.ts src/lib/gitPresentation.ts tests/presentationBehavior.test.mjs src/components/GitReviewPanel.tsx src/components/DiffViewer.tsx src/components/Modal.tsx src/components/AddAgentDialog.tsx src/components/CommitDialog.tsx src/components/MergeDialog.tsx src/components/DiscardDialog.tsx src/components/PathDialog.tsx src/components/HelpDialog.tsx tests/perfUsability.test.mjs
git commit -m "feat(ui): unify review and dialog interactions"
```

---

### Task 8: Cross-screen accessibility, responsive, and runtime acceptance

**Files:**
- Modify only if a concrete failing acceptance check identifies a regression in a file from Tasks 1–7.

**Interfaces:**
- Consumes: every UI contract produced by Tasks 1–7 and every acceptance criterion in the design spec.
- Produces: verified setup, shell, terminal grid, browser inspector, Git review, dialogs, keyboard behavior, and both themes.

- [ ] **Step 1: Run the complete automated verification set**

Run each command separately so failures remain attributable:

```powershell
npm test
npm run lint
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
git diff --check
```

Expected: every command exits 0. Vite’s existing chunk-size advisory is acceptable; TypeScript, ESLint, Node tests, Rust checks, Rust tests, or whitespace errors are not.

- [ ] **Step 2: Start the real desktop app**

Run: `npm run tauri dev`

Expected: the Tauri window opens, the setup flow renders instead of a black screen, and the Rust process reports no panic.

- [ ] **Step 3: Verify required window sizes and themes**

At 900×600, 1280×720, and 1600×1000, inspect System, Light, and Dark modes. Confirm:

- no clipped buttons, double borders, white WebView flashes, or mismatched hard-coded surfaces;
- sidebar stays between 196px and 300px;
- toolbar actions remain keyboard reachable when text labels collapse;
- focus rings are visible in both themes;
- setup summary stacks instead of squeezing its form;
- reduced-motion removes transforms and decorative animation.

If one check fails, stop acceptance, add a focused regression test that reproduces that exact failure, patch the owning component, rerun its focused test, and repeat Steps 1–3.

- [ ] **Step 4: Verify complete user flows**

In the Tauri app:

1. Choose a Git folder, scan tools, configure at least two provider rows with quantities totaling four, and review the launch plan.
2. Start four agents and confirm four terminal tiles form a resizable 2×2 layout with ANSI colors.
3. Focus each terminal, split one pane, use Focus/Grid/Even presets, and close the added pane.
4. Open the browser inspector, navigate to a local page and a public documentation page, resize it, close it, reopen it, and confirm the last address remains.
5. Open Git review, select changed files, inspect a diff, open and cancel Commit/Merge/Discard dialogs, and confirm terminal state remains intact.
6. Navigate every primary control by keyboard, open and close each dialog with expected focus restoration, and verify status text remains understandable without color.

Expected: every flow completes without blank surfaces, lost terminal sessions, trapped focus outside a dialog, or unexplained errors.

- [ ] **Step 5: Review the final diff and commit only acceptance fixes**

Run: `git status --short`

Expected: only intentional files from this plan are changed; pre-existing unrelated user changes remain preserved.

If acceptance produced code changes, stage the exact affected files and commit:

```powershell
git commit -m "fix(ui): resolve quiet native acceptance findings"
```

If acceptance produced no code changes, do not create an empty commit.
