# Buddies: new teammate and chat avatars

Date: 2026-11-13. Status: approved direction, written for the builder.

Reference mockup (open in a browser, it animates): `docs/superpowers/specs/2026-11-13-buddies-mockup.html`.
Its SVG paths, colors, eye shapes and keyframes are the source of truth for the look. Port them; don't redraw.

## Why

The animal avatars (`v2/apps/web/src/teammates/AnimalAvatar.tsx`) don't look good. Each animal is built
differently (head sizes, eye heights, tall bar eyes), so the set doesn't read as one family. The person
wants a set that is minimal, cute and clearly ours. They liked the Grok Bot picker (flat color, one bold shape,
eyes only, shape and color picked separately), but asked for something inspired by it, not a copy.

Grok's own design notes (x.ai, "Designing Grok Bot") back two ideas we keep: the construction stays the same
and bots differ by small variations and accessories; and the avatar itself shows the agent's state through
motion, so no separate status icon is needed.

## What a Buddy is

A Buddy is a **body** plus a **color**. 12 bodies × 12 colors.

Shared by every Buddy (this is what makes them ours, not Grok's):

- **Cursor eyes.** Two square-cornered blocks, like a terminal cursor, with a small light glint at large sizes.
- **They glance right**, toward the chat, which sits to the right of the sidebar. They face front when they
  need the person (waiting) and when asleep (stopped).
- **Two small feet.** Every buddy stands instead of floating. Jelly is the one exception (wavy bottom, no feet).
- **Pink cheeks and a soft shine**, shown only at 30 px and up. Below that they turn into noise.
- **One accessory each**, from the mockup:

| Body | Signature color | Its own thing |
|---|---|---|
| Gumdrop | Tangerine `#ff8a3d` | leaf and stem on top |
| Capsule | Lime `#a6d44f` | curl of hair |
| Plus | Rose `#ff7aa8` | white bow |
| Cloud | Sky `#4aa8ff` | small raindrop |
| Mushroom | Indigo `#6f6cf6` | white spots on the cap, eyes on the stem |
| Peanut | Clay `#c9825b` | crease and speckles |
| Jelly | Jade `#2fbf8f` | two bubbles, no feet |
| Wedge | Butter `#f2cf5b` | cheese holes |
| Squircle | Paper `#ece8df` | round glasses, pencil behind the ear |
| Bulb | Orchid `#c56ff0` | curled tip |
| House | Tomato `#ef5a47` | chimney that puffs |
| Bean | Slate `#8a93a3` | red beanie with pom-pom |

The 12 colors: Paper, Clay, Tomato, Tangerine, Butter, Lime, Jade, Sky, Indigo, Orchid, Rose, Slate (hex
values in the mockup). The eye color is dark on light bodies and light on dark ones (luma rule in the mockup's
`inkFor`). Accessories keep their own colors whatever body color is picked (the leaf stays green, the bow
stays white, the beanie stays red), except the few drawn as a darker shade of the body (Peanut crease, Wedge
holes, House chimney, Bulb lines).

The **signature pair** in the table is the "default look" set of 12. Anything that is not a saved teammate
(chats, room members) draws from these 12, so neighbors differ in both shape and color.

## Face tiles below 40 px (added after trying it in the app)

At sidebar size a whole buddy read as feet and outline, and a column of different shapes looked noisy. Below
40 px a buddy is a **face tile**: a rounded square (28 of 32 units, radius 9.6) in the buddy's color with
**chunky cursor eyes** (wider, shorter blocks with a glint; chosen over narrow blocks, which read as a pause
sign). The picker's body grid passes `full` to keep showing bodies. The large buddies use the same chunky eyes.
The empty chat shows the whole buddy at 92 px inside a soft light in its color (`.buddy-glow`).

## Sidebar changes made alongside (decided with the person while trying the app)

- **Colored project headings** (setting `tintProjects`, on by default; Settings > Appearance > Sidebar > Color
  project headings). Each heading takes a 12% tint of its lantern ring's colour (19% on hover); the name, folder
  icon and chevron lean toward it. The hue is `lanternHue(project.name)`, set as `--lantern-hue` on the project
  section.
- **Chats under a project** (setting `chatTint`: `card` default, `selection`, `none`). Card: a 5% wash of the
  project colour holds the heading and its chats, with the heading flush to the card edge (an inset rim read as
  a glow and was removed). Selection: chats stay plain; hover takes 8% and the open chat 16% of the project
  colour. None: the plain grey rows.
- **Top row**: search, New chat and Add project on one line. Search fills the width, placeholder "Search", bold
  (600); its accessible name stays "Find a chat". New chat keeps its pen icon and shortcut as a square icon
  button; Add project is the folder button beside it. All three sit on the black window with a hairline border
  and turn grey on hover, focus or press.

## Moods and motion

The existing moods stay (`idle`, `working`, `thinking`, `waiting`, `done`, `failed`, `stopped`) and one is
added: **`ack`**, a single hop when a task arrives, about 600 ms, played on the switch into working or starting,
then working takes over. `useAvatarMood` already plays a short `done`; `ack` is the same idea on the way in.

| Mood | Eyes / mouth | Motion |
|---|---|---|
| idle (Ready) | cursor blocks, no mouth | breathes, blinks, glances left and right now and then |
| ack (Got a task) | as idle | one squash and hop |
| working | eyes drop to a typing underscore that blinks | rocks side to side, body bobs, feet step |
| thinking | shorter blocks, looking up and right, small flat mouth | slow sway, three dots rise above the head |
| waiting (Needs you) | tall blocks, face front, small "o" mouth | two hops, then a pause, repeating |
| done | `^ ^` and an open smile | jump, one spin, settle |
| failed | `x x`, wobbly mouth, greyed out | one quick shake, then slumps |
| stopped | closed curves, face front, dimmed | slow breathing, a "z" floats up |

Keyframes and timings are in the mockup's `<style>`.

### When things move (decided with the person)

- **Ready motion plays only in the larger spots**, at 40 px and up: the chat header (44 px), the empty-chat
  hero (56 px) and the picker preview. Everywhere smaller (sidebar 22, room chips, mention picker 20–22,
  teammates list 30, the 16 px thinking marker) a resting buddy holds still and blinks once on hover, as today.
- Every other mood animates at any size, because there the motion tells the person what the agent is doing.
- The existing **Animate teammates** setting (`animateTeammates`) and `prefers-reduced-motion` turn all motion
  off. With motion off, the eyes and mouth still show the mood.

`DESIGN.md` says "no decorative loops". The idle loop is limited to the large spots for that reason; the other
loops carry state. Update the Motion section of `DESIGN.md` to say so.

## Picking a buddy

In Settings > Teammates, the animal grid becomes a picker with:

- a large live preview of the buddy (playing its Ready motion),
- a **Body** grid of the 12 bodies drawn in the chosen color,
- a **Color** row of 12 swatches.

The selected body gets the accent edge and the selected swatch gets an accent ring, as `DESIGN.md` asks for
selected choices. A new teammate starts with a random signature pair that no other saved teammate uses yet.
The name field and the rest of the teammate form stay as they are.

## Data and migration

- A teammate stores `buddy: { body, color }` in place of `animal`. When reading saved settings, an old `animal`
  value maps to a buddy so nobody's teammates change unexpectedly:

  fox → Gumdrop/Tangerine, owl → Squircle/Paper, otter → Jelly/Jade, cat → Cloud/Sky,
  panda → Bean/Slate, penguin → Mushroom/Indigo, bear → Peanut/Clay, rabbit → Plus/Rose,
  frog → Capsule/Lime, chick → Wedge/Butter.

  An unknown or missing value falls back to Gumdrop/Tangerine, as `fox` does today.
- Per-chat looks (`teammates/chatAnimals.ts`, localStorage key `zli.chat.animals`) work the same way: stored
  animal names map through the table above, new chats pick among the 12 signature pairs with the same
  "least used nearby" rule.
- Provider defaults (`defaultAnimal`) map through the same table (claude-code → Gumdrop, codex → Squircle,
  and so on).
- `roomAnimals` keeps its rule (a saved teammate keeps its own look; others take their provider's default or
  the next free signature pair).

## Must keep working

- The provider mark in the corner and the amber "needs you" flag on `AnimalAvatar` today.
- Accessible name and mood text (`"Name, working"`), and decoration-only when there is no name.
- System notification icons (`animalIcon.ts`): the static buddy, inline colors, no CSS, rendered to PNG.
- Every place that shows an avatar today: sidebar sessions, room chips, chat header, mention picker, team bar,
  thinking marker, empty chat, Teammates settings.
- All themes: buddies sit on the dark window by default, and must also read on Daylight.

## Non-goals

- No uploads, generated pictures or GIF avatars.
- No new statuses beyond `ack`; `blocked` stays covered by `waiting` and `failed`.
- No change to teammate names, instructions, providers or permissions.

## Left to the builder

- File and type names (for example `Buddy`, `BuddyAvatar`, `buddies.ts`), and whether the old `Animal`
  names stay as aliases during the change.
- How the 40 px rule for the Ready motion is applied (a size check or a prop).
- How `ack` is timed inside `useAvatarMood`.
- Keeping the thinking dots and the "z", which draw outside the 32-unit box, from being clipped in tight rows.
- Tests: update `teammates.test.ts` and `ChatRoom.test.tsx`, and add tests for the animal-to-buddy
  migration and the picker.
