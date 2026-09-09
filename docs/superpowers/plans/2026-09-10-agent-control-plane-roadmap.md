# ZLI Agent Control Plane Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved ZLI control plane as four independently testable subsystems with stable contracts and incremental commits.

**Architecture:** Build a normalized event and attention foundation first. Add durable runtime ownership and restore next. Add the local API and autonomous teams after the runtime exists. Add browser automation last because it crosses the UI thread and requires explicit permissions.

**Tech Stack:** Rust 2021, Tauri 2, `portable-pty`, React 19, TypeScript 6, Zustand 5, WebView2, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- Hard project limit: 12 agents.
- Parent agents may spawn automatically within the limit.
- Status, attention, and unread state remain separate.
- The backend owns live runtime state.
- The frontend is a read-model client.
- Local control uses authenticated same-user IPC, not an unauthenticated TCP server.
- Browser storage, downloads, arbitrary JavaScript, and destructive Git actions require separate capabilities.
- Existing provider IDs, worktree isolation, TaxChat, two-column layout, and Windows support remain compatible.

## Execution order

### Wave 1: Event and attention foundation

Plan: `docs/superpowers/plans/2026-09-10-agent-attention-events.md`

Produces the shared event envelope, event hub, deterministic attention reducer, unread badges, and notification center. This is the foundation consumed by every later plan.

### Wave 2: Durable sessions and runtime ownership

Plan: `docs/superpowers/plans/2026-09-10-durable-sessions-supervisor.md`

Depends on Wave 1. Produces versioned snapshots, provider adapters, reconnectable PTY sessions, supervisor reconciliation, and frontend restore states.

### Wave 3: API and autonomous teams

Plan: `docs/superpowers/plans/2026-09-10-zli-api-autonomous-teams.md`

Depends on Waves 1 and 2. Produces the versioned command protocol, capability-scoped named pipe, human/JSON `zli` CLI, autonomous parent-child spawning, and TaxChat delivery through the runtime.

### Wave 4: Browser automation

Plan: `docs/superpowers/plans/2026-09-10-browser-automation.md`

Depends on Waves 1 and 3. Produces project-owned browser surfaces, permission checks, WebView2 bridge, DOM interaction, console/error inspection, screenshots, and safe browser persistence.

## Cross-plan integration checkpoints

- [ ] After Wave 1, existing launch, stop, terminal rendering, TaxChat, Git, and layout tests pass.
- [ ] After Wave 2, reopening the UI restores project state without duplicate agents or worktrees.
- [ ] After Wave 3, a managed agent can call `zli status`, `zli agent send`, `zli agent spawn`, and `zli attention` through the local API.
- [ ] After Wave 4, an authorized agent can inspect and interact with a local browser preview while unauthorized storage and download operations fail.
- [ ] Before release, run frontend tests, frontend lint/build, Rust tests, Rust check, and the manual acceptance matrix in the specification.

## Commit and review policy

Each task ends with a focused commit. Do not combine provider adapter work, UI redesign, browser security, and supervisor changes in one commit. Review each wave at its checkpoint before starting the next wave. If a task exposes a new cross-boundary requirement, update the specification and affected plan before writing implementation code.

## Release slices

1. Attention slice: observable agent states and unread navigation.
2. Resume slice: durable project state and reconnectable sessions.
3. Team slice: API-driven child agents and message delivery.
4. Browser slice: authorized agent verification of web applications.

Each slice is useful by itself and can be disabled independently through its capability or feature configuration without removing the other slices.
