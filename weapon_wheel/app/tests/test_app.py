"""Tests for the Weapon Wheel backend.

Run from weapon_wheel/app:  python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="ww-test-")

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

import server  # noqa: E402
from demo import DemoClient  # noqa: E402


def registries():
    demo = DemoClient()
    return demo.floors, demo.areas, demo.devices, demo.entities, demo.states


class BuildModelTests(unittest.TestCase):
    def build(self, options=None, integrations=None, **override):
        floors, areas, devices, entities, states = registries()
        args = {"floors": floors, "areas": areas, "devices": devices, "entities": entities, "states": states}
        args.update(override)
        return server.build_model(
            args["floors"], args["areas"], args["devices"], args["entities"], args["states"],
            {"light": {"turn_on": {"name": "Turn on", "fields": {}, "target": {}}}},
            options or {},
            integrations,
        )

    def test_floors_areas_devices_entities(self):
        m = self.build()
        self.assertEqual([f["id"] for f in m["floors"]], ["upstairs", "ground", "basement", "__unassigned__"])
        self.assertEqual(m["areas"]["kitchen"]["floor_id"], "ground")
        self.assertEqual(m["areas"]["garden"]["floor_id"], "__unassigned__")
        self.assertIn("d_k_coffee", m["areas"]["kitchen"]["devices"])
        self.assertEqual(m["devices"]["d_k_coffee"]["entities"], ["switch.coffee_machine", "sensor.coffee_machine_energy"])

    def test_devices_carry_their_integration(self):
        m = self.build(integrations={"entry_shelly": ("shelly", "Shelly")})
        node = m["devices"]["d_k_coffee"]
        self.assertEqual((node["integration"], node["integration_name"]), ("shelly", "Shelly"))
        self.assertIsNone(m["devices"]["d_k_fridge"]["integration"])  # entry not known
        self.assertIsNone(m["devices"]["area:living_room"].get("integration"))

    def test_all_devices_and_unplaced_entities_for_custom_homes(self):
        m = self.build()
        self.assertEqual(m["all_devices"]["d_k_coffee"]["entities"], ["switch.coffee_machine", "sensor.coffee_machine_energy"])
        self.assertEqual(m["all_devices"]["d_k_coffee"]["area_id"], "kitchen")
        unplaced = m["entities"]["sensor.internet_download"]
        self.assertIsNone(unplaced["node"])
        self.assertIsNone(unplaced["area_id"])
        self.assertNotIn("sensor.internet_download", sum((n["entities"] for n in m["devices"].values()), []))

    def test_short_names_strip_device_name(self):
        m = self.build()
        self.assertEqual(m["entities"]["sensor.coffee_machine_energy"]["name"], "Energy")
        self.assertEqual(m["entities"]["switch.coffee_machine"]["name"], "Coffee Machine")

    def test_diagnostic_and_config_entities_included_with_category(self):
        m = self.build()
        self.assertEqual(m["entities"]["sensor.fridge_sensor_battery"]["entity_category"], "diagnostic")
        self.assertEqual(m["entities"]["switch.kitchen_spots_led_indicator"]["entity_category"], "config")

    def test_entities_without_device_get_room_node(self):
        m = self.build()
        node = m["devices"]["area:living_room"]
        self.assertTrue(node["virtual"])
        self.assertEqual(node["entities"], ["scene.movie_night"])

    def test_entity_area_override_creates_node_in_other_room(self):
        floors, areas, devices, entities, states = registries()
        for e in entities:
            if e["entity_id"] == "sensor.coffee_machine_energy":
                e["area_id"] = "garage"
        m = self.build(entities=entities)
        self.assertIn("d_k_coffee@garage", m["areas"]["garage"]["devices"])
        self.assertEqual(m["devices"]["d_k_coffee"]["entities"], ["switch.coffee_machine"])

    def test_disabled_entities_skipped(self):
        floors, areas, devices, entities, states = registries()
        for e in entities:
            if e["entity_id"] == "switch.coffee_machine":
                e["disabled_by"] = "user"
        self.assertNotIn("switch.coffee_machine", self.build(entities=entities)["entities"])

    def test_no_floors_puts_everything_in_home(self):
        m = self.build(floors=[])
        self.assertEqual(m["floors"], [{"id": "__unassigned__", "name": "Home", "level": 0, "icon": None}])
        self.assertTrue(all(a["floor_id"] == "__unassigned__" for a in m["areas"].values()))

    def test_services_only_for_used_domains(self):
        m = self.build()
        self.assertEqual(m["services"], {"light": {"turn_on": {"name": "Turn on", "required": False, "target": True}}})


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        os.environ["DEMO"] = "1"
        self.client = TestClient(TestServer(server.create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        os.environ.pop("DEMO", None)

    async def test_model(self):
        r = await self.client.get("/api/model")
        data = await r.json()
        self.assertTrue(data["connected"])
        self.assertTrue(data["demo"])
        self.assertIn("light.kitchen_spots", data["states"])

    async def test_integrations_from_home_assistant(self):
        data = await (await self.client.get("/api/model")).json()
        dev = data["model"]["devices"]["d_k_lights"]
        self.assertEqual((dev["integration"], dev["integration_name"]), ("shelly", "Shelly"))

    async def test_home_name_from_home_assistant(self):
        data = await (await self.client.get("/api/model")).json()
        self.assertEqual(data["model"]["home_name"], "Demo House")

    async def test_house_name_setting_saved(self):
        r = await self.client.put("/api/layout", json={"settings": {"houseName": "Villa Sol"}})
        self.assertEqual((await r.json())["settings"], {"houseName": "Villa Sol"})

    async def test_camera_stream_endpoint(self):
        r = await self.client.get("/api/camera_stream?entity_id=light.kitchen_spots")
        self.assertEqual(r.status, 400)
        r = await self.client.get("/api/camera_stream?entity_id=camera.porch_camera")
        self.assertEqual(r.status, 502)  # the demo has no stream integration -> browser falls back to MJPEG
        r = await self.client.get("/api/camera_proxy/camera.porch_camera")
        self.assertEqual(r.content_type, "image/png")

    async def test_index_served(self):
        r = await self.client.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn("app.js", await r.text())

    async def test_assets_are_versioned_and_not_cached_stale(self):
        r = await self.client.get("/")
        html = await r.text()
        self.assertIn("no-store", r.headers["Cache-Control"])
        css = re.search(r'href="(style\.css\?v=[0-9a-f]{10})"', html)
        js = re.search(r'src="(app\.js\?v=[0-9a-f]{10})"', html)
        self.assertTrue(css and js, html[:400])
        r = await self.client.get("/" + css.group(1))
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["Cache-Control"], "no-cache")
        r = await self.client.get("/" + js.group(1))
        self.assertEqual(r.headers["Cache-Control"], "no-cache")

    async def test_call_service_and_state_push(self):
        ws = await self.client.ws_connect("/api/ws")
        self.assertEqual((await ws.receive_json())["type"], "status")
        r = await self.client.post("/api/call", json={"domain": "light", "service": "turn_off", "entity_id": "light.kitchen_spots"})
        self.assertEqual(r.status, 200)
        while True:
            msg = await asyncio.wait_for(ws.receive_json(), 3)
            if msg["type"] == "states" and "light.kitchen_spots" in msg["states"]:
                break
        self.assertEqual(msg["states"]["light.kitchen_spots"]["state"], "off")
        await ws.close()

    async def test_call_validation(self):
        for body in (
            {"domain": "light; rm", "service": "turn_on", "entity_id": "light.x"},
            {"domain": "light", "service": "turn_on", "entity_id": "not an entity"},
            {"domain": "light", "service": "turn_on", "entity_id": "light.x", "data": [1]},
        ):
            r = await self.client.post("/api/call", json=body)
            self.assertEqual(r.status, 400, body)

    async def test_custom_home_saved(self):
        custom = {"enabled": True, "levels": [{"id": "l1", "name": "Main", "level": 0, "outdoor": False}],
                  "rooms": [{"id": "r1", "name": "Cinema", "icon": "mdi:sofa", "level": "l1", "plan": {"c": 0, "r": 0, "w": 4, "h": 2},
                             "members": [{"kind": "device", "id": "d_lr_tv", "group": None}], "groups": []}]}
        r = await self.client.put("/api/layout", json={"custom": custom})
        self.assertEqual((await r.json())["custom"], custom)

    async def test_layout_roundtrip(self):
        layout = {"areas": {"kitchen": {"name": "Cook", "hidden": True}}, "junk": 1, "devices": "bad"}
        r = await self.client.put("/api/layout", json=layout)
        saved = await r.json()
        self.assertEqual(saved["areas"], {"kitchen": {"name": "Cook", "hidden": True}})
        self.assertEqual(saved["devices"], {})
        self.assertNotIn("junk", saved)
        on_disk = json.loads((Path(os.environ["DATA_DIR"]) / "layout.json").read_text())
        self.assertEqual(on_disk, saved)

    async def test_history(self):
        r = await self.client.get("/api/history?entity_id=sensor.living_room_temperature&hours=6")
        data = await r.json()
        self.assertGreater(len(data["points"]), 5)
        r = await self.client.get("/api/history?entity_id=../../etc")
        self.assertEqual(r.status, 400)


class CameraStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_hls_url_from_home_assistant(self):
        os.environ["DEMO"] = "1"
        try:
            app = server.create_app()
            client = TestClient(TestServer(app))
            await client.start_server()
            hub = app[server.HUB]
            real_call = hub.client.call
            calls = []

            async def fake_call(msg_type, **kw):
                if msg_type == "camera/stream":
                    calls.append(kw)
                    return {"url": "/api/hls/abc/master_playlist.m3u8"}
                return await real_call(msg_type, **kw)

            hub.client.call = fake_call
            r = await client.get("/api/camera_stream?entity_id=camera.porch_camera")
            self.assertEqual(await r.json(), {"url": "/api/hls/abc/master_playlist.m3u8"})
            self.assertEqual(calls, [{"entity_id": "camera.porch_camera", "format": "hls"}])
            await client.close()
        finally:
            os.environ.pop("DEMO", None)


class MockHomeAssistant:
    """Minimal Home Assistant WebSocket API backed by the demo data."""

    def __init__(self):
        self.demo = DemoClient()
        self.subs: list[tuple[web.WebSocketResponse, int]] = []
        app = web.Application()
        app.router.add_get("/api/websocket", self.handle)
        self.server = TestServer(app)
        outer = self

        class Relay:
            def on_event(self, ev):
                for ws, sid in outer.subs:
                    asyncio.ensure_future(ws.send_json({"id": sid, "type": "event", "event": ev}))

        self.demo.hub = Relay()

    async def handle(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "auth_required"})
        auth = await ws.receive_json()
        if auth.get("access_token") != "secret":
            await ws.send_json({"type": "auth_invalid", "message": "Invalid access token"})
            await ws.close()
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": "test"})
        async for raw in ws:
            req = json.loads(raw.data)
            mid, mtype = req.pop("id"), req.pop("type")
            if mtype == "subscribe_events":
                if req["event_type"] == "state_changed":
                    self.subs.append((ws, mid))
                result = {"id": mid, "type": "result", "success": True, "result": None}
            else:
                try:
                    result = {"id": mid, "type": "result", "success": True, "result": await self.demo.call(mtype, **req)}
                except Exception as err:  # noqa: BLE001
                    result = {"id": mid, "type": "result", "success": False, "error": {"code": "err", "message": str(err)}}
            # Real Home Assistant may coalesce messages into a JSON list
            await ws.send_json([result] if mid % 2 else result)
        return ws


class HAClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_connects_discovers_and_calls_services(self):
        mock = MockHomeAssistant()
        await mock.server.start_server()
        try:
            client = server.HAClient(str(mock.server.make_url("/api/websocket")).replace("http", "ws"), "secret")
            hub = server.Hub(client, dict(server.DEFAULT_OPTIONS))
            await client.start(hub)
            for _ in range(50):
                if hub.connected:
                    break
                await asyncio.sleep(0.05)
            self.assertTrue(hub.connected)
            self.assertIn("light.kitchen_spots", hub.model["entities"])
            await client.call("call_service", domain="light", service="turn_off",
                              service_data={}, target={"entity_id": "light.kitchen_spots"})
            for _ in range(50):
                if hub.states["light.kitchen_spots"]["state"] == "off":
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(hub.states["light.kitchen_spots"]["state"], "off")
            with self.assertRaises(server.HAError):
                await client.call("call_service", domain="light", service="turn_on",
                                  service_data={}, target={"entity_id": "light.missing"})
            await client.stop()
        finally:
            await mock.server.close()

    async def test_bad_token_does_not_connect(self):
        mock = MockHomeAssistant()
        await mock.server.start_server()
        try:
            client = server.HAClient(str(mock.server.make_url("/api/websocket")).replace("http", "ws"), "wrong")
            hub = server.Hub(client, dict(server.DEFAULT_OPTIONS))
            await client.start(hub)
            await asyncio.sleep(0.4)
            self.assertFalse(hub.connected)
            self.assertIsNone(hub.model)
            await client.stop()
        finally:
            await mock.server.close()


class IngressGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_access_refused_when_running_as_addon(self):
        os.environ["DEMO"] = "1"
        os.environ["SUPERVISOR_TOKEN"] = "x"
        old = server.INGRESS_PEERS
        server.INGRESS_PEERS = {"172.30.32.2"}  # the test client connects from 127.0.0.1
        try:
            client = TestClient(TestServer(server.create_app()))
            await client.start_server()
            r = await client.get("/api/model")
            self.assertEqual(r.status, 403)
            await client.close()
        finally:
            server.INGRESS_PEERS = old
            os.environ.pop("SUPERVISOR_TOKEN")
            os.environ.pop("DEMO")


if __name__ == "__main__":
    unittest.main()
