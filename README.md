# ZLI

ZLI is an Electron desktop workspace for coding agents. It provides isolated Git worktrees, persistent terminal sessions, structured Codex sessions, Git review, and a Chromium browser scoped to each worktree.

## Install

Download the installer for your platform from the [latest release](https://github.com/RosMengHeang/ZLI/releases/latest):

- Windows: `ZLI-<version>-win-x64.exe`. The installer is not code signed yet, so Windows SmartScreen may warn about it. Choose **More info**, then **Run anyway**.
- macOS (Apple silicon): `ZLI-<version>-mac-arm64.dmg`. The app is not signed or notarized yet, so the first time you open it, right-click ZLI in Applications, choose **Open**, then confirm **Open**.
- Linux: `ZLI-<version>-linux-x86_64.AppImage`. Make it executable with `chmod +x` and run it.

### Updates

ZLI checks GitHub Releases a few seconds after it starts and every four hours after that. On Windows and Linux (AppImage), it downloads a new version in the background and shows **Restart to update** in the title bar; the update is also installed the next time you quit. If agents are still working when you restart, ZLI asks first. Turn off **Install updates automatically** in **Settings > Updates** to download only when you choose to. After an update, ZLI shows what changed.

On macOS, ZLI tells you when a new version is out and opens the release page for you to download it, because macOS only lets signed apps update themselves. **Help and diagnostics** and **Settings > Updates** show the running version and let you check by hand.

## Requirements

- Node.js 24
- Corepack with pnpm 10.14.0
- Git

Enable pnpm and install the workspace dependencies:

```sh
corepack enable
pnpm --dir v2 install --frozen-lockfile
```

## Run and verify

The root scripts forward to the pnpm workspace in [`v2/`](v2/):

```sh
npm run dev
npm run verify
npm run build
npm run desktop:dir
npm run desktop:pack
```

`npm run dev` builds and starts the Electron desktop. `npm run verify` checks import boundaries, formatting, lint, unit tests, and types. `npm run desktop:dir` creates an unpacked application for local testing, and `npm run desktop:pack` creates a platform installer.

The packaged Electron journeys run only when `ZLI_RUN_E2E` is set.

Bash:

```sh
ZLI_RUN_E2E=1 npm run e2e
```

PowerShell:

```powershell
$env:ZLI_RUN_E2E = "1"
npm run e2e
```

On Linux without a display, run the journeys under `xvfb-run -a`.

## Releases

Every merge to `main` publishes a new patch release. The [Release workflow](.github/workflows/release.yml) works out the next version from the highest `vX.Y.Z` tag (the first release is `v0.1.0`), tags the merge commit, and creates a draft GitHub release with generated notes. Windows, macOS, and Linux builds then upload their installers and update files (`latest*.yml`, `.blockmap`) into the draft, and the workflow publishes it once every file is there. The `package.json` files on `main` stay at `0.0.0`; the build jobs write the release version into them.

- A push is not released when every file changed since the last release is Markdown or under a `docs/` folder, or when its head commit message contains `[skip release]`.
- For a minor or major release, run the **Release** workflow from the Actions tab and pick the bump.
- Releases run one at a time, so two quick merges never get the same version.

To build installers locally without publishing, use `npm run desktop:pack`.

## Architecture and attribution

The application lives in [`v2/`](v2/). It uses an Electron shell, a typed renderer/runtime boundary, a durable local server, and a detached workspace daemon for terminal ownership. Its worktree, provider, browser, and recovery boundaries are informed by the pinned T3 Code and Orca references listed in [`v2/UPSTREAM_SOURCES.md`](v2/UPSTREAM_SOURCES.md). Third-party license information is in [`v2/THIRD_PARTY_NOTICES.md`](v2/THIRD_PARTY_NOTICES.md).
