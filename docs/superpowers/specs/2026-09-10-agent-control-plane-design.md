# ZLI Agent Control Plane and Durable Workspace Design

Date: 2026-09-10
Status: Proposed
Scope: agent attention, autonomous teams, durable sessions, browser automation, and the `zli` command/API

## Summary

ZLI will add a Rust-owned control plane that coordinates agents, PTYs, worktrees, TaxChat, browser surfaces, persistence, and external commands. The React/Tauri interface remains a client of this control plane. Features communicate through versioned domain events and commands rather than importing one another's stores or reaching into UI internals.

The design favors a hybrid runtime. ZLI's Tauri process owns the visible application, while a small runtime supervisor owns agent processes and reconnectable PTY sessions. On Windows, the UI and CLI communicate with the supervisor over an authenticated named pipe. The transport is abstracted so a Unix domain socket can be added later without changing the command model.

The parent agent may create child agents automatically, subject to the project limit of 12 agents and configured resource budgets. Destructive Git operations, browser credential access, downloads, and privileged commands remain explicitly gated.

## Goals

1. Show reliable agent attention states: Working, Waiting for you, Completed, Failed, Paused, and Offline.
2. Allow a parent agent to spawn, message, inspect, focus, pause, and stop child agents.
3. Persist projects, layouts, terminal scrollback, browser state, TaxChat messages, and provider resume descriptors.
4. Reconnect to live agent sessions after the UI restarts when the supervisor is still running.
5. Restore provider conversations when the provider exposes a durable session identifier.
6. Give agents a safe, versioned `zli` CLI and JSON-RPC API.
7. Let agents inspect and control an explicitly authorized browser surface.
8. Keep provider-specific behavior behind adapters that can be added without changing core orchestration.
9. Preserve existing worktree isolation, Git review, TaxChat, two-column layout, and Windows support.

## Non-goals

1. Replacing the existing Tauri UI with a new framework.
2. Supporting every provider's private session database.
3. Exposing an unauthenticated HTTP server.
4. Allowing agents to delete worktrees or access user credentials without an explicit capability.
5. Making the browser a general-purpose remote browser service.
6. Recreating arbitrary tmux behavior. ZLI exposes a narrower, typed agent-control API.
7. Adding remote machines or mobile clients in this milestone.

## Product decisions

### Autonomous team creation

A parent agent can create children without asking the user for each child. ZLI enforces:

- A hard maximum of 12 agents per project.
- A configurable maximum of 12 agents globally for the initial release.
- A per-parent child limit derived from the remaining project capacity.
- A resource budget for concurrent PTYs and browser surfaces.
- A stable parent-child relationship in the workspace tree.

Autonomous creation does not grant destructive privileges. Spawn, send, read, focus, and stop are separate capabilities from discard-worktree, browser-storage, download, and arbitrary-command capabilities.

### Status and attention are separate

Execution describes process reality. Attention describes what the user should do. Unread describes whether the user has seen an event. These values must not be collapsed into one enum.

```ts
type ExecutionStatus =
  | "starting"
  | "running"
  | "paused"
  | "exited"
  | "error"
  | "stopped";

type AttentionStatus =
  | "working"
  | "waiting_for_you"
  | "completed"
  | "failed"
  | "paused"
  | "offline";
```

### Event-based detection

ZLI will not call an LLM to classify terminal output. Attention detection uses PTY lifecycle events, provider hooks, explicit CLI events, TaxChat messages, and conservative provider-aware output parsers. This keeps state changes fast, deterministic, testable, and free of classification-token cost.

### Durable resume honesty

ZLI restores the exact provider conversation only when the provider adapter can identify and resume it. Otherwise ZLI restores the project, worktree, layout, and terminal snapshot and clearly reports that provider resume is unavailable.

## Architecture

```text
                 React/Tauri UI
                       |
                 UI command client
                       |
       +---------------+----------------+
       |                                |
  Tauri command bridge             Named pipe API
       |                                |
       +---------------+----------------+
                       |
                Control Plane
       +-----------+----+----+-----------+
       |           |         |           |
  Agent Runtime  Event Hub  Browser   Persistence
       |           |         |           |
       |       Attention   WebView2   Session store
       |       TaxChat     bridge     Event journal
       |
  Supervisor-owned PTYs and provider adapters
       |
  Claude, Codex, Cursor, OpenCode, shell, future providers
```

### Layer boundaries

#### Domain layer

Location: `src-tauri/src/control/domain/` and mirrored frontend types in `src/types/control/`.

Owns identifiers, status enums, commands, events, capability names, validation rules, and protocol versions. It must not import Tauri, React, xterm, WebView2, or provider-specific code.

#### Runtime layer

Location: `src-tauri/src/control/runtime/`.

Owns PTY sessions, process lifecycle, provider launch, child spawning, command routing, event ordering, and supervisor reconnect. It can depend on domain contracts and provider interfaces, but not on UI state.

#### Provider adapter layer

Location: `src-tauri/src/agents/providers/`.

Each provider adapter owns detection, launch arguments, environment setup, output markers, optional hook setup, and resume command construction. The core runtime sees only the `ProviderAdapter` trait.

#### Git/worktree layer

Location: existing `src-tauri/src/git/` plus a small control-plane adapter.

The existing Git module remains the owner of Git operations. The control plane asks it to create, inspect, merge, discard, or recover worktrees through typed functions. It must not shell out to Git from UI code.

#### Browser layer

Location: `src-tauri/src/control/browser/` and `src/lib/browser/`.

The Rust side owns browser command authorization, request tracking, timeouts, and protocol responses. The frontend side owns the actual Tauri WebView2 surface and executes approved DOM operations on the UI thread.

#### Persistence layer

Location: `src-tauri/src/control/persistence/` and existing frontend workspace registry migration code.

The backend owns durable runtime records. The frontend may cache a read model for rendering but must not be the source of truth for live agent state.

#### Presentation layer

Location: existing `src/components/`, `src/stores/`, and new control-plane hooks.

The UI subscribes to events and renders a read model. Components dispatch commands through a typed client. Components must not invoke provider commands, mutate PTY state directly, or parse raw terminal output.

## Core contracts

### Agent record

```ts
interface AgentRecord {
  id: string;
  projectId: string;
  parentAgentId: string | null;
  providerId: string;
  terminalId: string | null;
  worktreePath: string | null;
  branch: string | null;
  executionStatus: ExecutionStatus;
  attentionStatus: AttentionStatus;
  unread: boolean;
  unreadCount: number;
  lastEventAt: string;
  resume: ResumeDescriptor | null;
  capabilities: Capability[];
  createdAt: string;
  updatedAt: string;
}
```

### Resume descriptor

```ts
interface ResumeDescriptor {
  providerId: string;
  providerSessionId: string | null;
  resumeCommandKind: string | null;
  workingDirectory: string;
  lastCheckpointAt: string | null;
  availability: "available" | "unsupported" | "unknown";
}
```

The descriptor never stores API keys, passwords, cookies, or raw secret environment values.

### Agent event envelope

```ts
interface AgentEventEnvelope<T = unknown> {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  projectId: string;
  agentId: string | null;
  parentAgentId: string | null;
  timestamp: string;
  source: "runtime" | "provider" | "pty" | "taxchat" | "browser" | "user" | "api";
  kind: AgentEventKind;
  payload: T;
}
```

Initial event kinds:

```text
agent.created
agent.started
agent.output
agent.prompt_detected
agent.waiting
agent.message_received
agent.message_delivered
agent.completed
agent.failed
agent.paused
agent.stopped
agent.exited
agent.resume_available
agent.resume_unavailable
agent.worktree_created
agent.worktree_cleanup_failed
browser.surface_created
browser.navigation_changed
browser.console_error
browser.command_failed
taxchat.room_started
taxchat.message_sent
taxchat.message_failed
```

Events are append-only and ordered per runtime. Consumers must tolerate duplicate delivery and out-of-order events after reconnect by using `sequence` and `eventId`.

### Commands

Commands are request/response operations. Events are notifications. A command must not require a UI component to be mounted.

```ts
type ControlCommand =
  | "workspace.list"
  | "workspace.open"
  | "agent.list"
  | "agent.spawn"
  | "agent.send"
  | "agent.read"
  | "agent.focus"
  | "agent.pause"
  | "agent.stop"
  | "attention.list"
  | "attention.ack"
  | "session.list"
  | "session.resume"
  | "browser.list"
  | "browser.open"
  | "browser.navigate"
  | "browser.wait"
  | "browser.snapshot"
  | "browser.click"
  | "browser.fill"
  | "browser.press"
  | "browser.eval"
  | "browser.console"
  | "browser.errors"
  | "browser.screenshot"
  | "taxchat.send";
```

Every request includes a request ID, protocol version, caller identity, timeout, and capability context. Mutating commands should be idempotent where possible.

## Agent runtime and team orchestration

### Runtime supervisor

The supervisor owns the PTY and child process handles. It exposes a reconnectable session registry. The Tauri window can disconnect without stopping a session. The supervisor can run in one of two modes:

1. Attached mode during development and normal short sessions.
2. Detached mode for sessions marked to survive UI close or restart.

The initial implementation should use one reusable runtime binary or sidecar with a versioned local protocol. Do not duplicate process ownership between the Tauri process and the supervisor.

### Spawn flow

```text
parent agent calls zli agent spawn
  -> authenticate scoped parent token
  -> validate project and provider
  -> enforce 12-agent cap and resource budget
  -> create worktree through Git module
  -> create child AgentRecord
  -> launch provider adapter in worktree
  -> attach PTY and event stream
  -> add child pane to layout
  -> send task message
  -> emit agent.started
```

If a later step fails, the runtime performs compensating cleanup in reverse order. For example, a failed provider launch stops the PTY and removes the newly-created clean worktree. If cleanup fails, the record is retained with `agent.worktree_cleanup_failed` so it is visible in Storage Manager.

### Parent-child communication

Agent messages use the same command and event path as user messages. TaxChat remains the conversation view and transcript, but delivery is handled by the runtime message service rather than by direct terminal injection from a React store.

```ts
interface AgentMessage {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  createdAt: string;
  status: "queued" | "delivered" | "failed";
  correlationId: string | null;
}
```

Messages are delivered to the target PTY only after authorization and target liveness checks. The transcript records delivery success or failure. The system does not silently retry a message that may contain a destructive command.

### Resource protection

- Hard project limit: 12 agents.
- Output backpressure with bounded per-agent buffers.
- Coalesce high-frequency output events for the UI while preserving terminal bytes in the PTY path.
- Per-agent event rate limits for API clients.
- Optional idle hibernation later, after restore semantics are stable.
- Never create a worktree until the agent slot and provider are validated.

## Attention system

### Detection pipeline

```text
PTY lifecycle/output
provider hook event
explicit zli attention command
TaxChat delivery
        ↓
Attention detector
        ↓
normalized AgentEvent
        ↓
Attention reducer
        ↓
AgentRecord + notification queue
        ↓
UI badges, notification panel, optional Windows toast
```

The detector uses confidence levels internally:

- Explicit provider hook: high.
- Process exit code: high.
- TaxChat delivery: high.
- Provider-specific prompt marker: medium.
- Generic output heuristic: low and debounced.

Low-confidence output must not repeatedly flip an agent between Working and Waiting for you. A minimum quiet period and state hysteresis will prevent notification storms.

### Read behavior

Acknowledging an attention item clears `unread` but does not change `attentionStatus`. Opening an agent pane acknowledges only that agent. Opening the notification center does not acknowledge every item unless the user chooses “mark all read”.

### Notification policy

Desktop notifications are opt-in and suppressed when the relevant project is focused. The in-app notification center is always available. Notifications include project, agent, provider, state, and a short sanitized message.

## Session persistence and resume

### State ownership

The supervisor owns live state. The persistence layer owns checkpoints. The UI owns only transient view state such as current selection.

Persist:

- Project and agent records.
- Parent-child relationships.
- Worktree and branch metadata.
- Pane tree and split sizes.
- Terminal dimensions and bounded scrollback snapshot.
- Browser surface URL, tabs, and profile identifier.
- TaxChat room and message transcript.
- Provider resume descriptor.
- Last attention state and unread state.

Do not persist:

- API keys or passwords.
- Full environment variables.
- Unbounded terminal history.
- Browser cookies unless the user explicitly enables a persistent profile.

### Restore flow

```text
Tauri starts
  -> connect to supervisor
  -> load versioned project snapshot
  -> reconcile live session IDs
  -> rebuild pane tree
  -> restore browser surfaces
  -> request bounded scrollback
  -> resume supported provider sessions
  -> mark unsupported sessions as Resume unavailable
  -> replay events after last acknowledged sequence
```

The restore operation is idempotent. A crash during restore must not create duplicate agents or worktrees.

### Provider resume adapters

```rust
trait ProviderAdapter {
    fn id(&self) -> &str;
    fn detect_installation(&self) -> ProviderDetection;
    fn build_launch(&self, request: LaunchRequest) -> Result<LaunchPlan>;
    fn parse_event(&self, chunk: &str) -> Vec<ProviderEvent>;
    fn detect_resume(&self, chunk: &str) -> Option<ResumeDescriptor>;
    fn build_resume(&self, descriptor: &ResumeDescriptor) -> Result<Option<LaunchPlan>>;
}
```

Providers that cannot resume still implement the trait and return `None`. The runtime then restores the worktree and launches a fresh session only when the user or configured policy permits it.

## Browser automation

### Surface ownership

Each browser surface belongs to a project and optionally an agent. Browser state is not global. The existing browser panel remains responsible for positioning and rendering the Tauri WebView2 child window.

The control plane owns:

- Surface identity.
- Project and agent ownership.
- Capability checks.
- Request IDs and timeouts.
- Output-size limits.
- Navigation and console event normalization.

The frontend bridge owns:

- Executing JavaScript against the WebView2 surface.
- Returning DOM snapshots and screenshots.
- Reporting page navigation and console events.
- Rejecting commands when the surface is closed.

### Browser command flow

```text
agent calls zli browser snapshot
  -> named pipe request
  -> capability check
  -> BrowserManager validates surface
  -> Tauri event to BrowserPanel bridge
  -> WebView2 evaluates bounded script
  -> result returns with request ID
  -> agent receives structured response
```

Initial supported operations:

- Open and navigate.
- Wait for URL, text, selector, or load state.
- DOM snapshot and bounded text extraction.
- Click, fill, press, hover, and scroll.
- JavaScript evaluation behind a separate capability.
- Console and page error retrieval.
- Screenshot capture.

### Browser security

Capabilities:

```text
browser.read
browser.interact
browser.javascript
browser.storage
browser.download
```

Defaults:

- `browser.read` may be enabled per project.
- `browser.interact` requires an explicit project setting.
- `browser.javascript`, `browser.storage`, and `browser.download` are disabled by default.
- Agent browser requests cannot access another project's surface.
- Browser output is truncated to a configured size.
- Every command has a deadline.
- Persistent profiles are opt-in; the default profile is isolated and disposable.

## Public `zli` API

### Transport

Windows uses a named pipe restricted to the current user. The transport interface is abstract:

```rust
trait ControlTransport {
    async fn serve(&self, handler: Arc<dyn ControlHandler>) -> Result<()>;
    async fn connect(&self) -> Result<Box<dyn ControlClient>>;
}
```

Future Unix support can provide a Unix domain socket without changing commands or events.

The API is not bound to localhost TCP by default. This avoids accidental LAN exposure and firewall prompts.

### Identity and capabilities

ZLI injects scoped environment variables into managed agents:

```text
ZLI_PROJECT_ID
ZLI_AGENT_ID
ZLI_PARENT_AGENT_ID
ZLI_CONTROL_ENDPOINT
ZLI_CONTROL_TOKEN
```

Tokens are short-lived, scoped to the agent and stored only in the supervisor. A parent token can spawn and message children, but cannot automatically discard worktrees or read browser storage.

### CLI surface

Human-readable commands:

```text
zli status
zli agents
zli attention
zli agent spawn --provider codex --task "Review the API"
zli agent send <agent-id> "Run the focused tests"
zli agent read <agent-id>
zli agent focus <agent-id>
zli session resume <agent-id>
zli browser snapshot --surface <surface-id>
zli taxchat send <agent-id> "Please compare the two approaches"
```

Every command supports `--json`. The machine-facing protocol is versioned independently from human-readable text output.

## Persistence format and migrations

Use versioned records under the application data directory, not inside project repositories:

```text
app-data/
  control/
    schema-version.json
    projects/
      <project-id>/
        project.json
        agents.json
        layout.json
        taxchat.json
        events.ndjson
        browser.json
        scrollback/
```

Rules:

- Write snapshots atomically through a temporary file and rename.
- Keep event journals bounded and rotate them.
- Migrate schema versions before constructing runtime records.
- Preserve unknown fields during migrations where safe.
- Never silently delete a record because a provider or worktree is missing.
- Reconcile missing worktrees through the existing Storage Manager flow.

## Error handling

Errors use stable codes and human-readable details:

```text
AGENT_LIMIT_REACHED
PROVIDER_NOT_INSTALLED
PROVIDER_RESUME_UNSUPPORTED
PARENT_AGENT_NOT_FOUND
CAPABILITY_DENIED
WORKTREE_CREATE_FAILED
WORKTREE_CLEANUP_FAILED
SESSION_NOT_FOUND
BROWSER_SURFACE_NOT_FOUND
BROWSER_PERMISSION_REQUIRED
BROWSER_COMMAND_TIMEOUT
CONTROL_PROTOCOL_MISMATCH
```

Partial team creation returns per-agent results. A successful child must remain visible even if a later child fails. A failed launch must not leave an invisible PTY or untracked worktree.

Supervisor recovery must reconcile:

- Runtime sessions without records.
- Records without live sessions.
- Worktrees without active agents.
- Browser surfaces without an owning project.
- Duplicate event delivery after reconnect.

## Maintainability rules

1. Domain contracts are versioned and reviewed before implementation changes.
2. Provider adapters implement interfaces; the runtime never branches on provider names except through the registry.
3. UI stores consume read models and dispatch commands; they do not own process state.
4. Browser commands never execute arbitrary JavaScript without the browser JavaScript capability.
5. Git/worktree operations remain in the Git module.
6. New features add a command/event pair and a module boundary instead of reaching into an existing store.
7. Every new event has a reducer test and a reconnect/idempotency test.
8. Every new provider has detection, launch, parser, and resume tests, even when resume is unsupported.
9. Every external command has a timeout, bounded output, authorization check, and stable error code.
10. Keep UI-specific and runtime-specific types separate even when their fields currently match.

## Proposed source layout

```text
src-tauri/src/control/
  mod.rs
  domain.rs
  errors.rs
  commands.rs
  events.rs
  event_hub.rs
  attention.rs
  runtime.rs
  supervisor.rs
  messages.rs
  persistence.rs
  transport/
    mod.rs
    named_pipe.rs
  browser/
    mod.rs
  security/
    mod.rs
src-tauri/src/agents/providers/
  mod.rs
  registry.rs
  claude_code.rs
  codex.rs
  cursor.rs
  opencode.rs
src/control/
  client.ts
  protocol.ts
  events.ts
  selectors.ts
  reducers.ts
  browserBridge.ts
src/stores/
  controlStore.ts
  attentionStore.ts
  sessionStore.ts
  taxChatStore.ts
```

The existing agent, PTY, Git, workspace, and browser modules should be migrated behind these boundaries incrementally. A migration is complete only when one owner exists for each responsibility.

## Implementation phases

### Phase 1: Contracts and event hub

- Add domain IDs, statuses, commands, event envelopes, stable error codes, and capability names.
- Adapt existing PTY output/status events into normalized agent events.
- Add an in-process event hub with sequence numbers.
- Add frontend read-model reducers.

Exit criteria: existing agent launch, stop, TaxChat and layout behavior still pass; event reducer tests cover all status transitions.

### Phase 2: Attention and notifications

- Add attention detector and debounce rules.
- Add sidebar status, unread badges and notification center.
- Add attention acknowledge/focus commands.
- Add optional Windows notification integration.

Exit criteria: completed, failed and waiting agents are distinguishable without opening every terminal; no notification storm under repeated output.

### Phase 3: Persistence and session checkpointing

- Move live agent records to backend-owned snapshots.
- Persist layout, bounded scrollback, browser state and TaxChat transcript.
- Add schema versioning and atomic writes.
- Add provider resume adapter interface.

Exit criteria: closing and reopening the UI restores the project tree, agent rows, layout, browser URL, TaxChat history and available resume descriptors.

### Phase 4: Runtime supervisor

- Move PTY ownership behind the reconnectable runtime interface.
- Add detached session mode.
- Add reconciliation for orphaned processes and worktrees.
- Add reconnect sequence replay.

Exit criteria: selected sessions continue after the UI restarts and do not create duplicate terminals or agent records.

### Phase 5: Named-pipe API and CLI

- Implement versioned JSON-RPC over the Windows named pipe.
- Add scoped agent tokens and capability checks.
- Add the `zli` CLI with human and JSON output.
- Add command documentation and protocol contract tests.

Exit criteria: a managed agent can list itself, send a message, report attention, and read a bounded result through `zli`.

### Phase 6: Autonomous agent teams

- Add `agent.spawn` and parent-child relationships.
- Connect child creation to worktree manager and two-column layout.
- Route messages through TaxChat and the runtime.
- Enforce the 12-agent and resource limits.

Exit criteria: a parent can create multiple children, each gets a visible terminal and isolated worktree, messages are delivered and recorded, and partial failures clean up correctly.

### Phase 7: Browser control

- Add BrowserManager and frontend WebView2 bridge.
- Add read-only snapshot, URL, console and error commands.
- Add interaction commands behind capability checks.
- Add isolated project profiles and browser session persistence.

Exit criteria: an authorized agent can verify a local web app through DOM snapshots and interactions, while unauthorized storage, download and JavaScript operations fail with stable errors.

## Verification strategy

### Unit tests

- Attention state transition table.
- Unread acknowledgement behavior.
- Event sequence deduplication.
- Command validation and capability checks.
- Agent-limit and resource-budget enforcement.
- Provider parser and resume adapter behavior.
- Browser selector and output-size validation.

### Integration tests

- Spawn, message, stop and cleanup for each supported provider mock.
- Parent-child team creation with one intentional partial failure.
- Worktree cleanup failure and Storage Manager recovery.
- Supervisor disconnect and reconnect.
- Snapshot migration from each existing workspace schema.
- Named-pipe authentication and token scope.
- Browser bridge against a local deterministic test page.

### Manual acceptance tests

1. Start one agent and confirm Working.
2. Make it wait for input and confirm Waiting for you plus unread badge.
3. Complete it and confirm Completed.
4. Fail it and confirm Failed.
5. Spawn children automatically and confirm parent-child sidebar nesting.
6. Send messages in both directions and confirm TaxChat transcript and delivery status.
7. Close and reopen ZLI and verify layout, browser URL, scrollback and resume behavior.
8. Use the CLI to list agents, send a message, acknowledge attention and request a browser snapshot.
9. Attempt an unauthorized browser storage or destructive Git operation and confirm denial.
10. Repeatedly start and stop agents and verify no leaked PTYs, panes, worktrees or records.

## Risks and mitigations

### RAM and process growth

Mitigation: hard agent cap, bounded output buffers, supervisor metrics, explicit stop cleanup, and a later hibernation feature based on durable resume.

### Provider differences

Mitigation: adapter interface, honest unsupported resume state, provider contract tests, and no provider-specific branches in the UI.

### Browser security

Mitigation: per-agent capabilities, isolated profiles, no storage/download access by default, output limits, timeouts, and same-project surface checks.

### Runtime complexity

Mitigation: one event hub, one command router, one owner for process state, stable protocol versions, and incremental migration phases.

### Worktree data loss

Mitigation: never auto-discard dirty worktrees, retain cleanup failures for Storage Manager, and provide explicit recovery actions.

## Success criteria

ZLI is successful when a user can open a project, start a group of agents, leave them working, receive one clear notification when an agent needs attention, let a parent agent create and message teammates, reopen ZLI without losing workspace context, and ask an authorized agent to verify a web change in the embedded browser. The workflow must remain understandable without requiring users to know tmux, provider-specific session internals, or local IPC details.
