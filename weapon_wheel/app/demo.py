"""A fake Home Assistant used for local development (DEMO=1)."""
from __future__ import annotations

import asyncio
import copy
import struct
import zlib
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from errors import HAError


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


FLOORS = [
    {"floor_id": "upstairs", "name": "Upstairs", "level": 1, "icon": "mdi:home-floor-1"},
    {"floor_id": "ground", "name": "Ground Floor", "level": 0, "icon": "mdi:home-floor-0"},
    {"floor_id": "basement", "name": "Basement", "level": -1, "icon": "mdi:home-floor-negative-1"},
]

AREAS = [
    ("master_bedroom", "Master Bedroom", "upstairs", "mdi:bed-king"),
    ("kids_room", "Kids Room", "upstairs", None),
    ("bathroom", "Bathroom", "upstairs", None),
    ("office", "Office", "upstairs", None),
    ("living_room", "Living Room", "ground", "mdi:sofa"),
    ("kitchen", "Kitchen", "ground", None),
    ("dining_room", "Dining Room", "ground", None),
    ("hallway", "Hallway", "ground", None),
    ("garage", "Garage", "ground", None),
    ("laundry", "Laundry", "basement", None),
    ("workshop", "Workshop", "basement", None),
    ("garden", "Garden", None, "mdi:flower"),
]

LIGHT_COLOR = {
    "supported_color_modes": ["color_temp", "hs"],
    "color_mode": "color_temp",
    "min_color_temp_kelvin": 2200,
    "max_color_temp_kelvin": 6500,
    "color_temp_kelvin": 3000,
    "brightness": 180,
    "effect_list": ["none", "colorloop", "candle"],
}
LIGHT_DIM = {"supported_color_modes": ["brightness"], "color_mode": "brightness", "brightness": 120}

# (device_id, name, area, manufacturer, model, [(entity_id, state, attrs, registry_extra)])
DEVICES: list[tuple] = [
    ("d_lr_ceiling", "Living Room Ceiling", "living_room", "Philips", "Hue White and Color", [
        ("light.living_room_ceiling", "on", {**LIGHT_COLOR}, {}),
        ("sensor.living_room_ceiling_signal", "-61", {"unit_of_measurement": "dBm", "device_class": "signal_strength"}, {"entity_category": "diagnostic"}),
    ]),
    ("d_lr_lamp", "Reading Lamp", "living_room", "IKEA", "TRADFRI bulb", [
        ("light.reading_lamp", "off", {**LIGHT_DIM, "brightness": None}, {}),
    ]),
    ("d_lr_tv", "Living Room TV", "living_room", "LG", "OLED55C3", [
        ("media_player.living_room_tv", "playing", {
            "volume_level": 0.32, "is_volume_muted": False, "media_title": "Interstellar",
            "media_artist": "Hans Zimmer", "source": "Netflix",
            "source_list": ["HDMI 1", "Netflix", "YouTube", "Live TV"], "supported_features": 152511,
        }, {}),
    ]),
    ("d_lr_climate", "Living Room Thermostat", "living_room", "ecobee", "SmartThermostat", [
        ("climate.living_room", "heat", {
            "hvac_modes": ["off", "heat", "cool", "heat_cool", "auto"], "current_temperature": 20.6,
            "temperature": 21.5, "min_temp": 7, "max_temp": 30, "target_temp_step": 0.5,
            "preset_modes": ["home", "away", "sleep"], "preset_mode": "home",
            "fan_modes": ["auto", "on"], "fan_mode": "auto", "hvac_action": "heating",
            "unit_of_measurement": "°C",
        }, {}),
        ("sensor.living_room_temperature", "20.6", {"unit_of_measurement": "°C", "device_class": "temperature", "state_class": "measurement"}, {}),
        ("sensor.living_room_humidity", "44", {"unit_of_measurement": "%", "device_class": "humidity", "state_class": "measurement"}, {}),
    ]),
    ("d_lr_blinds", "Living Room Blinds", "living_room", "Somfy", "Sonesse 30", [
        ("cover.living_room_blinds", "open", {"current_position": 80, "device_class": "blind"}, {}),
    ]),
    ("d_k_lights", "Kitchen Spots", "kitchen", "Shelly", "Dimmer 2", [
        ("light.kitchen_spots", "on", {**LIGHT_DIM}, {}),
        ("switch.kitchen_spots_led_indicator", "on", {}, {"entity_category": "config"}),
        ("sensor.kitchen_spots_power", "18.4", {"unit_of_measurement": "W", "device_class": "power", "state_class": "measurement"}, {}),
    ]),
    ("d_k_coffee", "Coffee Machine", "kitchen", "Shelly", "Plug S", [
        ("switch.coffee_machine", "off", {}, {}),
        ("sensor.coffee_machine_energy", "12.7", {"unit_of_measurement": "kWh", "device_class": "energy", "state_class": "total_increasing"}, {}),
    ]),
    ("d_k_fridge", "Fridge Sensor", "kitchen", "Aqara", "Temperature Sensor", [
        ("sensor.fridge_sensor_temperature", "4.1", {"unit_of_measurement": "°C", "device_class": "temperature", "state_class": "measurement"}, {}),
        ("binary_sensor.fridge_sensor_door", "off", {"device_class": "door"}, {}),
        ("sensor.fridge_sensor_battery", "87", {"unit_of_measurement": "%", "device_class": "battery"}, {"entity_category": "diagnostic"}),
    ]),
    ("d_k_dishwasher", "Dishwasher", "kitchen", "Bosch", "Serie 6", [
        ("select.dishwasher_program", "Eco 50", {"options": ["Eco 50", "Auto", "Quick 45", "Intensive 70"]}, {}),
        ("button.dishwasher_start", "unknown", {}, {}),
        ("sensor.dishwasher_remaining", "0", {"unit_of_measurement": "min", "device_class": "duration"}, {}),
    ]),
    ("d_d_pendant", "Dining Pendant", "dining_room", "Philips", "Hue Ambiance", [
        ("light.dining_pendant", "off", {**LIGHT_COLOR, "brightness": None}, {}),
    ]),
    ("d_h_door", "Front Door", "hallway", "Nuki", "Smart Lock 3.0", [
        ("lock.front_door", "locked", {"supported_features": 1}, {}),
        ("binary_sensor.front_door_contact", "off", {"device_class": "door"}, {}),
    ]),
    ("d_h_motion", "Hallway Motion", "hallway", "Philips", "Hue Motion", [
        ("binary_sensor.hallway_motion", "off", {"device_class": "motion"}, {}),
        ("sensor.hallway_motion_illuminance", "112", {"unit_of_measurement": "lx", "device_class": "illuminance", "state_class": "measurement"}, {}),
    ]),
    ("d_g_door", "Garage Door", "garage", "Meross", "MSG100", [
        ("cover.garage_door", "closed", {"device_class": "garage"}, {}),
    ]),
    ("d_g_car", "EV Charger", "garage", "Wallbox", "Pulsar Plus", [
        ("switch.ev_charger", "on", {}, {}),
        ("number.ev_charger_current", "16", {"min": 6, "max": 32, "step": 1, "unit_of_measurement": "A", "mode": "slider"}, {}),
        ("sensor.ev_charger_power", "3680", {"unit_of_measurement": "W", "device_class": "power", "state_class": "measurement"}, {}),
    ]),
    ("d_mb_lights", "Bedroom Lights", "master_bedroom", "Philips", "Hue Go", [
        ("light.bedroom_lights", "off", {**LIGHT_COLOR, "brightness": None}, {}),
    ]),
    ("d_mb_fan", "Ceiling Fan", "master_bedroom", "Hunter", "SIMPLEconnect", [
        ("fan.ceiling_fan", "on", {"percentage": 33, "percentage_step": 33.3, "oscillating": False, "preset_modes": ["breeze", "sleep"], "preset_mode": None}, {}),
    ]),
    ("d_mb_speaker", "Bedroom Speaker", "master_bedroom", "Sonos", "One", [
        ("media_player.bedroom_speaker", "paused", {"volume_level": 0.18, "is_volume_muted": False, "media_title": "Weightless", "media_artist": "Marconi Union", "supported_features": 152511}, {}),
    ]),
    ("d_kr_light", "Night Light", "kids_room", "IKEA", "SYMFONISK", [
        ("light.night_light", "on", {**LIGHT_COLOR, "brightness": 30, "color_mode": "hs", "hs_color": [270, 60]}, {}),
    ]),
    ("d_kr_temp", "Kids Room Climate", "kids_room", "Aqara", "TH Sensor", [
        ("sensor.kids_room_temperature", "21.2", {"unit_of_measurement": "°C", "device_class": "temperature", "state_class": "measurement"}, {}),
        ("sensor.kids_room_humidity", "48", {"unit_of_measurement": "%", "device_class": "humidity", "state_class": "measurement"}, {}),
    ]),
    ("d_b_fan", "Extractor Fan", "bathroom", "Shelly", "1PM", [
        ("switch.extractor_fan", "off", {}, {}),
    ]),
    ("d_b_leak", "Leak Sensor", "bathroom", "Aqara", "Water Leak", [
        ("binary_sensor.bathroom_leak", "off", {"device_class": "moisture"}, {}),
    ]),
    ("d_o_desk", "Desk Lamp", "office", "Govee", "Glide", [
        ("light.desk_lamp", "on", {**LIGHT_COLOR, "color_mode": "hs", "hs_color": [200, 80]}, {}),
    ]),
    ("d_o_pc", "Workstation", "office", "Custom", "PC", [
        ("switch.workstation", "on", {}, {}),
        ("sensor.workstation_cpu", "23", {"unit_of_measurement": "%", "state_class": "measurement"}, {}),
    ]),
    ("d_l_washer", "Washing Machine", "laundry", "Miele", "W1", [
        ("sensor.washing_machine_status", "running", {}, {}),
        ("sensor.washing_machine_remaining", "37", {"unit_of_measurement": "min", "device_class": "duration"}, {}),
    ]),
    ("d_w_vac", "Robot Vacuum", "workshop", "Roborock", "S8", [
        ("vacuum.robot", "docked", {"fan_speed": "balanced", "fan_speed_list": ["quiet", "balanced", "turbo", "max"], "battery_level": 100}, {}),
    ]),
    ("d_gd_sprinkler", "Sprinklers", "garden", "Rachio", "Gen 3", [
        ("valve.sprinkler_zone_1", "closed", {}, {}),
        ("switch.sprinkler_zone_2", "off", {}, {}),
    ]),
    ("d_gd_cam", "Porch Camera", "garden", "Reolink", "RLC-510A", [
        ("camera.porch_camera", "idle", {
            "entity_picture": "/api/camera_proxy/camera.porch_camera?token=demo",
            "supported_features": 2, "brand": "Reolink", "frontend_stream_type": "hls",
        }, {}),
    ]),
    ("d_alarm", "Alarm Panel", "hallway", "Ring", "Alarm Pro", [
        ("alarm_control_panel.home", "armed_home", {"code_format": None, "code_arm_required": False}, {}),
    ]),
]

LOOSE = [
    ("scene.movie_night", "living_room", "unknown", {"friendly_name": "Movie Night", "icon": "mdi:movie-open"}),
    ("script.good_morning", "master_bedroom", "off", {"friendly_name": "Good Morning", "icon": "mdi:weather-sunset-up"}),
    ("input_boolean.guest_mode", "hallway", "off", {"friendly_name": "Guest Mode", "icon": "mdi:account-multiple"}),
]

SERVICES: dict[str, list[str]] = {
    "light": ["turn_on", "turn_off", "toggle"],
    "switch": ["turn_on", "turn_off", "toggle"],
    "fan": ["turn_on", "turn_off", "toggle", "set_percentage", "oscillate", "set_preset_mode"],
    "cover": ["open_cover", "close_cover", "stop_cover", "set_cover_position", "toggle"],
    "climate": ["set_temperature", "set_hvac_mode", "set_preset_mode", "set_fan_mode", "turn_on", "turn_off"],
    "media_player": ["media_play_pause", "media_play", "media_pause", "media_next_track", "media_previous_track", "volume_set", "volume_mute", "select_source", "turn_on", "turn_off"],
    "lock": ["lock", "unlock", "open"],
    "select": ["select_option"],
    "number": ["set_value"],
    "button": ["press"],
    "scene": ["turn_on"],
    "script": ["turn_on", "turn_off"],
    "input_boolean": ["turn_on", "turn_off", "toggle"],
    "vacuum": ["start", "pause", "stop", "return_to_base", "locate", "set_fan_speed"],
    "valve": ["open_valve", "close_valve", "toggle"],
    "alarm_control_panel": ["alarm_arm_home", "alarm_arm_away", "alarm_arm_night", "alarm_disarm"],
    "homeassistant": ["update_entity"],
}
REQUIRED = {"set_percentage", "set_preset_mode", "set_temperature", "set_hvac_mode", "set_fan_mode",
            "volume_set", "volume_mute", "select_source", "select_option", "set_value", "set_cover_position",
            "set_fan_speed", "oscillate"}


def _png(width: int, height: int, t: float) -> bytes:
    """A tiny moving test picture (sky, ground and a sweeping bar), as PNG."""
    bar = int((t * 60) % width)
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            if abs(x - bar) < 6:
                row += bytes((255, 255, 255))
            elif y > height * 0.7:
                row += bytes((46, 157, 87))
            else:
                k = y / height
                row += bytes((int(40 + 60 * k), int(110 + 60 * k), int(200 + 40 * k)))
        rows.append(bytes(row))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")


# Which (fake) integration each manufacturer's devices come from.
DEMO_INTEGRATIONS = {
    "Philips": ("hue", "Philips Hue"), "IKEA": ("zha", "Zigbee Home Automation"),
    "Aqara": ("zha", "Zigbee Home Automation"), "Shelly": ("shelly", "Shelly"), "Sonos": ("sonos", "Sonos"),
    "LG": ("webostv", "LG webOS TV"), "ecobee": ("ecobee", "ecobee"), "Somfy": ("somfy_mylink", "Somfy MyLink"),
    "Bosch": ("home_connect", "Home Connect"), "Nuki": ("nuki", "Nuki"), "Meross": ("meross", "Meross"),
    "Wallbox": ("wallbox", "Wallbox"), "Hunter": ("hunter", "Hunter"), "Govee": ("govee_light_local", "Govee lights local"),
    "Custom": ("mqtt", "MQTT"), "Miele": ("miele", "Miele"), "Roborock": ("roborock", "Roborock"),
    "Rachio": ("rachio", "Rachio"), "Ring": ("ring", "Ring"), "Reolink": ("reolink", "Reolink"),
}


class DemoClient:
    demo = True

    def add_routes(self, app) -> None:
        """Fake versions of Home Assistant's camera endpoints, so the camera UI can be tried in the demo."""
        from aiohttp import web

        async def snapshot(request):
            return web.Response(body=_png(320, 180, time.time()), content_type="image/png")

        async def stream(request):
            resp = web.StreamResponse(headers={"Content-Type": "multipart/x-mixed-replace; boundary=frame"})
            await resp.prepare(request)
            try:
                while True:
                    frame = _png(320, 180, time.time())
                    await resp.write(b"--frame\r\nContent-Type: image/png\r\nContent-Length: "
                                     + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                    await asyncio.sleep(0.2)
            except (ConnectionResetError, asyncio.CancelledError):
                pass
            return resp

        app.router.add_get("/api/camera_proxy/{entity_id}", snapshot)
        app.router.add_get("/api/camera_proxy_stream/{entity_id}", stream)

    def __init__(self) -> None:
        self.hub = None
        self._task: asyncio.Task | None = None
        self.floors = copy.deepcopy(FLOORS)
        self.areas = [
            {"area_id": a, "name": n, "floor_id": f, "icon": i, "aliases": [], "picture": None}
            for a, n, f, i in AREAS
        ]
        self.devices = []
        self.entities = []
        self.states: dict[str, dict] = {}
        for did, name, area, manu, model, ents in DEVICES:
            integ = DEMO_INTEGRATIONS.get(manu, ("demo", "Demo"))[0]
            self.devices.append({
                "id": did, "name": name, "name_by_user": None, "area_id": area,
                "manufacturer": manu, "model": model, "disabled_by": None,
                "config_entries": [f"entry_{integ}"], "primary_config_entry": f"entry_{integ}",
            })
            slug = name.lower().replace(" ", "_").replace("-", "_")
            for eid, state, attrs, extra in ents:
                obj = eid.split(".", 1)[1]
                if obj == slug:
                    pretty = name
                elif obj.startswith(slug + "_"):
                    pretty = f"{name} {obj[len(slug) + 1:].replace('_', ' ').title()}"
                else:
                    pretty = obj.replace("_", " ").title()
                self._add(eid, did, None, state, {"friendly_name": pretty, **attrs}, extra)
        for eid, area, state, attrs in LOOSE:
            self._add(eid, None, area, state, attrs, {})

    def _add(self, eid, device_id, area_id, state, attrs, extra) -> None:
        self.entities.append({
            "entity_id": eid, "device_id": device_id, "area_id": area_id,
            "disabled_by": None, "hidden_by": None, "entity_category": None,
            "icon": None, "name": None, "original_name": None, **extra,
        })
        attrs = {k: v for k, v in attrs.items() if v is not None or k == "brightness"}
        self.states[eid] = {
            "entity_id": eid, "state": state, "attributes": attrs,
            "last_changed": _now(), "last_updated": _now(),
        }

    async def start(self, hub) -> None:
        self.hub = hub
        await hub.refresh()
        hub.set_connected(True)
        self._task = asyncio.create_task(self._drift())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _drift(self) -> None:
        """Make sensors wander so the UI has live updates to show."""
        while True:
            await asyncio.sleep(4)
            for eid, st in self.states.items():
                if eid.startswith("sensor.") and st["attributes"].get("state_class") == "measurement":
                    try:
                        val = float(st["state"])
                    except ValueError:
                        continue
                    val += random.uniform(-0.3, 0.3) * max(1, abs(val) * 0.02)
                    self._set(eid, f"{val:.1f}")
            if random.random() < 0.2:
                motion = self.states["binary_sensor.hallway_motion"]
                self._set("binary_sensor.hallway_motion", "off" if motion["state"] == "on" else "on")

    def _set(self, eid: str, state: str | None = None, **attrs: Any) -> None:
        old = self.states[eid]
        new = copy.deepcopy(old)
        if state is not None and state != old["state"]:
            new["state"] = state
            new["last_changed"] = _now()
        new["attributes"].update(attrs)
        new["last_updated"] = _now()
        self.states[eid] = new
        if self.hub:
            self.hub.on_event({
                "event_type": "state_changed",
                "data": {"entity_id": eid, "old_state": old, "new_state": new},
            })

    async def call(self, msg_type: str, **kw: Any) -> Any:
        if msg_type == "config/floor_registry/list":
            return copy.deepcopy(self.floors)
        if msg_type == "config/area_registry/list":
            return copy.deepcopy(self.areas)
        if msg_type == "config/device_registry/list":
            return copy.deepcopy(self.devices)
        if msg_type == "config/entity_registry/list":
            return copy.deepcopy(self.entities)
        if msg_type == "get_states":
            return copy.deepcopy(list(self.states.values()))
        if msg_type == "config_entries/get":
            return [{"entry_id": f"entry_{d}", "domain": d, "title": n} for d, n in set(DEMO_INTEGRATIONS.values())]
        if msg_type == "manifest/list":
            return [{"domain": d, "name": n} for d, n in set(DEMO_INTEGRATIONS.values())]
        if msg_type == "get_config":
            return {"location_name": "Demo House"}
        if msg_type == "get_services":
            return {
                d: {s: {"name": s.replace("_", " ").capitalize(), "fields": {"x": {"required": True}} if s in REQUIRED else {}, "target": {}} for s in svcs}
                for d, svcs in SERVICES.items()
            }
        if msg_type == "call_service":
            self._service(kw["domain"], kw["service"], kw.get("service_data") or {}, kw["target"]["entity_id"])
            return {"context": {}}
        if msg_type == "camera/stream":
            raise HAError("Streaming needs the stream integration, which the demo doesn't have")
        if msg_type == "history/history_during_period":
            return self._history(kw["entity_ids"][0], kw["start_time"])
        raise HAError(f"Demo does not support {msg_type}")

    def _history(self, eid: str, start_iso: str) -> dict:
        st = self.states.get(eid)
        if not st:
            return {}
        start = datetime.fromisoformat(start_iso).timestamp()
        now = time.time()
        points = []
        try:
            base = float(st["state"])
            rnd = random.Random(eid)
            val = base
            t = start
            while t < now:
                points.append({"s": f"{val:.1f}", "lu": t})
                val += rnd.uniform(-1, 1) * max(0.2, abs(base) * 0.03)
                t += 900
            points.append({"s": st["state"], "lu": now})
        except ValueError:
            rnd = random.Random(eid)
            states = ["on", "off"] if st["state"] in ("on", "off") else [st["state"], "idle"]
            t = start
            while t < now:
                points.append({"s": rnd.choice(states), "lu": t})
                t += rnd.uniform(1800, 7200)
            points.append({"s": st["state"], "lu": now})
        return {eid: points}

    def _service(self, domain: str, service: str, data: dict, eid: str) -> None:
        if eid not in self.states:
            raise HAError(f"Unknown entity {eid}")
        st = self.states[eid]
        a = st["attributes"]
        if service == "toggle":
            service = "turn_off" if st["state"] in ("on", "open", "playing") else "turn_on"
            if domain == "cover":
                service = "close_cover" if st["state"] == "open" else "open_cover"
            if domain == "valve":
                service = "close_valve" if st["state"] == "open" else "open_valve"
        if domain == "light":
            if service == "turn_off":
                return self._set(eid, "off", brightness=None)
            extra = {}
            if "brightness_pct" in data:
                extra["brightness"] = round(int(data["brightness_pct"]) * 255 / 100)
            elif a.get("brightness") is None:
                extra["brightness"] = 200
            if "color_temp_kelvin" in data:
                extra.update(color_temp_kelvin=int(data["color_temp_kelvin"]), color_mode="color_temp")
            if "hs_color" in data:
                extra.update(hs_color=data["hs_color"], color_mode="hs")
            if "effect" in data:
                extra["effect"] = data["effect"]
            return self._set(eid, "on", **extra)
        if domain in ("switch", "input_boolean", "fan", "script"):
            if service == "set_percentage":
                return self._set(eid, "on" if data.get("percentage") else "off", percentage=data.get("percentage"))
            if service == "oscillate":
                return self._set(eid, None, oscillating=bool(data.get("oscillating")))
            if service == "set_preset_mode":
                return self._set(eid, "on", preset_mode=data.get("preset_mode"))
            return self._set(eid, "on" if service == "turn_on" else "off")
        if domain == "cover":
            if service == "open_cover":
                return self._set(eid, "open", current_position=100 if "current_position" in a else None)
            if service == "close_cover":
                return self._set(eid, "closed", current_position=0 if "current_position" in a else None)
            if service == "set_cover_position":
                pos = int(data.get("position", 0))
                return self._set(eid, "open" if pos else "closed", current_position=pos)
            return None
        if domain == "valve":
            return self._set(eid, "open" if service == "open_valve" else "closed")
        if domain == "lock":
            return self._set(eid, {"lock": "locked", "unlock": "unlocked", "open": "open"}[service])
        if domain == "climate":
            if service == "set_temperature":
                return self._set(eid, None, temperature=float(data["temperature"]))
            if service == "set_hvac_mode":
                mode = data["hvac_mode"]
                action = {"heat": "heating", "cool": "cooling", "off": "off"}.get(mode, "idle")
                return self._set(eid, mode, hvac_action=action)
            if service == "set_preset_mode":
                return self._set(eid, None, preset_mode=data["preset_mode"])
            if service == "set_fan_mode":
                return self._set(eid, None, fan_mode=data["fan_mode"])
            return self._set(eid, "off" if service == "turn_off" else "heat")
        if domain == "media_player":
            if service in ("media_play_pause", "media_play", "media_pause"):
                playing = st["state"] == "playing"
                new = {"media_play_pause": "paused" if playing else "playing", "media_play": "playing", "media_pause": "paused"}[service]
                return self._set(eid, new)
            if service == "volume_set":
                return self._set(eid, None, volume_level=float(data["volume_level"]))
            if service == "volume_mute":
                return self._set(eid, None, is_volume_muted=bool(data["is_volume_muted"]))
            if service == "select_source":
                return self._set(eid, None, source=data["source"])
            if service in ("turn_on", "turn_off"):
                return self._set(eid, "idle" if service == "turn_on" else "off")
            return self._set(eid, "playing", media_title=random.choice(["Arrival", "Dune", "Tenet", "Heat"]))
        if domain == "select":
            return self._set(eid, data["option"])
        if domain == "number":
            return self._set(eid, str(data["value"]))
        if domain in ("button", "scene"):
            return self._set(eid, _now())
        if domain == "vacuum":
            new = {"start": "cleaning", "pause": "paused", "stop": "idle", "return_to_base": "returning", "locate": None}.get(service)
            if service == "set_fan_speed":
                return self._set(eid, None, fan_speed=data["fan_speed"])
            return self._set(eid, new)
        if domain == "alarm_control_panel":
            return self._set(eid, {"alarm_arm_home": "armed_home", "alarm_arm_away": "armed_away", "alarm_arm_night": "armed_night", "alarm_disarm": "disarmed"}[service])
        return None
