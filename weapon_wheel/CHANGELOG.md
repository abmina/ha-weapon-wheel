# Changelog

## 0.2.3
- Outdoor levels: in *Customize*, tick **Outdoor** on any level and all its rooms are shown in a garden outside the
  house, standing on the grass next to it. Single rooms can be moved outside with the built-in **Outdoor** level in a
  room's level list. Each outdoor level gets its own garden; on phones they stack next to the house.
- Rooms without a level are now grouped as **Unassigned level** (was "Unassigned rooms").
- Cameras: a **Snapshot / Live** switch in the sidebar. Live uses Home Assistant's HLS stream when the camera supports
  it (smooth video; hls.js is bundled, no internet needed) and falls back to MJPEG for every other camera, or when the
  HLS stream fails or doesn't start within 12 seconds. Snapshots refresh every 10 seconds, there is a full-screen
  button, and the stream stops when you close the sidebar.
- The Companion app and browsers no longer keep showing an old version of the dashboard after an update: the page's
  style and script files are versioned by content and always re-checked.

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
