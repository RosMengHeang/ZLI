# ZLI interface direction

## Design read

ZLI is a local workspace for developers who run several coding agents at once.
The style is a near-black window with work islands on it, in the manner of a
focused desktop tool. Dials: ENERGY 1,
RHYTHM 2, MOTION 2. The interface stays quiet so agent output, diffs, and
terminal text carry the contrast. Regions are told apart by tone and spacing,
not by lines, so the chrome has very few borders.

## Identity

ZLI is a room for work already in motion, not a marketing page. The repository
is home, agents are the visible workers, and Terminal, Files, Browser, and
Changes are tools on the same work surface. Every number and status on screen
comes from real project, process, or Git state.

## Where the system lives

- `v2/packages/ui/src/tokens.css` holds every color, size, radius, shadow,
  duration, and z-index. Component CSS uses these variables, not raw values.
- `v2/packages/ui/src/primitives.css` styles the shared building blocks:
  buttons, key caps, fields, switches, badges, status dots, segmented
  controls, tooltips, dialogs, pane headers, toolbars, banners, empty states,
  and spinners.
- `v2/apps/web/src/ui` has the React side of those primitives: `Button`,
  `IconButton`, `Kbd`, `Tooltip`, `Dialog`, `Segmented`, `Switch`, `Badge`, `Field`,
  `Select`, `Picker`, `Menu`, `ProviderMark`, `ModelMark`, `PaneHeader`, `EmptyState`, and
  `LoadingState`.
- Each feature keeps its own stylesheet next to its components, for example
  `sidebar/sidebar.css`, `sessions/tile.css`, `chat/chat.css`, and
  `files/files.css`.

New UI should be built from these pieces. If a screen needs something they do
not cover, add it to the primitives instead of styling it locally.

## Palette

- The canvas `#0a0a0b` is the window itself: the sidebar, the top bar, and the
  gutters between work regions all share it, with no border between them.
- Work regions are islands of surface `#141416`: agent tiles, the terminal
  drawer, the side panel, and the empty board. Terminals use the same color
  so output sits on its tile without a seam.
- Raised `#1b1b1e` is for controls, the composer, and dialogs; overlay
  `#1f1f23` is for tooltips, menus, and selected segments. Fields, code, and
  logs sit in a translucent black well so they read as sunken on any surface.
- Islands sit flat. Only popovers, dialogs, and the chat composer cast a
  shadow, and raised surfaces catch a faint top highlight.
- Borders are low-alpha white hairlines at three strengths: resting, strong,
  and hover. Islands use the resting one.
- Text has three readable steps (text, muted, dim). Each one passes WCAG AA
  (4.5:1) on every surface, including the overlay. The disabled color is only
  for disabled controls and decorative glyphs.
- There is one accent, blue `oklch(.571 .21 264)`. It marks primary actions,
  keyboard focus, and the selected agent, and nothing else. Selected
  segments use a neutral raised fill, and selected choice cards get an accent
  edge, not a blue panel.
- Green, amber, and red mean process or Git state: running or ready, working
  or modified, failed or deleted. They are not decoration.

## Typography

- Inter and JetBrains Mono ship with the app as variable fonts
  (`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`),
  so every machine renders the same type. Segoe UI Variable, the system UI
  font, SFMono-Regular, Cascadia Mono, and Consolas remain as fallbacks.
- Monospace is used for paths, branches, diffs, timestamps, and terminal
  output. Code, diffs, the editor, and terminals turn ligatures off so
  operators such as `!=` and `=>` read as typed. The terminal measures its
  cells again once the bundled font has loaded.
- The type scale runs from 10.5px to 20px. Body copy and controls are 13px;
  dense lists and metadata use 11px to 12px. Tabular numbers are used wherever
  counts or sizes line up.

## Spacing and sizing

- Spacing uses a 4px scale with 2px, 6px, and 10px half-steps for dense
  chrome.
- Controls come in four heights: 20, 24, 28, and 32px. The top bar is 44px
  (also the desktop title bar height), pane headers and agent tile headers
  40px, and toolbars 36px.
- Islands are separated by a 6px gutter, which is also where the panel and
  drawer resize handles live. A handle shows a line only while hovered or
  dragged.
- Radii are 4 to 8px on controls, 12px on islands, and 16px on dialogs and
  the composer. Pills are only for counts and the send button.

## Composition

- In the desktop app the renderer draws the title bar. The native title bar
  and menu row are hidden; Windows and Linux keep native window controls
  through the title bar overlay, and macOS keeps its traffic lights. The top
  bar and the sidebar's top row drag the window, and the top bar pads its
  right edge so the window controls never cover the search trigger.
- The left sidebar is the home for projects, agents, and worktrees.
  Collapsing it removes it completely so the workbench gets the full width.
  It is 256px wide, 236px under 1240px, and 216px under 1080px. Add project
  (folder with a plus) and New agent (pen on a square) are plain rows at the
  top, in that order; the New agent shortcut appears
  when the row is hovered or focused. The footer
  holds the runtime status, Usage, Settings, and Help.
- A project's name folds its agents and worktrees away, with a chevron that
  shows on hover or while folded. A folded project shows its agent count,
  in blue or amber when an agent there is working or waiting. The project
  row also holds Create worktree (a branch icon) and New agent here (a
  plus), both shown on hover.
- Worktrees have no section of their own. An agent in a worktree shows the
  branch on a second line under its title, with commits to push or pull,
  the pull request and its checks, the setup or worktree status when it is
  not plain Ready, and the changed file count. When that worktree failed or
  needs setup approval, the fix (Retry, Review setup, Setup output) shows
  under the first agent in it.
- Worktrees no agent runs in fold into one "N worktrees without agents"
  row under the agents. It starts folded, but still lists the worktree in
  view and any that is being created, failed, or waiting on the person.
  Folded projects and opened worktree rows are remembered across restarts.
- Agent and worktree rows have no floating buttons. Each has one "..."
  menu at its end, in the spot of its time or status, shown while the row
  is pointed at or focused. An agent's menu has Stop agent, Copy branch
  name, and Delete agent. A worktree's menu has its setup and retry fixes,
  Cancel while it is being created, and Delete worktree (or Forget
  checkout, which never touches disk), which asks once in the row. A
  checkout stuck in Queued can still be forgotten.
- Agent rows are indented under their project, with the provider mark and
  the title. The selected agent gets a fill, not a stripe.
  The right side shows the status while the agent is starting, working,
  waiting, or failed; otherwise it says Background for an agent without a
  tile, or how recently the agent was active. The branch and worktree path
  are also in the row's tooltip and the tile header.
- The top bar has the breadcrumb (project, then branch in mono) on the left,
  then icon-only panel toggles with Terminal split from Files, Browser, and
  Changes, then the command palette trigger. Each toggle's name is its
  accessible label and its tooltip says what it will do and shows its
  shortcut.
- The center is a grid of agent tiles. Columns follow the agent count (one,
  two, three, then four) but drop before a tile would fall under 380px, so a
  narrow grid stacks agents into rows of at least 260px and scrolls past
  that. Each tile switches between the agent's terminal and a chat view, can
  be maximized, and docks a restart bar when its process ends.
- A tile header shows the bare provider mark, the title, the branch in mono,
  and the status, then the view switch and the window actions. The header and
  the body share one surface with no rule between them. The active tile gets
  an accent edge because that is where typing goes.
- The first tile action is Environment (a monitor). It opens a small dark
  popover under the button: where the agent works (Local or Worktree, with
  the end of the path in mono), Changes with the +/− line totals (opens the
  Changes panel), the branch (opens Branches), then one Git action. With
  uncommitted changes that is a commit message field and Commit and push, or
  Commit when the repository has no origin; with commits waiting it is Push;
  otherwise it stays disabled and says why. A folder without Git shows only
  where the agent works.
- A chat tile also has New chat (pen on a square, Mod+Shift+O), a menu with
  Blank chat and Start with recent context, which brings the end of the
  current chat along as a file. The current chat stops and stays in Chat
  history (a clock), shown once the tile has more than one chat, newest
  first with its age and status. A stopped chat the agent can pick up again
  keeps its composer, and the next message resumes it.
- In chats, user messages are right-aligned bubbles,
  replies are plain text in a centered column, and the log fades out above
  the composer. Tiles under 520px use smaller gutters and 13px text.
- The composer footer holds attach, window capture, and saved prompts, then
  the Model and Permissions pickers. Both open a dark popover list instead of
  a native select, whose option list follows the system's light theme. Each
  model shows its maker's logo in the list and in the closed chip; the default or an unknown model shows a neutral chip glyph.
- Permissions have three levels, from least to most an agent may do alone:
  Read only (eye), Auto (shield with a check), and Full access (shield with an
  alert). Each option carries a one-line description, and the chip stays
  neutral because the mode is a choice, not a process state. Agents that keep
  one mode for the whole chat show it as a static label instead.
- Send is a split button: the arrow sends, and a narrow chevron beside it
  opens a one-item menu, Send as Best of N (Mod+Shift+Enter). That opens a
  compact dark popover anchored above the composer, not a dialog: a title
  row with a 2, 3, 4 run switch (3 by default), one row per run with the
  same agent and model pickers as the composer (each starts as the chat's
  own agent and model, and runs can mix), and a footer that says how many
  worktrees it creates beside the Start runs button. The typed message is
  the prompt for every run.
- Hovering a sent user message shows a quiet Try N ways button to its left.
  It opens the same popover with the message quoted, and the runs start from
  the files as they were before that message.
- Runs list under the chat they came from in the sidebar, behind a thin rule
  and a Best of N heading. Each row has a Run N badge, the run's branch in
  mono, and its live status: Running in blue, Done in green, Failed in red.
  The heading counts finished runs, then turns into a Compare button when
  every run has stopped, and a notice says the runs are ready. Tiles carry
  the same Run N badge next to the branch.
- Compare puts the runs side by side as equal columns on the well surface:
  run number and status, agent and model with their marks, branch, then a
  short list of files changed with +/− lines, checks (or No checks run),
  cost, and time. Each column ends with View diff, which opens Changes for
  that run, and Keep this one. Keeping asks once, names the branches it
  deletes, then removes the other runs with their worktrees and branches,
  and the kept run becomes an ordinary chat.
- Terminal, Files, Browser, and Changes open from the top bar. Files,
  Browser, and Changes share one resizable column on the right, and each
  remembers its own width. Files opens at 640px so the tree fits beside the
  editor, Browser at 560px, and Changes at 520px, each capped at 45% of the
  window. Panels never float over the agent grid.
- The terminal drawer is its own island under the grid. It starts closed.
  Opened without a shell, it is a single row with Start terminal; once a
  shell runs it takes its remembered height.
- Notices and the attention bar take the island shape above the workbench
  instead of running edge to edge across the window.
- Dialog forms stack labelled sections: the label sits above its control and
  a one-line hint below it. The New agent dialog has no message box; it picks
  where and how the agent runs, and the person types to the agent once it
  starts. Its sections are Project (only with more than one), Agent as cards
  with the provider mark and installed version, View and Workspace as
  segmented controls, then Model and Permissions side by side. Those two are
  field-style pickers that open the same dark list as the composer, with the
  maker's logo beside each model and an icon and description for each
  permission level. The footer shows the branch a new worktree will create.
- Usage leads with four metric cards (turns, input, output, estimated cost),
  a period switch, and bordered tables by agent and by chat. Help lays its
  shortcuts out in two columns and ends with support actions as cards.
- Every panel starts with the same pane header: icon, title, context, then
  actions. Toolbars below it use the same height and control sizes.

## Interaction

- Every icon-only button has an accessible name and a tooltip. When an action
  has a shortcut, the tooltip shows it.
- Shortcuts appear as key caps in the command palette, in tooltips, and in
  the help dialog. Buttons do not print key caps inside them. Ctrl and Cmd both work. The main ones are
  Mod+K for the command palette, Mod+N for a new agent, Mod+P to go to a file,
  Mod+Shift+F to search in files, Mod+B for the sidebar, Mod+J for the
  terminal drawer, Mod+Shift+E for Files, Mod+Shift+B for Browser,
  Mod+Shift+G for Changes, and Mod+, for Settings. People can change these in
  Settings, and every key cap and tooltip shows the current binding. In the
  composer, Enter sends and Mod+Shift+Enter opens Send as Best of N.
- Settings is one fixed-size dialog laid out like the window: a canvas
  sidebar with a search field and the sections under four headings (Agents,
  Workspace, Tools, App), and the open section on a surface island inset by
  the gutter. The island starts with a breadcrumb (heading, then section)
  and the close button. Search matches section names and the words people
  use for them, Enter opens the first match, and Escape clears the field
  before it closes Settings. Each section is titled groups of setting rows:
  the label and a short description on the left, the control on the right.
  Switches are square-cornered and neutral: on is a light track, not the
  accent.
- Settings > Mobile works like an IDE's device manager: the devices with
  their state and Boot or Shut down, the device frame and agent switches,
  then the Android SDK location and each tool it needs, and iPhone
  simulator support.
- The Mobile panel's bottom bar has three clusters: Type text and Open URL
  on the left, the system buttons (Back, Home, Recents) centered in a well
  like a phone's navigation bar, and Rotate, Save a screenshot, and the
  More menu on the right. Shut down is an icon button in the toolbar, and
  the reason for screenshots mode is a caption under the device.
- Integrations Browse shows connectors and plugins as cards one step above
  the island: logo, name, publisher, a two-line description, then a footer
  with the action. Card buttons stay neutral; the accent is kept for the
  final step. Install, Connect with a token, and a browser sign-in open the
  card across the row in place. Install lists what the plugin adds (skills,
  MCP servers, prompts, actions) and where it comes from before Install. A
  sign-in shows what to do in the browser, the code when there is one, Open
  again, and Cancel, on an accent-edged panel.
- MCP servers are one list shared by every agent. Each row leads with its
  switch so a server can be turned off without losing its setup, and the
  command line sits under the name in mono because it is what people check.
- Every control has hover, active, focus-visible, and disabled states. All
  focusable elements share one focus ring; text fields replace it with an
  accent border and a soft glow. The composer as a whole lifts to the overlay
  fill and takes the same glow while anything inside it has focus. Panel
  resize handles show an accent line on hover.
- Stopping running work uses one control everywhere: the agent tile header,
  the composer during a turn, and Cancel on a booting device. It is a raised
  pill (round when it has no text) with a small square inside a ring. The
  ring turns in the Working blue while the work runs and stays still for an
  idle agent. Pointing at it turns it red, and after a click the ring speeds
  up until the work has ended. Menus use the same ring-and-square icon for
  Stop agent.
- Dialogs trap Tab, give focus back when they close, and close on Escape or a
  click outside.
- Pickers open above their trigger when there is room, focus the selected
  option, move with the arrow keys, Home, End, or a typed letter, and close on
  Escape, Tab, a pick, or a click outside, giving focus back to the trigger.
  Long lists can sort options under small dim group headings; arrow keys move
  straight across groups.

## States

- Empty states say what is missing and offer the action that fills the view.
  They lead with a bare icon rather than an icon in a box, and the action's
  shortcut lives in its tooltip.
- Loading states name what is loading next to a small spinner. There are no
  skeletons for data that does not exist yet.
- Errors appear next to the thing that failed: a banner in the panel for file
  conflicts and page load failures, inline text under a form for command
  errors. They say what happened and what the person can do next.
- While the runtime starts, the shell shows that it is connecting. A window
  opened without the desktop bridge explains how to start ZLI properly.

## Motion

Motion is limited to hover and focus feedback, a slight press on buttons,
resizing, chevrons, status spinners (including the Stop ring), and one entrance: dialogs and the command
palette fade in and rise 4px over 150ms so they read as part of the same
window. Durations stay between 100 and 160ms. There are no decorative loops.
With reduced motion turned on, transitions and animations are switched off,
and entrances land straight on their final state. Status spinners keep
turning, slowly, because they carry meaning.
