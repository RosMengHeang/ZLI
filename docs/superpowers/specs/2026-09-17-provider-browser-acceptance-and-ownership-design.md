# Provider Browser Acceptance and Ownership Design

## Goal

Make ZLI prove, per managed agent, that its provider reached a usable prompt and successfully controlled that agent's own built-in browser pane. Prevent an agent from listing, reusing, binding, or controlling panes owned by another agent or by the user.

## Scope

This phase covers two connected capabilities:

1. End-to-end provider Browser Use evidence from launch binding through a completed browser command.
2. Strict per-agent ownership for browser open requests, surfaces, listing, reuse, binding, and command authorization.

It does not add more browser commands, redesign the browser UI, install missing provider CLIs, or automate third-party login and update dialogs.

## Architecture

### Ownership propagation

The authenticated `CallerIdentity.agent_id` is the source of truth. `browser.open` passes that identity to `BrowserManager::open_and_wait`. The manager stores the expected project, optional agent, and requested URL in its open ticket. `BrowserExecutor::request_open` emits the same optional agent ID to the desktop UI.

The frontend carries the agent ID through `BrowserOpenRequestPayload`, `pendingOpen`, and `BrowserRequest`. `BrowserPanel` registers the WebView surface with that ID. User-created navigation remains unowned with `agentId: null`.

An open ticket can bind only to a surface with the expected project and owner. Redirects may change the URL, so URL equality is not a binding requirement. Agent-owned open requests reuse only surfaces owned by the same agent. User-owned requests reuse only unowned surfaces.

### Authorization policy

An authenticated agent may see and operate only surfaces whose `agent_id` exactly matches its own ID. It may not use an unowned user pane. A trusted UI or local operator identity without an agent ID may inspect project surfaces so the desktop can display and manage them.

This rule applies consistently in `list`, `authorize`, and open reuse. Capability checks remain unchanged and still run after ownership checks.

### Acceptance evidence

`TeamCoordinator` keeps bounded, non-secret runtime evidence per active agent:

- provider prompt observed;
- browser surface created for that agent;
- browser command completed;
- most recent browser command failure text, bounded to the existing event payload limit.

The existing browser capability response exposes a derived integration phase:

- `unavailable`: sidecars or binding are unavailable;
- `configured`: MCP or shell binding exists, but no provider prompt was observed;
- `prompt_ready`: provider prompt evidence exists;
- `browser_opened`: an owned browser surface was created;
- `verified`: an owned browser command completed;
- `failed`: the latest browser command failed after binding.

Events already flow through the shared event observer into `TeamCoordinator::handle_event`, so no second event bus is introduced. Evidence is removed when the agent exits or is stopped.

### Provider behavior

ZLI will not automatically answer provider update, login, trust, or first-run dialogs. Those screens are provider-owned and may require user consent. Instead, the acceptance phase remains `configured`, while queue readiness remains unknown. This keeps diagnosis truthful.

Claude Code and Codex continue using MCP launch bindings. Cursor Agent, OpenCode, Gemini, and fallback providers keep their existing binding recipes. The same acceptance evidence model applies regardless of binding mode.

## Error handling

- A mismatched open ticket returns `BROWSER_SURFACE_FORBIDDEN` and remains unbound until rejected or timed out.
- Agent listing silently excludes foreign and unowned panes.
- Agent commands against foreign or unowned panes return `BROWSER_SURFACE_FORBIDDEN` before capability checks.
- Browser failures update acceptance evidence but do not expose credentials, command parameters, or page content.
- Missing providers remain a provider installation error, not a Browser Use failure.

## Verification

Automated tests must prove:

1. An agent cannot list or control another agent's pane or an unowned pane.
2. Open requests preserve owner identity from authenticated backend call to frontend registration.
3. A ticket cannot bind to the wrong project or agent.
4. Redirected URLs still bind when project and owner match.
5. Acceptance phase advances only from actual events and resets on agent cleanup.
6. Existing project-level UI behavior remains available to a trusted non-agent identity.
7. JavaScript tests, Rust tests, production build, and MCP tool listing remain green.

Live acceptance is reported separately for each installed provider. “Configured” is never reported as “verified.”
