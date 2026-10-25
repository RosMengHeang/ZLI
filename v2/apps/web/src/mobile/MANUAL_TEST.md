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
  Expected: a PNG named after the device and the time is saved, and "Saved <name>.png" shows for about three seconds, then fades.
- [ ] Open "More device buttons" and pick "Copy screenshot", then paste into an image editor or a chat.
  Expected: "Copied the screenshot." shows, and the paste is the device screen. If the clipboard refuses, the panel says so and suggests saving instead.
- [ ] Switch the toolbar's zoom between Fit and 100%, and scroll the stage with its scrollbars at 100%.
  Expected: 100% shows device pixels at their true size, with scrollbars when the screen is larger than the panel. The mouse wheel over the screen still scrolls the device. Taps land in the right place in both modes, including after scrolling the stage. Each device remembers its zoom after ZLI restarts.

### Device frame

- [ ] Look at a running phone emulator, then at a tablet emulator (for example Pixel Tablet).
  Expected: the phone sits in a dark phone body with rounded corners, a punch-hole camera, and side keys on the right edge. The tablet has a wider bezel, a camera dot in the bezel, and no cutout on the screen.
- [ ] Click Rotate.
  Expected: the body turns with the screen. The side keys move to the top edge and the camera moves to the left.
- [ ] Hover the side keys, then click Power and each volume key.
  Expected: each key shows its name, and pressing it does what the hardware key does. While an agent holds the device, the Power tooltip reads "Power. Take over first." and clicking moves focus to Take over.
- [ ] Tap near each corner of the screen and drag from the bezel onto the screen.
  Expected: taps land where the pointer was, also with the frame on. Clicks on the bezel do nothing.
- [ ] Switch to 100%.
  Expected: the screen still shows device pixels at their true size, with the body around it.
- [ ] Open "More device buttons" and turn off "Show device frame", then restart ZLI.
  Expected: the screen shows without the body, and it stays that way after the restart. Turning it back on brings the frame back.

### Open URL, logs, and Expo

- [ ] Click "Open URL" (the globe in the bottom bar), type `localhost:<port>` for a dev server running on the computer, and press Enter.
  Expected: the page opens in the device's browser, and a short confirmation says "Forwarded localhost:<port> to the device." Typing `https://example.com` opens without the forwarding note.
- [ ] Open the Logs drawer under the bottom bar. Type a word in Filter and an app's package name, then press Enter. Turn on Auto-refresh.
  Expected: matching logcat lines, newest at the bottom, refreshed every two seconds while the drawer is open. Copy all copies them and says how many. Closing and reopening ZLI's window in the same session keeps the drawer open.
- [ ] While an agent holds the device, open the Logs drawer and click Refresh.
  Expected: the drawer asks you to take over, and focus moves to Take over.
- [ ] Start an Expo app with `npx expo start` in a ZLI terminal of the current worktree, with an emulator running.
  Expected: once Expo prints "Web is waiting on http://localhost:8081" (or, with `--localhost`, "Metro waiting on exp://127.0.0.1:8081"), a banner says "Expo is running on localhost:8081." and offers "Open on <device name>". Clicking it opens the app in Expo Go and says it forwarded localhost:8081. Nothing opens without the click.
- [ ] Dismiss the Expo banner with its close button, then switch panels and come back.
  Expected: the banner stays hidden for the rest of the session and returns after ZLI restarts. It also hides while the device is off, and its button sends you to Take over while an agent holds the device.
- [ ] Start Metro with `npx react-native start` instead.
  Expected: no banner, because Metro prints no address to detect. Open `exp://localhost:8081` or the app yourself.

### Virtual device manager

- [ ] Open the device picker with an emulator running and a USB phone connected, then with only one device.
  Expected: Emulators and Phones headings, each device with its Android version and state, and "New virtual device" last. The picker shows with one device too. With no devices it reads "No devices" and does not open.
- [ ] Open the virtual device manager from the device picker ("+ New virtual device") and from Setup.
  Expected: a "Virtual devices" section under Android with each device's system image and state, Boot for devices that are off, and Delete. From the picker, the Create form's Name field has focus.
- [ ] In the Create form, pick a system image and a device profile, keep the suggested name (for example Pixel_7_API_35), and click Create.
  Expected: the image list shows only images already installed, and says so. The profile list starts with Pixel 7 and adds the Pixel profiles your avdmanager knows. After up to a minute, "Created <name>." shows, and the new device appears in the list and in the device picker as Off.
- [ ] Type a name with a space, or the name of an existing device.
  Expected: a warning under the field and a disabled Create button.
- [ ] Click Boot on the new device.
  Expected: the panel goes back to the device view and boots it.
- [ ] Click Delete on a running device, then on one that is off.
  Expected: Delete is disabled while the device runs. For the one that is off, a confirm row asks "Delete it and its data?"; "Keep it" backs out, and Delete removes it from the list and the picker.
- [ ] Use an SDK from Android Studio without the command-line tools (no avdmanager).
  Expected: the list still shows with Boot, Delete is disabled, the Create form is gone, and a line explains that avdmanager comes with the command-line tools.

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
  Expected: the booting state with a running time, then the screen as screenshots, with the "Screenshots, about 1 per second" chip. Its tooltip says screenshots come faster for a few seconds after you use the simulator.
- [ ] Tap, swipe, and type with idb installed.
  Expected: each one reaches the simulator. While dragging, a trail from the start point to the pointer shows on the screen, and the release sends a swipe.
- [ ] Press the arrow keys and Tab with the screen focused.
  Expected: the simulator receives them.
- [ ] Look at the device frame on an iPhone simulator with a Dynamic Island, then on an iPhone SE.
  Expected: the newer iPhone shows a pill-shaped cutout at the top of the screen, and the SE shows none. Only the Power key responds; the volume keys are drawn but do nothing.
- [ ] Open "More device buttons" and press Power.
  Expected: the simulator locks. The menu offers no Volume buttons, because idb cannot press them.
- [ ] Tap through a few screens, then leave the simulator alone for a few seconds.
  Expected: right after each tap the screen updates within about half a second, and for a few seconds it keeps updating about three times a second. Once idle it drops back to about once a second.
- [ ] Click Rotate the first time, before ZLI has the Accessibility permission.
  Expected: a red banner says "Allow ZLI in System Settings > Privacy & Security > Accessibility to rotate simulators." macOS may also show its own prompt. There is no Open settings button; open System Settings yourself.
- [ ] Allow ZLI (or the terminal running `pnpm run desktop:dev`) under Accessibility, and under Automation for System Events if macOS asks, then click Rotate twice.
  Expected: the Simulator app comes to the front, the simulator turns to landscape, then back to portrait, and the panel's screen follows within a second.
- [ ] Boot two simulators, open both in the Simulator app, select one in the panel, and click Rotate.
  Expected: only the selected simulator turns.
- [ ] Close the simulator's window in the Simulator app (the simulator keeps running) and click Rotate.
  Expected: the Simulator app opens the window again and the simulator turns, or the banner asks you to open it in the Simulator app.
- [ ] Experimental, off by default: quit ZLI, start it with `ZLI_MOBILE_IOS_VIDEO=1`, and open a booted simulator with idb installed.
  Expected, if it works: the chip reads "Live", motion is smooth, and taps still land. If idb cannot stream, the chip reads "Screenshots, about 1 per second" and its tooltip starts with "Live video from idb is unavailable". Note which one happened, the Xcode and idb versions, and whether the picture breaks after Rotate (the stream keeps the size it started with).
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
