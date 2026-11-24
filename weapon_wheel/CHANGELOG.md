# Changelog

## 0.2.0
- New look matching the Rain Bird ESP-TM2 app: light and dark mode that follow your system setting, blue highlights,
  clean cards and pill buttons. New icon and logo.
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
