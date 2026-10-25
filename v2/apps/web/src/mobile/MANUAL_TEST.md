# ZLI Mobile manual test

Unit tests cover the Mobile panel with fake drivers. This checklist covers what only real hardware can show: emulators, USB phones, a Mac with Xcode, and the agent tool. Run it from the desktop app (`pnpm run desktop:dev` from `v2/`), with the Mobile panel open (Mod+Shift+M).

Tick each box when the expected result matches. When it does not, note the host, the device, and what happened instead.

## Windows Android emulator

Start on a Windows machine with no Android SDK, or rename `ANDROID_HOME` for the test.

### Setup, licenses, cancel and resume

- [ ] Open the Mobile panel with no SDK installed.
  Expected: one card, "Set up the Android emulator", with the list of what is missing, one primary button, and the hint about USB phones. iOS shows only as one dimmed line at the bottom: "iPhone simulators need a Mac with Xcode."
- [ ] Click "Review the install".
  Expected: the install folder, each download with its size, the total download size, and each license with its own checkbox. Install stays disabled until every license is accepted.
- [ ] Accept the licenses and click Install.
  Expected: a progress bar with bytes downloaded, the current step name, and Cancel.
- [ ] Click Cancel partway through a download.
  Expected: the install stops, a notice says it was cancelled, and the button reads "Review and try again".
- [ ] Review again and install to the end.
  Expected: setup resumes, skips what is already installed, creates the virtual device, and the panel lists it as Off.
- [ ] Close the panel during an install, then open it again.
  Expected: the progress bar is still there and still moving.

### Boot

- [ ] Click Boot on the new virtual device.
  Expected: the badge reads "Booting" with a running time, the body shows "Booting <name>, 0:05" counting up, the first-boot hint, and Cancel.
- [ ] Let a boot run past three minutes (a cold first boot, or with acceleration off).
  Expected: a second, softer note suggests checking hardware acceleration.
- [ ] Boot again and click Cancel while it is booting.
  Expected: the emulator process stops within a few seconds, the device shows as Off, and no error banner appears.
- [ ] Boot to the end.
  Expected: the screen appears, the badge reads Running, and a "Live" chip sits next to it.

### Live video and input

- [ ] Watch the screen while an animation plays on the device.
  Expected: smooth video, no visible tearing, and the "Live" chip.
- [ ] Tap an app icon.
  Expected: the app opens. The tap lands where the pointer was.
- [ ] Drag up on the home screen.
  Expected: the app drawer follows the drag.
- [ ] Scroll with the mouse wheel over a long list (Settings works).
  Expected: wheel down moves the content up, like a desktop page. The Mobile panel itself does not scroll. Fast wheeling scrolls further.
- [ ] Click the screen, then type "hello" on the keyboard into a text field on the device.
  Expected: each letter appears in the field.
- [ ] Open "Type text", type a sentence with spaces, and press Enter.
  Expected: the whole sentence appears in the device's focused field.
- [ ] Paste more than 300 characters into "Type text" and send it.
  Expected: all of the text arrives, in order.
- [ ] Copy text on the computer, click the screen, and press Ctrl+V.
  Expected: the copied text appears once in the device's focused field.
- [ ] With the screen focused, press the arrow keys and Tab in a form.
  Expected: focus moves between fields on the device. Tab does not move focus out of the screen. Shift+Tab leaves the screen.
- [ ] Click Back, Home, and Recents.
  Expected: each does what the hardware button does.
- [ ] Click Rotate twice.
  Expected: the device turns to landscape, then back to portrait, and the screen keeps its aspect ratio.
- [ ] Open "More device buttons" (the ⋯ button at the right of the bottom bar) and press Power, Volume up, and Volume down. Use the arrow keys and Enter for one of them, and Escape to close the menu once.
  Expected: the screen turns off and on, and the volume panel appears on the device. Escape closes the menu and focus returns to the ⋯ button.

### Screenshots and zoom

- [ ] Click "Save a screenshot".
  Expected: a PNG named after the device and the time is saved, and a short "Saved" confirmation appears.
- [ ] Copy the screenshot.
  Expected: "Copied" feedback, and pasting into an image editor shows the device screen.
- [ ] Switch between Fit and 100%.
  Expected: 100% shows device pixels with scrollbars. Taps land in the right place in both modes, including after scrolling. The choice is remembered for the device.

### Open URL, logs, and Expo

- [ ] Open `http://localhost:<port>` for a dev server running on the computer.
  Expected: the page opens on the device, and the panel says it forwarded the port.
- [ ] Open the Logs drawer, filter for a word, and turn on auto-refresh.
  Expected: matching logcat lines, refreshed every two seconds while open. Copy all copies them.
- [ ] Start an Expo app with `npx expo start` in the current worktree.
  Expected: a banner says Expo is running on localhost:8081 and offers "Open on <device name>". Clicking it opens the app in Expo Go. Nothing opens without the click.

### Virtual device manager

- [ ] Open the virtual device manager from the device picker ("+ New virtual device") and from Setup.
  Expected: a list of virtual devices with Boot and Delete, and a Create form that offers installed system images only.
- [ ] Create a device, boot it, then delete another one.
  Expected: the list and the device picker update. Delete asks first and refuses while that device is running.

## Android USB phone

- [ ] Connect a phone with USB debugging on, before accepting the computer's key.
  Expected: the panel shows "Allow USB debugging on the phone" and the badge reads "Waiting for approval".
- [ ] Accept the prompt on the phone, then click Refresh.
  Expected: the phone shows as Running with its screen, and tap, swipe, wheel scroll, and typing work like the emulator. Boot and Shut down do not appear.

## Linux Android

- [ ] Repeat setup, boot, tap, swipe, wheel scroll, type, paste, and the buttons on Linux with KVM.
  Expected: the same results as on Windows.
- [ ] Run without access to `/dev/kvm` (remove yourself from the kvm group, or test in a VM without nested virtualization).
  Expected: the acceleration warning names KVM and says what to do.

## macOS iOS simulator

- [ ] Open the panel on a Mac with Xcode.
  Expected: Setup shows Android and iOS side by side, and Xcode simulators are listed.
- [ ] Boot a simulator.
  Expected: the booting state with a running time, then the screen as screenshots about once a second, with the "Screenshots, about 1 per second" chip. Its tooltip says why.
- [ ] Tap, swipe, and type with idb installed.
  Expected: each one reaches the simulator. While dragging, a trail from the start point to the pointer shows on the screen, and the release sends a swipe.
- [ ] Press the arrow keys and Tab with the screen focused.
  Expected: the simulator receives them.
- [ ] Open "More device buttons" and press Power.
  Expected: the simulator locks. The menu offers no Volume buttons, because idb cannot press them.
- [ ] Click Rotate.
  Expected: until simulator rotation ships, Rotate is hidden for iOS. When it ships, the simulator turns, or a banner explains the Accessibility permission it needs.
- [ ] Uninstall or rename idb, then click Refresh.
  Expected: Setup lists idb as missing with the install command. Screenshots still show; taps report that they need idb.

## Agent and person handoff

- [ ] In an agent terminal, run `zli-mobile devices`, `zli-mobile tap e3`, and `zli-mobile screenshot`.
  Expected: the device list, a tap on the element with ref e3, and a saved screenshot. The panel shows the device the agent used.
- [ ] Watch the lease banner while the agent works.
  Expected: "<agent> is using this device until <time>. Take over to use it yourself." Under two minutes it counts down in minutes. Input from the panel is blocked and moves focus to Take over.
- [ ] Wait for the agent's lease to run out without touching the panel.
  Expected: the banner goes away on its own, without Refresh.
- [ ] Click Take over while the agent holds the device.
  Expected: "You have control." The agent's next command is refused with a message that the person took over.
- [ ] Click "Hand back to agents".
  Expected: the banner goes away and the agent can drive the device again.

## Failure paths

- [ ] No SDK at all.
  Expected: the single "Set up the Android emulator" card. Nothing points to Android Studio first.
- [ ] SDK installed but no virtual devices.
  Expected: setup offers to create the virtual device, and finishes by creating it.
- [ ] SDK and virtual devices installed, adb running, but no device listed (for example, kill the adb server and block it).
  Expected: "No devices found" with Refresh, and a secondary line about ANDROID_HOME.
- [ ] Hardware acceleration off: turn off Hyper-V and Windows Hypervisor Platform (WHPX) on Windows.
  Expected: the acceleration warning in Setup and above the device, and a boot that either fails with the emulator's reason or runs slowly with the three-minute note.
- [ ] scrcpy cannot start (block the scrcpy server download, or delete it while offline).
  Expected: the screen falls back to screenshots, the chip reads "Screenshots, about 1 per second", and its tooltip gives the reason.
- [ ] WebCodecs unavailable (run with `--disable-features=WebCodecs`, or force a decode error).
  Expected: the panel polls screenshots itself, the note under the screen says the video could not be decoded, and input keeps working.
