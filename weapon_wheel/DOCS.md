# Weapon Wheel Dashboard

Open the dashboard from **Weapon Wheel** in the sidebar (turn on *Show in sidebar* on the app's Info tab).

## How it finds your home

The app reads Home Assistant's registries, and picks up any change to them automatically:

- **Floors** become the storeys of the house, ordered by their *level*. Negative levels are drawn below the ground line.
- **Areas** become the rooms on their floor. Areas without a floor go in an extra *Unassigned rooms* storey. If you
  have no floors at all, every room goes in one storey called *Home*.
- **Devices** in an area make up that room's device wheel. A device whose entities are spread over several areas
  appears in each of them, with just the entities for that room. Entities assigned to an area directly, without a device
  (scenes, helpers…), are grouped as *"<Room> extras"*.
- **Entities** of a device make up the entity wheel. Disabled entities are always skipped. Hidden and
  diagnostic/config entities are skipped unless you turn on the options below.

Set areas and floors under *Settings → Areas, labels & zones*.

## Using it

1. **House** - hover a room for a summary and click it to open it. A room's pin shows how many devices it has. Rooms
   with lights on glow.
2. **Device wheel** - move the mouse (or your finger) in any direction to aim at a device, and click to open it. Click the
   centre, or press Esc, to go back.
3. **Entity wheel** - same as the device wheel, for the entities of the chosen device.
4. **Sidebar** - controls for the entity, its last 24 hours, more actions and its attributes.

With more than 10 devices in a room, the wheel gets pages. Use the arrows next to it, the scroll wheel or PageUp/PageDown.

## Customize

Click **Customize** (top right) to:

- show or hide any floor, room, device or entity (eye button);
- rename them for this dashboard (leave the field empty to use the Home Assistant name);
- reorder rooms on a floor and move a room to a different floor;
- hide rooms that have no devices;
- skip the entity wheel for devices that have only one entity.

Right-click (or long-press) a segment on a wheel to hide it quickly. A toast lets you undo it.

Customizations are stored in the app's `/data/layout.json`. They survive restarts and updates and are included in Home
Assistant backups.

## Options

- **Show diagnostic and config entities** - include entities such as signal strength, battery and firmware.
- **Show hidden entities** - include entities hidden in Home Assistant.
- **Highlight colour** - optional hex colour that replaces the theme's blue. Leave it empty for the standard look.

The dashboard follows your device's light or dark mode automatically.

## Security

- The page is only served through Home Assistant's Ingress, so it uses Home Assistant's login. Direct requests to the app's
  port are refused.
- It talks to Home Assistant only through the Supervisor's internal API proxy and never contacts the internet at
  runtime. The icon font is bundled when the app is built.
- It runs with its own AppArmor profile.

## Troubleshooting

- **"Connecting to Home Assistant…" stays on screen** - check the app's **Log** tab for connection errors.
- **A control does nothing** - a red message at the bottom of the screen shows Home Assistant's error. The app log has details.
- **A room is empty** - assign devices to the area in Home Assistant, or turn on *Hide rooms without devices*.
