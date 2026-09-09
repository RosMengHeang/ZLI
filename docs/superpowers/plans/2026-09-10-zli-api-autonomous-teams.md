# ZLI Command API and Autonomous Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a versioned local `zli` command/API and use it to let parent agents spawn, message, inspect, focus, pause, and stop child agents within the 12-agent limit.

**Architecture:** The API is a typed JSON-RPC command router shared by the Tauri client and a Windows named-pipe client. Managed agents receive scoped identity and capability environment variables. A team coordinator turns `agent.spawn` into a worktree, provider launch, pane, event, and TaxChat operation with compensating cleanup on failure.

**Tech Stack:** Rust 2021, Tauri 2, `serde`, `serde_json`, `uuid`, Windows named pipe transport, React 19, TypeScript 6, Zustand 5, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-agent-control-plane-design.md`

## Global Constraints

- Parent agents may spawn automatically, but the project maximum is 12 agents.
- The API is local-only by default and is not an unauthenticated TCP server.
- Spawn, send, read, focus, pause, and stop are separate capabilities.
- Discard worktree, browser storage, downloads, and arbitrary command execution require separate capabilities.
- Every request has a request ID, schema version, timeout, caller identity, and capability context.
- Human CLI output and machine JSON output are both supported.
- Existing Tauri invoke commands remain compatible during migration.

## File map

- Create `src-tauri/src/control/protocol.rs`: JSON-RPC request, response, error, and capability types.
- Create `src-tauri/src/control/router.rs`: command validation, dispatch, timeout, and idempotency.
- Create `src-tauri/src/control/transport/mod.rs`: transport abstraction.
- Create `src-tauri/src/control/transport/named_pipe.rs`: Windows named-pipe server/client.
- Create `src-tauri/src/control/security.rs`: scoped tokens and capability checks.
- Create `src-tauri/src/control/team.rs`: parent-child spawn and message orchestration.
- Create `src-tauri/src/bin/zli.rs`: human and JSON CLI wrapper.
- Modify `src-tauri/Cargo.toml`: add the named-pipe transport dependency and binary configuration.
- Modify `src-tauri/src/control/mod.rs`: register router, security, transport, and team modules.
- Modify `src-tauri/src/lib.rs`: start the local API server and register Tauri command client handlers.
- Modify `src-tauri/src/commands.rs`: expose shared control commands without duplicating business logic.
- Create `src/control/protocol.ts`: frontend request and event types.
- Create `src/control/client.ts`: typed Tauri/named-pipe command client interface.
- Create `src/stores/teamStore.ts`: parent-child read model and spawn state.
- Modify `src/stores/taxChatStore.ts`: use the message service for agent delivery.
- Modify `src/components/Sidebar.tsx`: render nested child agents and team actions.
- Create `src/components/TeamPanel.tsx`: show team tree, message delivery, and spawn activity.
- Create `tests/controlProtocol.test.mjs`, `tests/teamCoordinator.test.mjs`, and Rust control tests.

## Interfaces

```rust
pub trait ControlHandler: Send + Sync {
    fn handle(&self, request: ControlRequest, identity: CallerIdentity)
        -> Result<ControlResponse, ControlError>;
}

pub trait ControlTransport: Send + Sync {
    fn start(&self, handler: Arc<dyn ControlHandler>) -> Result<TransportHandle>;
    fn connect(&self) -> Result<Box<dyn ControlClient>>;
}
```

```ts
export interface ControlRequest<T = unknown> {
  id: string;
  protocolVersion: 1;
  method: ControlMethod;
  params: T;
  timeoutMs: number;
}

export interface ControlResponse<T = unknown> {
  id: string;
  protocolVersion: 1;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}
```

### Task 1: Define the versioned protocol and stable errors

**Files:**
- Create: `src-tauri/src/control/protocol.rs`
- Create: `src/control/protocol.ts`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/controlProtocol.test.mjs`

**Interfaces:**
- Produces `ControlRequest`, `ControlResponse`, `ControlMethod`, `ControlError`, `CallerIdentity`, and `Capability`.
- Consumes event and agent domain types from the event and session plans.

- [ ] **Step 1: Write the failing protocol round-trip test**

```rust
#[test]
fn control_request_round_trips_and_rejects_unknown_protocol_versions() {
    let request = ControlRequest::new("req-1", "agent.list", serde_json::json!({}));
    let json = serde_json::to_string(&request).expect("serialize request");
    let decoded: ControlRequest = serde_json::from_str(&json).expect("decode request");
    assert_eq!(decoded.protocol_version, 1);
    assert!(ControlRequest::from_json(r#"{"protocolVersion":99}"#).is_err());
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::control_request_round_trips`

Expected: FAIL because protocol types are not defined.

- [ ] **Step 3: Implement protocol types and validation**

Use snake-case method names on the wire. Validate nonempty request IDs, protocol version `1`, timeout between `100` and `120000` milliseconds, and only registered methods. Define stable errors `CONTROL_PROTOCOL_MISMATCH`, `CAPABILITY_DENIED`, `AGENT_LIMIT_REACHED`, `SESSION_NOT_FOUND`, `WORKTREE_CREATE_FAILED`, and `PROVIDER_NOT_INSTALLED`.

- [ ] **Step 4: Add the TypeScript decoder**

Implement `decodeControlResponse(value: unknown)` and reject malformed responses. Preserve the server error code and message in a typed `ControlClientError`.

- [ ] **Step 5: Run tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::control_request_round_trips`

Run: `npm test -- --test-name-pattern="control protocol"`

```bash
git add src-tauri/src/control/protocol.rs src-tauri/src/control/tests.rs src/control/protocol.ts tests/controlProtocol.test.mjs
git commit -m "feat: define versioned ZLI control protocol"
```

### Task 2: Implement identity, capabilities, and command routing

**Files:**
- Create: `src-tauri/src/control/security.rs`
- Create: `src-tauri/src/control/router.rs`
- Modify: `src-tauri/src/control/mod.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Consumes protocol types from Task 1 and runtime methods from the session plan.
- Produces `CapabilityTokenStore`, `CommandRouter::dispatch`, `CallerIdentity`, and `IdempotencyCache`.

- [ ] **Step 1: Write capability tests**

```rust
#[test]
fn parent_agent_can_spawn_and_message_but_cannot_discard_worktree() {
    let identity = test_parent_identity();
    assert!(identity.allows(Capability::AgentSpawn));
    assert!(identity.allows(Capability::AgentSend));
    assert!(!identity.allows(Capability::WorktreeDiscard));
}

#[test]
fn duplicate_request_id_returns_the_original_response() {
    let router = test_router();
    let first = router.dispatch(test_request("req-1", "agent.list"), test_identity()).unwrap();
    let second = router.dispatch(test_request("req-1", "agent.list"), test_identity()).unwrap();
    assert_eq!(first, second);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::parent_agent_can_spawn`

Expected: FAIL because identity and router are not defined.

- [ ] **Step 3: Implement scoped identities**

Generate a token per managed agent and store only a hash in memory. The token carries project ID, agent ID, parent ID, expiration, and capabilities. Parse `ZLI_PROJECT_ID`, `ZLI_AGENT_ID`, `ZLI_PARENT_AGENT_ID`, `ZLI_CONTROL_ENDPOINT`, and `ZLI_CONTROL_TOKEN` only at provider launch time.

- [ ] **Step 4: Implement dispatch and idempotency**

The router validates the method, checks capability, enforces project ownership, dispatches to the control handler, applies the request timeout, stores the response by request ID, and returns the stored response for a duplicate request.

- [ ] **Step 5: Run tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::parent_agent_can_spawn`

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::duplicate_request_id`

```bash
git add src-tauri/src/control/security.rs src-tauri/src/control/router.rs src-tauri/src/control/mod.rs src-tauri/src/control/tests.rs
git commit -m "feat: add capability-scoped control routing"
```

### Task 3: Add the Windows named-pipe transport

**Files:**
- Create: `src-tauri/src/control/transport/mod.rs`
- Create: `src-tauri/src/control/transport/named_pipe.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/control/mod.rs`
- Test: `src-tauri/src/control/tests.rs`

**Interfaces:**
- Consumes `ControlRequest` and `ControlResponse` from Task 1 and `CommandRouter` from Task 2.
- Produces `NamedPipeServer`, `NamedPipeClient`, and `ControlTransport`.

- [ ] **Step 1: Write the transport integration test**

```rust
#[test]
fn named_pipe_client_receives_a_json_response_from_the_router() {
    let server = start_test_named_pipe_server(test_router());
    let client = NamedPipeClient::connect(server.endpoint()).expect("connect");
    let response = client.request(test_request("req-1", "agent.list")).expect("response");
    assert!(response.ok);
    server.stop().expect("stop server");
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::named_pipe_client_receives`

Expected: FAIL because the transport is not defined.

- [ ] **Step 3: Add the transport dependency and implementation**

Use one framed JSON request per line for the initial protocol. Restrict the pipe to the current Windows user, reject oversized frames, close idle clients after the request deadline, and return a protocol error for malformed JSON. Keep the `ControlTransport` trait independent of Windows-specific types.

- [ ] **Step 4: Start the server from Tauri**

Start the server once after the supervisor is ready. Store the endpoint in the runtime environment and expose the endpoint only to managed agents and the local CLI.

- [ ] **Step 5: Run checks and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::named_pipe_client_receives`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/control/transport src-tauri/Cargo.toml src-tauri/src/control/mod.rs src-tauri/src/control/tests.rs
git commit -m "feat: add authenticated local control transport"
```

### Task 4: Add the human and JSON `zli` CLI

**Files:**
- Create: `src-tauri/src/bin/zli.rs`
- Modify: `src-tauri/Cargo.toml`
- Create: `src/control/client.ts`
- Test: `tests/controlCli.test.mjs`

**Interfaces:**
- Consumes `NamedPipeClient` and protocol methods from Tasks 1 to 3.
- Produces executable commands `zli status`, `zli agents`, `zli attention`, `zli agent`, `zli session`, `zli browser`, and `zli taxchat`.

- [ ] **Step 1: Write CLI parsing tests**

```js
test("cli maps agent send arguments to a versioned control request", () => {
  const request = parseCli(["agent", "send", "agent-1", "Run", "tests"]);
  assert.deepEqual(request.method, "agent.send");
  assert.equal(request.params.agentId, "agent-1");
  assert.equal(request.params.body, "Run tests");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --test-name-pattern="cli maps agent send"`

Expected: FAIL because the CLI parser is not defined.

- [ ] **Step 3: Implement the CLI wrapper**

Use a small parser with explicit subcommands. Human output prints concise results and stable errors. `--json` prints exactly one JSON response to stdout. Diagnostic logging goes to stderr. Do not expose raw tokens or environment values.

- [ ] **Step 4: Add frontend client**

Implement `ControlClient.request<T>(method, params, options)` and a Tauri implementation that uses the same backend router. The UI must not duplicate API business logic.

- [ ] **Step 5: Run checks and commit**

Run: `npm test -- --test-name-pattern="cli"`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

```bash
git add src-tauri/src/bin/zli.rs src-tauri/Cargo.toml src/control/client.ts tests/controlCli.test.mjs
git commit -m "feat: add versioned zli command client"
```

### Task 5: Implement team spawning and message delivery

**Files:**
- Create: `src-tauri/src/control/team.rs`
- Modify: `src-tauri/src/control/router.rs`
- Modify: `src-tauri/src/stores/taxChatStore.ts`
- Create: `src/stores/teamStore.ts`
- Modify: `src/components/Sidebar.tsx`
- Create: `src/components/TeamPanel.tsx`
- Test: `src-tauri/src/control/tests.rs`
- Test: `tests/teamCoordinator.test.mjs`

**Interfaces:**
- Consumes supervisor, provider registry, Git/worktree commands, event hub, TaxChat transport, and control capabilities.
- Produces `TeamCoordinator::spawn`, `TeamCoordinator::send`, `TeamCoordinator::read`, `TeamCoordinator::focus`, `TeamCoordinator::pause`, and `TeamCoordinator::stop`.

- [ ] **Step 1: Write the failing team spawn test**

```rust
#[test]
fn spawn_creates_a_child_worktree_agent_and_start_event() {
    let coordinator = test_team_coordinator();
    let result = coordinator.spawn(SpawnAgentRequest {
        project_id: "project-1".into(),
        parent_agent_id: Some("parent-1".into()),
        provider_id: "codex".into(),
        task: "Review the API".into(),
    }).expect("spawn child");
    assert_eq!(result.parent_agent_id.as_deref(), Some("parent-1"));
    assert!(result.worktree_path.is_some());
    assert!(coordinator.events().iter().any(|event| event.kind == AgentEventKind::AgentStarted));
}
```

- [ ] **Step 2: Run the test to verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::spawn_creates_a_child`

Expected: FAIL because `TeamCoordinator` is not defined.

- [ ] **Step 3: Implement the spawn transaction**

Validate the caller parent relationship, project capacity, provider installation, and task length. Create the worktree through the Git module, create the child record, mint a scoped token, launch through the provider adapter, attach a PTY, add the pane, emit events, and deliver the task. On failure, stop the child process and remove only the newly-created clean worktree. Retain cleanup failures for Storage Manager.

- [ ] **Step 4: Implement message delivery**

Route `agent.send` through a message service that checks project ownership and target liveness, writes to the target PTY, records TaxChat delivery, and emits `agent.message_delivered` or `agent.message_failed`. Do not retry a message automatically after a target process exits.

- [ ] **Step 5: Implement read, focus, pause, and stop**

`agent.read` returns bounded recent output and current status. `agent.focus` emits a UI focus request. `agent.pause` asks the runtime to stop accepting automated messages while retaining the session. `agent.stop` stops the process but does not discard its worktree.

- [ ] **Step 6: Add the team read model and UI**

Render parent-child nesting in the sidebar. `TeamPanel` displays spawn progress, delivery status, and failure details. It must expose keyboard-accessible actions and loading/error states.

- [ ] **Step 7: Run tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml control::tests::spawn_creates_a_child`

Run: `npm test -- --test-name-pattern="team"`

Run: `npm run build`

Run: `npm run lint`

```bash
git add src-tauri/src/control/team.rs src-tauri/src/control/router.rs src/stores/taxChatStore.ts src/stores/teamStore.ts src/components/Sidebar.tsx src/components/TeamPanel.tsx src-tauri/src/control/tests.rs tests/teamCoordinator.test.mjs
git commit -m "feat: add autonomous agent teams"
```

### Task 6: Verify API and team boundaries

**Files:**
- Modify: `tests/controlProtocol.test.mjs`
- Modify: `tests/teamCoordinator.test.mjs`
- Modify: `src-tauri/src/control/tests.rs`
- Modify: `docs/HANDOFF_CODEX.md`

- [ ] **Step 1: Add boundary tests**

Cover malformed protocol, version mismatch, capability denial, cross-project access, duplicate request IDs, named-pipe disconnect, 12-agent limit, partial spawn cleanup, parent-child message delivery, and stable JSON errors.

- [ ] **Step 2: Run the full verification set**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: all checks pass.

- [ ] **Step 3: Document the public contract**

Update `docs/HANDOFF_CODEX.md` with the CLI command list, protocol version, capability model, environment variables, and local transport behavior.

- [ ] **Step 4: Commit**

```bash
git add tests/controlProtocol.test.mjs tests/teamCoordinator.test.mjs src-tauri/src/control/tests.rs docs/HANDOFF_CODEX.md
git commit -m "test: verify ZLI API and team boundaries"
```
