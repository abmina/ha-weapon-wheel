# Changelog

## 0.3.9
- A **Home** button in the top bar while you're in the wheels takes you straight back to the house (on phones the
  breadcrumbs are shortened, so the house wasn't always one tap away).

## 0.3.8
- Fixed: in the **Companion app** the dashboard went back to the house after 30 seconds even while you were using
  the menus. Every kind of tap, touch, click and scroll now counts as activity, and so does every step through the
  menus.

## 0.3.7
- In full screen the **full screen button is hidden**, so nothing on a wall panel invites leaving it. To leave, **hold
  the logo** in the top-left corner for 2 seconds (it fills with colour while you hold). A plain tap does nothing.

## 0.3.6
- **Full screen works in kiosk browsers** such as Fully Kiosk Browser and in the Companion app: the button now
  always shows inside Home Assistant. The dashboard stretches itself over Home Assistant's title bar and sidebar, so
  it no longer depends on the browser offering full screen. Where the browser does, its own bars are hidden as well.
- **Remembered per device**: a screen left in full screen hides Home Assistant's bars again as soon as it loads, no
  tap needed. Tap the button again to bring them back.

## 0.3.5
- **Full screen** button in the top bar: the dashboard takes over the whole screen, without Home Assistant's title
  bar and sidebar (and the browser's bars). Tap it again, or press Esc, to leave.
- A wall panel left in full screen goes back to it on the first tap after a reload; browsers only allow full screen
  after a tap.
- **Back to the house after 30 seconds**: when nobody touches the screen (or moves the mouse or presses a key) for
  30 seconds in the wheel menus, the wheel folds and the house comes back. Not while Customize or edit mode is open.

## 0.3.4
- **Every Home Assistant user** can now open the dashboard, so it works on a wall panel with its own non-admin account.
- **Only administrators can edit**: for other users *Edit*, *Customize* and hiding/unhiding items (right-click,
  *Hide entity*, *Hide device*) are hidden, and the app refuses changes from them. Everyone can still use the controls.
- **After updating, turn *Show in sidebar* off and on once** (or restart Home Assistant). Home Assistant keeps the
  admin-only sidebar entry of the previous version until then.

## 0.3.3
- **Weather** in the top-left corner of the house: current condition, temperature, today's high and low, humidity and
  the next days. Uses Home Assistant's own Met.no weather by default; choose any other weather integration (or none)
  in *Customize → Weather* or with the pencil on the weather card in edit mode. Tap it for details.
- **Phones and portrait screens**: outdoor gardens are drawn below the house instead of beside it, so the house uses
  the full width and the screen's height instead of shrinking. The layout also rebuilds when a tablet is rotated.

## 0.3.2
- New **[user manual](https://github.com/abmina/ha-weapon-wheel/blob/main/docs/user-manual.md)** with screenshots, linked from the
  Documentation tab.
- Fixed a stray "null" text above the sidebar for cameras and single entities, and under the list in the
  *Add devices or entities* picker.
- Wording: Home Assistant calls add-ons **apps** now, and so do this app's texts.
- **Customize** opens as a full window, like the house, instead of a floating box.
- The Customize tree shows each room's **integration groups** like the wheels do, and you can **rename** a group (per
  room). The search also finds devices by manufacturer and model.

## 0.3.1
- The tooltip when you hover a room now shows exactly what its card shows, in the same order and with names - so a
  temperature sensor you picked for the card is also the one in the tooltip, instead of the automatic one.

## 0.3.0
- **Custom home.** In *Customize → Home layout*, switch from **Automatic** (built from Home Assistant floors, areas,
  devices and integrations) to **Custom** and design your own: levels (indoor, underground or outdoor), rooms with any
  name and icon, any devices or single entities in them (also ones without an area in Home Assistant), and your own
  groups. When switching you choose to continue your custom home, copy the automatic one, or start empty. You can switch
  back to Automatic at any time; your custom home is kept.
- **Edit mode**, like a Home Assistant dashboard: **Edit** on the house puts a pencil on every room card.
  - **Room card editor** with live preview: name, icon, and what the card shows - any mix, in any order, of
    temperature, lights on, devices on, doors & windows open, motion, or any entity's live state.
  - **Floor plan** (custom home): drag rooms to move them and drag their corner to resize them on a grid, so the house
    looks like your real home. Rooms can't overlap; *Auto-arrange* lays them out again.

## 0.2.6
- Devices of the same integration in a room are grouped into one leaf of the room's wheel (for example **Shelly ·
  2 devices**). Opening it shows a wheel with just those devices; from there everything works as before. Rooms where
  every device comes from the same integration are not grouped. Turn it off with *Customize → Group devices of the same
  integration*.
- The number on a room's pin is now the number of leaves on its wheel (devices and integration groups), not a count of
  everything in the room.

## 0.2.5
- The entity wheel only shows **controls** (lights, switches, covers, climate, media, locks, scenes, buttons…).
- Selecting a device opens its panel in the sidebar with its **Sensors**, **Settings** (config entities) and
  **Diagnostics**. Tap one to see its value, history and actions; *‹ device* or Esc goes back to the panel.
- Devices with nothing to operate (for example a temperature sensor) open their panel straight away instead of an
  empty wheel.
- Diagnostic entities are always available now (in the panel), so the *Show diagnostic entities* option is gone.
  Config and diagnostic entities no longer count towards a room's temperature or "lights on".

## 0.2.4
- Cameras: a **Snapshot / Live** switch in the sidebar. Live uses Home Assistant's HLS stream when the camera supports
  it (smooth video; hls.js is bundled, no internet needed) and falls back to MJPEG for every other camera, or when the
  HLS stream fails or doesn't start within 12 seconds. Snapshots refresh every 10 seconds, there is a full-screen
  button, and the stream stops when you close the sidebar.
- The Companion app and browsers no longer keep showing an old version of the dashboard after an update: the page's
  style and script files are versioned by content and always re-checked.

## 0.2.3
- Outdoor levels: in *Customize*, tick **Outdoor** on any level and all its rooms are shown in a garden outside the
  house, standing on the grass next to it. Single rooms can be moved outside with the built-in **Outdoor** level in a
  room's level list. Each outdoor level gets its own garden; on phones they stack next to the house.
- Rooms without a level are now grouped as **Unassigned level** (was "Unassigned rooms").

## 0.2.2
- Name your house: *Customize → House name*. The name shows on the roof of the house, as the first step of the
  navigation bar and in the browser tab. Leave it empty to use the home name from Home Assistant
  (*Settings → System → General*).

## 0.2.1
- Documentation and release-note wording updates. No changes to the dashboard itself.

## 0.2.0
- New look: light and dark mode that follow your system setting, blue highlights, clean cards and pill buttons.
  New icon and logo.
- Weapon wheel: the gaps between slices now have parallel sides, so they are the same width all the way out.
- Weapon wheel: clicking or tapping outside the wheel no longer selects a slice.
- Long device names fit in the centre of the wheel.
- The highlight colour option is now optional and empty by default. The old orange default (`#ff7a1a`) is ignored,
  so existing installs switch to the new theme automatically.

## 0.1.0
- First release.
- House map built automatically from Home Assistant floors and areas, with live room status (lights, temperature,
  motion).
- Weapon-wheel menus for devices and entities, with fold/unfold animation, pages for large rooms, mouse, keyboard and
  touch control.
- Action sidebar with controls per domain, 24-hour history, extra services and attributes.
- Customize editor: hide, rename, reorder and move rooms between floors; quick-hide from the wheel with undo.
- Security: Ingress-only access, custom AppArmor profile, no internet access at runtime.
