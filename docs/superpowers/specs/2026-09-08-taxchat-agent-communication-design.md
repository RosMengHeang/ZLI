# TaxChat Agent Communication Design

**Status:** Approved design
**Date:** 2026-09-08

## Summary

TaxChat is a local shared communication room for the agents running in Taxzy. The user can send a request to every selected agent or a subset of agents, see meaningful routed messages in one transcript, and let agents communicate with one another when they need to collaborate. Each agent keeps its existing terminal session and raw output remains visible in the terminal grid.

The first implementation uses the existing local PTY sessions as the transport. TaxChat adds a local coordinator, a structured message protocol, per-agent input queues, and a dedicated resizable pane beside the terminal grid.

## Goals

- Let the user communicate with multiple running local CLI agents from one shared room.
- Let agents send explicit requests or findings to other agents when collaboration is useful.
- Keep all selected agents' terminal sessions visible and usable.
- Preserve complete raw output in each terminal while showing only meaningful routed messages in TaxChat.
- Support multiple back-and-forth messages through smart rounds rather than a single exchange.
- Keep communication local and provider-agnostic across the supported CLI tools.
- Make pause, continue, and stop behavior predictable and safe.

## Non-goals

- Replacing the existing terminal sessions or agent launch flow.
- Adding provider-specific API integrations, cloud orchestration, or new authentication.
- Automatically interpreting every line of terminal output as a chat response.
- Hiding or rewriting raw terminal output.
- Making browser behavior part of the TaxChat feature.

## Product experience

### Placement

TaxChat appears as a dedicated, resizable pane beside the terminal grid. The terminal grid remains visible while TaxChat is open. Users can resize or collapse the pane to give the terminals more room.

### Header

The header contains:

- The product feature name: `TaxChat`.
- Participant chips for the selected agents.
- The current room state: `Ready`, `Running`, `Paused`, `Idle`, or `Stopped`.
- Controls for `Start`, `Pause`, `Continue`, and `Stop`.
- A settings affordance for collaboration limits and participant selection.
- A local-only indicator.

### Transcript

The transcript is a chronological shared view. Messages are visually distinguished by type:

- User messages.
- Agent messages.
- Agent-to-agent requests and replies.
- Delivery and routing events.
- System, warning, and error events.

Agent messages show the provider, agent name, recipient(s), timestamp, and delivery state. Raw output that does not match the TaxChat protocol remains in its original terminal only.

### Composer

The composer provides a text input, a recipient selector with `All selected agents` and individual agents, and a `Send` action. Sending adds the user message to the shared transcript and queues a tagged copy for each chosen participant.

## Collaboration model

### Smart rounds

TaxChat uses smart rounds. A round stays active while agents are producing valid TaxChat messages or while work is still being delivered. Agents may communicate multiple times when they need to; the system does not impose a single reply per agent.

A round becomes idle after a quiet period with no new routed messages. The user can start another round with `Continue` without clearing the transcript or restarting terminals.

The coordinator must enforce bounded safety limits so an accidental loop cannot run forever. The initial implementation should expose these as settings with conservative defaults:

- Inactivity timeout: 45 seconds.
- Maximum routed messages per agent per round: 8.
- Maximum routed messages across the room per round: 64.

When a limit is reached, TaxChat pauses routing, records a system event explaining why, and leaves the terminals running.

### Room lifecycle

1. `Ready`: agents exist but TaxChat has not started routing.
2. `Running`: messages are being delivered and parsed.
3. `Idle`: the round ended because the room became quiet.
4. `Paused`: routing is suspended by the user or a safety limit.
5. `Stopped`: routing is ended for the current room; terminal sessions remain available.

`Start` begins the first round. `Pause` prevents new deliveries but does not kill processes. `Continue` resumes or begins another round. `Stop` disables TaxChat routing and clears pending deliveries while preserving the transcript and terminals.

## Local message protocol

Agents receive a provider-agnostic instruction explaining that they can communicate through explicit TaxChat blocks. The coordinator recognizes only complete blocks in PTY output after ANSI/control-sequence cleanup.

The initial protocol is:

```text
[[TAXCHAT:to=agent-id]]
Message for another Taxzy agent.
[[/TAXCHAT]]
```

Supported recipients are an individual agent ID, `all`, or `user`. A message addressed to `user` is shown in the TaxChat transcript as an agent update. A message addressed to another agent is added to the transcript and queued for that recipient. A message addressed to `all` is queued for all available participants except the sender.

Protocol requirements:

- Agent IDs must be stable for the lifetime of the running session.
- Parsing must support PTY chunks that split a marker across multiple output events.
- ANSI escape sequences must not prevent a valid block from being recognized.
- Unrecognized or malformed text must never be routed automatically.
- Parsed protocol blocks should be represented in the transcript while the original output remains in the terminal.
- The coordinator should include the latest relevant TaxChat context in the delivery prompt so an agent understands the shared conversation.

The protocol is an opt-in capability of the local coordinator. If a provider or agent does not emit valid blocks, its normal terminal interaction still works, but it cannot initiate routed TaxChat messages.

## Runtime architecture

### Coordinator

Add a local TaxChat coordinator in the frontend runtime, integrated with the existing agent and terminal stores. It owns room lifecycle, transcript state, routing, safety limits, and per-agent queues.

### PTY transport

Use each existing `Agent.terminalId` as the transport key:

- User messages are written with the existing `ptyWrite` bridge.
- Parsed PTY output is observed through a raw output event path before or alongside xterm rendering.
- Terminal rendering continues unchanged.
- The coordinator does not create duplicate processes or wrapper shells.

Each agent has a single FIFO delivery queue. A delivery must be serialized per terminal so TaxChat does not interleave multiple prompts into one agent's stdin. Failed writes are recorded as delivery errors and do not block other participants.

### Output handling

The existing PTY bridge must remain the source of truth for terminal rendering. TaxChat consumes a copy of output for protocol parsing and never removes bytes from the terminal stream. Parser state is maintained per agent so partial output chunks can be completed by later PTY events.

### Provider behavior

The coordinator sends the same protocol instructions to all providers. Provider-specific differences are isolated to the existing launch/runtime layer. No provider API or cloud service is required for the first version.

## Data model

The implementation should introduce typed models equivalent to:

```ts
type TaxChatRoomStatus =
  | 'ready'
  | 'running'
  | 'idle'
  | 'paused'
  | 'stopped';

type TaxChatMessageKind =
  | 'user'
  | 'agent'
  | 'delivery'
  | 'system'
  | 'error';

interface TaxChatParticipant {
  agentId: string;
  status: 'available' | 'queued' | 'delivering' | 'unavailable';
  routedCount: number;
}

interface TaxChatMessage {
  id: string;
  senderId: string;
  recipientIds: string[];
  kind: TaxChatMessageKind;
  body: string;
  createdAt: string;
  status: 'pending' | 'delivered' | 'failed' | 'informational';
  round: number;
}

interface TaxChatRoom {
  id: string;
  status: TaxChatRoomStatus;
  participantIds: string[];
  messages: TaxChatMessage[];
  round: number;
}
```

The exact store shape may follow the existing Zustand conventions, but room state and message history must be testable without mounting the UI.

## Failure handling

- If no selected agent is available, TaxChat remains `Ready` and displays an actionable error.
- If an agent exits, its participant status becomes `unavailable`; other agents continue.
- If a PTY write fails, the message is marked `failed` with the affected agent named.
- If a queue exceeds its configured bound, new deliveries for that agent are rejected with a visible system event.
- If the parser sees malformed markers, it leaves the content in the terminal and records no routed message.
- If the room reaches an inactivity or message limit, it pauses safely and explains the reason.
- Stopping TaxChat must not close or kill terminal sessions.

## Privacy and safety

- TaxChat communication uses only the local app and existing local PTY sessions.
- No message is sent to a remote server by the coordinator.
- User messages are delivered only to the recipients selected in the composer.
- Agent-generated routing requires the explicit TaxChat marker protocol.
- Limits and lifecycle controls are visible in the UI so users can understand why routing paused.

## Verification requirements

The implementation should include tests for:

- Protocol parsing across split PTY chunks.
- ANSI/control-sequence cleanup and malformed marker handling.
- Recipient resolution for one agent, `all`, and `user`.
- FIFO queue ordering and per-agent serialization.
- Room lifecycle transitions and smart-round inactivity.
- Per-agent and total message safety limits.
- Agent exit and PTY write failure behavior.
- Store actions independent of the React UI.
- Rendering of user, agent, delivery, system, and error transcript cards.
- Resizing/collapsing the TaxChat pane without hiding the terminal grid.

## Acceptance criteria

1. A user can open TaxChat beside the terminal grid after selecting a repository and launching agents.
2. The user can send one message to all selected agents or selected recipients.
3. Every delivery is visible in the shared transcript and the recipient's terminal remains usable.
4. Agents can emit explicit TaxChat blocks to communicate with other agents.
5. Routed messages appear in the correct recipient queue and in the shared transcript.
6. Multiple agent-to-agent exchanges can occur during one smart round.
7. TaxChat becomes idle or pauses safely instead of looping indefinitely.
8. Pause, Continue, and Stop do not kill the existing terminal sessions.
9. Provider failures and malformed output are visible without blocking healthy agents.
10. All communication remains local and the existing terminal output remains intact.
