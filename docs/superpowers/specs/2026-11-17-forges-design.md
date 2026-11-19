# Forges: GitHub, GitLab and Gitea in ZLI

Date: 2026-11-17 · Branch: `feat/source-control`

## Intent

ZLI's pull requests only work on GitHub today. People whose code lives on GitLab, a self-hosted GitLab, Gitea,
Forgejo or Codeberg can't open, merge or review a pull request without leaving the app. ZLI gets a layer that finds
the host from the project's Git remote and drives that host's own CLI, called **Forges** (the standard name for
platforms like GitHub, GitLab and Gitea).

It is for ZLI's users in general, not one team's server, so the main forges get the same depth.

## Goals

1. ZLI knows each project's forge from its Git remotes, including self-hosted servers, with no setup.
2. **Settings → Forges** shows, for each forge, whether its CLI is installed, its version, and which servers it is
   signed in to, with the command to install or sign in, and **Rescan**.
3. The Review pane's pull request flow (status, push, create, merge, comment, checks, review threads) works on
   GitHub, GitLab and Gitea/Forgejo, each through its own CLI. GitLab's are called **merge requests** in the UI.
4. **Clone** a repository from a forge when adding a project, and **Publish** a local repository to a forge.

## Non-goals

- Bitbucket and Azure DevOps. They come after, through the same driver shape (Bitbucket needs a stored token, since
  it has no CLI).
- Saving forge tokens in ZLI. Sign-in stays in each CLI (`gh auth login`, `glab auth login`, `tea login add`).
- Gitea/Forgejo issues in the Issues panel (GitHub and GitLab issues keep working as they do).
- Installing CLIs for the person.

## Anti-goals

- A project on a forge whose CLI is missing must never show a broken or half-working pull request card. It says
  what to install, in one line, and the rest of the Review pane works.
- No regressions for GitHub users: today's GitHub flow, and the mobile app that calls the same `review.pr.*`
  commands, keep working unchanged.

## Constraints

- Every CLI runs without a shell through the existing `ProcessRunner` (`spawnCli`), with timeouts, secrets redacted
  from errors.
- Contract changes are **additive only**: the mobile app may run an older build than the desktop.
- Only `gh` is installed on the dev machine. `glab` and `tea` drivers are tested against recorded CLI output with a
  fake runner; a manual check on real servers happens before release.
- Minimum CLI versions: `gh` 2.40+, `glab` 1.40+, `tea` 0.9+ (the first with the JSON output used). A too-old CLI is
  shown as "Update needed", like a missing one.

## Approaches

- **A. One forge layer, pull requests on every forge (picked).** Each forge is a driver with the same shape:
  detect, status, and the pull request actions. Today's GitHub code becomes the GitHub driver. Biggest change, but it
  is the only one that gives GitLab and Gitea users pull requests inside ZLI, which is the point.
- **B. Detection and status only.** Quick, but GitLab and Gitea users still can't open a pull request in ZLI.
- **C. Call forge web APIs with saved tokens.** No CLIs needed, but the person asked for CLI detection, and it means
  storing secrets. Kept only as the later path for Bitbucket.

## Design

### Forge kinds

| Kind | Forges | CLI | Sign-in command | Hosts it knows |
|------|--------|-----|-----------------|----------------|
| `github` | github.com, GitHub Enterprise | `gh` | `gh auth login` | `hosts.yml` (already read by `readGhHosts`) |
| `gitlab` | gitlab.com, self-hosted GitLab | `glab` | `glab auth login` | `config.yml` (already read by `readGlabHosts`) |
| `gitea` | Gitea, Forgejo, Codeberg | `tea` | `tea login add` | `tea`'s `config.yml` logins (new reader) |

Forgejo and Codeberg speak the Gitea API, so `tea` covers them. `codeberg.org` is a well-known `gitea` host.

### Detection

`apps/server/src/issues/remotes.ts` becomes `apps/server/src/forges/remotes.ts` and grows the `gitea` kind:
well-known hosts first (github.com, gitlab.com, codeberg.org), then the hosts each CLI is signed in to. A remote
whose host no CLI knows is `unknown`; the Review pane then offers push and "Open on website" only. The Issues code
imports the moved module.

### Drivers

```ts
interface ForgeDriver {
  kind: "github" | "gitlab" | "gitea";
  label: string;                // "GitHub"
  requestNoun: "pull request" | "merge request";
  cli: "gh" | "glab" | "tea";
  status(): Promise<ForgeStatus>;           // installed, version, signed-in hosts and accounts
  capabilities: ForgeCapabilities;           // what the UI may offer on this forge
  view(cwd, branchOrUrl): Promise<PullRequestInfo | undefined>;
  create(cwd, request): Promise<PullRequestInfo>;
  merge(cwd, request): Promise<void>;
  comment(cwd, text): Promise<void>;
  // Optional, per capabilities: checks, checkLog, reviewThreads, reply, resolve, review, autoMerge.
  clone(url, dir): Promise<void>;
  publish(cwd, request): Promise<{ url: string }>;
}
```

- `gh` keeps today's commands. `glab` uses `glab mr view/create/merge/note --output json`; `tea` uses
  `tea pulls list/create/merge --output json` and `tea comment`.
- Capabilities, so the UI never shows a button the forge can't do: GitHub has everything ZLI has today. GitLab has
  checks (pipelines), review threads (discussions), approve and auto-merge ("merge when pipeline succeeds"). Gitea has
  create, view, merge, comment; checks and threads only where `tea` exposes them.
- `PullRequestService` keeps its Git work (branches, push, fetch, pull) and asks the project's driver for the forge
  part. Its GitHub-specific strings ("GitHub CLI is not signed in") come from the driver.

### Contracts (additive)

- `PullRequestStatusResult` gains `forge?: { kind, label, requestNoun, host?, capabilities }`.
- `PullRequestProblem.code` gains `cli_missing`, `cli_unauthenticated`, `cli_outdated`, `cli_failed`, `unknown_forge`.
  GitHub keeps returning the old `gh_*` codes, so an older mobile app still reads them.
- New commands: `forges.status` (all drivers, cached until **Rescan**), `forges.rescan`, `project.clone`
  (url or `owner/repo`, forge, folder), `project.publish` (worktree, forge, owner, name, private).

### Settings → Forges

A page in the Projects group. One row per forge:

```
Forges
Forges are where your repositories live. ZLI uses each forge's own CLI, signed in with your account.

[GH] GitHub        gh 2.98.0 · Signed in to github.com as <account>          [Rescan]
[GL] GitLab        glab not installed · Install glab, then run: glab auth login   [Copy]
[GT] Gitea         tea 0.9.2 · Not signed in · Run: tea login add             [Copy]
```

### Clone and publish

- **Add project → Clone**: paste a clone URL, a forge page URL, or `owner/repo` with a forge picked; choose a folder.
  Cloning runs `git clone` (the forge CLI only resolves `owner/repo` to a URL). Progress shows in a toast; the
  project opens when the clone finishes.
- **Publish**: a project with no remote shows **Publish to…** in the Review pane, picking a forge, owner, name and
  private/public, then runs the CLI's create command, adds `origin` and pushes.

## Order of work

1. Forge layer: move and extend detection, `ForgeDriver`, GitHub driver from today's code with no behaviour change,
   `forges.status`, Settings → Forges.
2. GitLab driver, then Gitea driver, with recorded-output tests; Review pane reads `forge` for labels and capabilities.
3. Clone and publish.

Each step ships green (`pnpm run verify`) and is its own commit.

## Left to the builder

- Exact JSON fields each CLI returns, and the version each needs; the recorded fixtures pin them.
- How long `forges.status` is cached between rescans.
- Icons for each forge row (generic, not brand logos, unless the icon set already has them).
