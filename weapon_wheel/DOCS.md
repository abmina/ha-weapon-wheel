# Weapon Wheel Dashboard

📖 The full **[user manual](https://github.com/abmina/ha-weapon-wheel/blob/main/docs/user-manual.md)**, with
screenshots, covers setup, everyday use, room cards, custom homes and troubleshooting. This page is the short version.

Open the dashboard from **Weapon Wheel** in the sidebar (turn on *Show in sidebar* on the app's Info tab).

## How it finds your home

The app reads Home Assistant's registries, and picks up any change to them automatically:

- **Floors** become the storeys of the house, ordered by their *level*. Negative levels are drawn below the ground line.
- **Areas** become the rooms on their floor. Areas without a floor go in an extra *Unassigned level* storey. If you
  have no floors at all, every room goes in one storey called *Home*.
- **Devices** in an area make up that room's device wheel. Two or more devices from the same integration are grouped
  into one leaf named after the integration; opening it shows a wheel with just those devices. (A room whose devices all
  come from one integration is not grouped.) A device whose entities are spread over several areas
  appears in each of them, with just the entities for that room. Entities assigned to an area directly, without a device
  (scenes, helpers…), are grouped as *"<Room> extras"*.
- **Entities** of a device are split in two: **controls** (lights, switches, covers, climate, media players, locks,
  scenes, buttons, numbers, selects…) go on the entity wheel; **sensors, binary sensors and other read-only entities,
  and all config and diagnostic entities** are listed in the device's sidebar panel. Disabled entities are always
  skipped, and hidden entities are skipped unless you turn on the option below.

Set areas and floors under *Settings → Areas, labels & zones*.

## Using it

1. **House** - the weather is in the top-left corner (tap it for details). Hover a room for a summary and click it to
   open it. A room's pin shows how many leaves its wheel has
   (devices and integration groups). Rooms
   with lights on glow.
2. **Device wheel** - move the mouse (or your finger) in any direction to aim at a device, and click to open it. Click the
   centre, or press Esc, to go back.
3. **Entity wheel and device panel** - the wheel shows the device's controls, and the sidebar shows its **Sensors**,
   **Settings** and **Diagnostics**. A device with nothing to control (such as a temperature sensor) just opens its panel.
4. **Entity sidebar** - pick a control on the wheel, or tap a row in the panel, for its controls, last 24 hours, more
   actions and attributes. *‹ device* or Esc goes back to the device panel.

With more than 10 devices in a room, the wheel gets pages. Use the arrows next to it, the scroll wheel or PageUp/PageDown.

## Cameras

A camera's sidebar has a **Snapshot / Live** switch:

- **Snapshot** shows the latest picture and refreshes it every 10 seconds.
- **Live** plays the camera as video. Cameras that support Home Assistant's *stream* integration (included in the default
  configuration) play as an HLS stream (marked *LIVE · HLS*). Other cameras, or an HLS stream that fails or doesn't start
  within 12 seconds, use an MJPEG stream instead (*LIVE · MJPEG*).

The stream stops as soon as you close the sidebar or pick another entity.

## Edit mode and room cards

Click **Edit** (top right of the house) to edit the dashboard in place, like a Home Assistant dashboard:

- Every room card gets a **pencil**. It opens the card editor with a live preview, where you choose the card's **name**,
  **icon** (any [Material Design icon](https://pictogrammers.com/library/mdi/), e.g. `sofa`) and what it **shows**: any
  mix, in any order, of *Temperature* (automatic), *Lights on*, *Devices on*, *Doors & windows open*, *Motion*, or any
  entity's live state (pick a specific temperature sensor, a humidity sensor, a door…). *Default* goes back to
  temperature, lights on and motion.
- In a **custom home** you can also arrange the floor plan: drag a room to move it, drag its blue corner to resize it.
  Rooms snap to a grid and can't overlap. *Auto-arrange* lays the level out again. Outdoor gardens arrange themselves.
- **Done** / **Save** leaves edit mode.

## Custom home

By default the house is built automatically from Home Assistant. In **Customize → Home layout → Custom** you design it
yourself instead. When you switch, choose to **continue** your custom home (if you have one), **copy the automatic
home** (then change what you like), or **start empty**.

- **Levels**: a name and a number - higher numbers are upstairs, below 0 is underground. Tick **Outdoor** to draw the
  level as a garden next to the house.
- **Rooms**: a name, an icon, a level, and what's in them - **Add devices or entities** lets you pick any device or
  single entity from Home Assistant, including ones without an area. A device brings all its entities; a single entity
  opens straight away when you select it.
- **Groups**: make your own groups in a room (they replace the automatic integration groups) and choose each
  device's group.

Switch back to **Automatic** at any time - your custom home is kept for later.

## Customize

Click **Customize** (top right) to open it as a full window, where you can:

- give the house a name, shown on the roof, in the navigation bar and in the browser tab (leave it empty to use the
  home name from *Settings → System → General*);
- show or hide any floor, room, device or entity (eye button);
- rename them for this dashboard (leave the field empty to use the Home Assistant name);
- rename a room's integration groups (the tree shows them like the wheels);
- reorder rooms on a floor and move a room to a different floor;
- tick **Outdoor** on a level to show all its rooms in a garden outside the house (for example a *Garden* or
  *Outside* floor, or the *Unassigned level*), or move a single room to the built-in **Outdoor** level;
- hide rooms that have no devices;
- skip the entity wheel for devices that have only one entity;
- turn grouping by integration on or off;
- choose the weather the house shows (any weather integration, Met.no by default, or none).

Right-click (or long-press) a segment on a wheel to hide it quickly. A toast lets you undo it.

Customizations are stored in the app's `/data/layout.json`. They survive restarts and updates and are included in Home
Assistant backups.

## Options

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
