#!/usr/bin/env python3
"""Weapon Wheel dashboard backend.

Connects to Home Assistant's WebSocket API (through the Supervisor proxy when
running as an add-on), discovers floors -> areas -> devices -> entities, and
serves the dashboard frontend over Ingress. State changes are pushed to the
browser over a WebSocket; user customizations live in /data/layout.json.

Local development:
    HA_URL=http://homeassistant.local:8123 HA_TOKEN=<long-lived token> python3 server.py
    DEMO=1 python3 server.py            # fake house, no Home Assistant needed
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from errors import HAError

LOG = logging.getLogger("weapon_wheel")

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
OPTIONS_FILE = DATA_DIR / "options.json"
LAYOUT_FILE = DATA_DIR / "layout.json"
PORT = int(os.environ.get("PORT", "8099"))

DEFAULT_OPTIONS = {
    "show_diagnostic_entities": False,
    "show_hidden_entities": False,
    "accent_color": "",
}
LAYOUT_SECTIONS = ("floors", "areas", "devices", "entities", "settings")
REGISTRY_EVENTS = (
    "area_registry_updated",
    "device_registry_updated",
    "entity_registry_updated",
    "floor_registry_updated",
)
SLUG_RE = re.compile(r"^[a-z0-9_]+$")
ENTITY_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        LOG.exception("Could not read %s", path)
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(path)


# --------------------------------------------------------------------------
# Home Assistant WebSocket client
# --------------------------------------------------------------------------
class HAClient:
    demo = False

    def __init__(self, ws_url: str, token: str) -> None:
        self.ws_url = ws_url
        self.token = token
        self.hub: Hub | None = None
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._session: aiohttp.ClientSession | None = None
        self._task: asyncio.Task | None = None

    async def start(self, hub: "Hub") -> None:
        self.hub = hub
        self._session = aiohttp.ClientSession()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self._session:
            await self._session.close()

    async def _run(self) -> None:
        delay = 2
        while True:
            try:
                await self._connect_once()
                delay = 2
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - reconnect on anything
                LOG.warning("Home Assistant connection error: %s", err)
            self.ws = None
            self._fail_pending()
            assert self.hub
            self.hub.set_connected(False)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def _connect_once(self) -> None:
        assert self._session and self.hub
        async with self._session.ws_connect(
            self.ws_url, heartbeat=30, max_msg_size=0
        ) as ws:
            msg = await ws.receive_json()
            if msg.get("type") != "auth_required":
                raise HAError(f"Unexpected handshake: {msg}")
            await ws.send_json({"type": "auth", "access_token": self.token})
            msg = await ws.receive_json()
            if msg.get("type") != "auth_ok":
                raise HAError(f"Authentication failed: {msg.get('message', msg)}")
            LOG.info("Connected to Home Assistant %s", msg.get("ha_version", ""))
            self.ws = ws
            reader = asyncio.create_task(self._reader(ws))
            try:
                await self.call("subscribe_events", event_type="state_changed")
                for event_type in REGISTRY_EVENTS:
                    await self.call("subscribe_events", event_type=event_type)
                await self.hub.refresh()
                self.hub.set_connected(True)
                await reader
            finally:
                reader.cancel()

    async def _reader(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
                continue
            data = json.loads(msg.data)
            for item in data if isinstance(data, list) else [data]:
                self._dispatch(item)

    def _dispatch(self, item: dict) -> None:
        kind = item.get("type")
        if kind == "result":
            fut = self._pending.get(item.get("id"))
            if fut and not fut.done():
                fut.set_result(item)
        elif kind == "event" and self.hub:
            self.hub.on_event(item.get("event", {}))

    def _fail_pending(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(HAError("Connection to Home Assistant lost"))
        self._pending.clear()

    async def call(self, msg_type: str, **payload: Any) -> Any:
        if self.ws is None:
            raise HAError("Not connected to Home Assistant")
        self._id += 1
        msg_id = self._id
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        try:
            await self.ws.send_json({"id": msg_id, "type": msg_type, **payload})
            res = await asyncio.wait_for(fut, 30)
        finally:
            self._pending.pop(msg_id, None)
        if not res.get("success"):
            err = res.get("error") or {}
            raise HAError(err.get("message") or err.get("code") or "Unknown error")
        return res.get("result")


# --------------------------------------------------------------------------
# Model building
# --------------------------------------------------------------------------
def build_model(
    floors: list[dict],
    areas: list[dict],
    devices: list[dict],
    entities: list[dict],
    states: dict[str, dict],
    services: dict[str, dict],
    options: dict,
) -> dict:
    """Turn the raw registries into the floor > area > device > entity tree."""
    show_diag = options.get("show_diagnostic_entities", False)
    show_hidden = options.get("show_hidden_entities", False)

    dev_by_id = {d["id"]: d for d in devices}
    area_by_id = {a["area_id"]: a for a in areas}
    floor_ids = {f["floor_id"] for f in floors}

    nodes: dict[str, dict] = {}
    area_nodes: dict[str, list[str]] = defaultdict(list)
    out_entities: dict[str, dict] = {}

    def node_for(area_id: str, dev: dict | None) -> dict:
        if dev is None:
            nid = f"area:{area_id}"
            if nid not in nodes:
                nodes[nid] = {
                    "id": nid,
                    "device_id": None,
                    "name": "Room entities",
                    "manufacturer": None,
                    "model": None,
                    "area_id": area_id,
                    "virtual": True,
                    "entities": [],
                }
                area_nodes[area_id].append(nid)
            return nodes[nid]
        # A device's entities can be assigned to different areas; such entities
        # get their own node in that area so the device shows in both rooms.
        nid = dev["id"] if dev.get("area_id") == area_id else f"{dev['id']}@{area_id}"
        if nid not in nodes:
            nodes[nid] = {
                "id": nid,
                "device_id": dev["id"],
                "name": dev.get("name_by_user") or dev.get("name") or "Unnamed device",
                "manufacturer": dev.get("manufacturer"),
                "model": dev.get("model"),
                "area_id": area_id,
                "virtual": False,
                "entities": [],
            }
            area_nodes[area_id].append(nid)
        return nodes[nid]

    for ent in entities:
        if ent.get("disabled_by"):
            continue
        if ent.get("hidden_by") and not show_hidden:
            continue
        if ent.get("entity_category") and not show_diag:
            continue
        eid = ent["entity_id"]
        st = states.get(eid)
        if st is None:
            continue
        dev = dev_by_id.get(ent.get("device_id"))
        if dev and dev.get("disabled_by"):
            continue
        area_id = ent.get("area_id") or (dev or {}).get("area_id")
        if not area_id or area_id not in area_by_id:
            continue
        node = node_for(area_id, dev)
        attrs = st.get("attributes", {})
        full_name = attrs.get("friendly_name") or ent.get("name") or ent.get("original_name") or eid
        short = full_name
        if not node["virtual"]:
            dev_name = node["name"]
            if full_name.lower().startswith(dev_name.lower()) and len(full_name) > len(dev_name):
                short = full_name[len(dev_name):].strip(" -:_") or full_name
        out_entities[eid] = {
            "entity_id": eid,
            "domain": eid.split(".", 1)[0],
            "name": short,
            "full_name": full_name,
            "icon": ent.get("icon") or attrs.get("icon"),
            "device_class": attrs.get("device_class"),
            "entity_category": ent.get("entity_category"),
            "node": node["id"],
            "area_id": area_id,
        }
        node["entities"].append(eid)

    out_areas = {}
    for a in areas:
        fid = a.get("floor_id") if a.get("floor_id") in floor_ids else "__unassigned__"
        out_areas[a["area_id"]] = {
            "id": a["area_id"],
            "name": a.get("name") or a["area_id"],
            "icon": a.get("icon"),
            "floor_id": fid,
            "devices": area_nodes.get(a["area_id"], []),
        }

    out_floors = [
        {
            "id": f["floor_id"],
            "name": f.get("name") or f["floor_id"],
            "level": f.get("level"),
            "icon": f.get("icon"),
        }
        for f in floors
    ]
    if any(a["floor_id"] == "__unassigned__" for a in out_areas.values()):
        out_floors.append(
            {
                "id": "__unassigned__",
                "name": "Unassigned rooms" if floors else "Home",
                "level": None if floors else 0,
                "icon": None,
            }
        )

    domains = {e["domain"] for e in out_entities.values()}
    out_services = {}
    for domain, svcs in services.items():
        if domain not in domains:
            continue
        out_services[domain] = {
            name: {
                "name": spec.get("name") or name,
                "required": any(
                    isinstance(f, dict) and f.get("required")
                    for f in (spec.get("fields") or {}).values()
                ),
                "target": "target" in spec,
            }
            for name, spec in svcs.items()
        }

    return {
        "floors": out_floors,
        "areas": out_areas,
        "devices": nodes,
        "entities": out_entities,
        "services": out_services,
    }


# --------------------------------------------------------------------------
# Hub: shared state + browser fan-out
# --------------------------------------------------------------------------
class Hub:
    def __init__(self, client: Any, options: dict) -> None:
        self.client = client
        self.options = options
        self.layout = self._clean_layout(load_json(LAYOUT_FILE, {}))
        self.model: dict | None = None
        self.states: dict[str, dict] = {}
        self.connected = False
        self.sockets: set[web.WebSocketResponse] = set()
        self._refresh_lock = asyncio.Lock()
        self._refresh_handle: asyncio.TimerHandle | None = None
        self._pending_states: dict[str, Any] = {}
        self._flush_handle: asyncio.TimerHandle | None = None

    @staticmethod
    def _clean_layout(layout: Any) -> dict:
        if not isinstance(layout, dict):
            layout = {}
        return {k: layout.get(k) if isinstance(layout.get(k), dict) else {} for k in LAYOUT_SECTIONS}

    async def refresh(self) -> None:
        async with self._refresh_lock:
            try:
                floors = await self.client.call("config/floor_registry/list")
            except HAError:
                floors = []  # Home Assistant older than 2024.4 has no floors
            areas, devices, entities, states, services = await asyncio.gather(
                self.client.call("config/area_registry/list"),
                self.client.call("config/device_registry/list"),
                self.client.call("config/entity_registry/list"),
                self.client.call("get_states"),
                self.client.call("get_services"),
            )
            try:
                config = await self.client.call("get_config")
            except HAError:
                config = {}
            self.states = {s["entity_id"]: s for s in states}
            self.model = build_model(
                floors, areas, devices, entities, self.states, services, self.options
            )
            # Default name of the house: the home name from Settings -> System -> General
            self.model["home_name"] = (config or {}).get("location_name") or None
            LOG.info(
                "Discovered %d floors, %d areas, %d devices, %d entities",
                len(self.model["floors"]),
                len(self.model["areas"]),
                len(self.model["devices"]),
                len(self.model["entities"]),
            )
        await self.broadcast({"type": "model"})

    def set_connected(self, value: bool) -> None:
        if self.connected != value:
            self.connected = value
            asyncio.ensure_future(self.broadcast({"type": "status", "connected": value}))

    def on_event(self, event: dict) -> None:
        etype = event.get("event_type")
        if etype == "state_changed":
            data = event.get("data", {})
            eid = data.get("entity_id")
            new = data.get("new_state")
            if new is None:
                self.states.pop(eid, None)
            else:
                self.states[eid] = new
            if self.model and eid in self.model["entities"]:
                self._pending_states[eid] = new
                if self._flush_handle is None:
                    self._flush_handle = asyncio.get_running_loop().call_later(
                        0.1, self._flush_states
                    )
        elif etype in REGISTRY_EVENTS:
            if self._refresh_handle:
                self._refresh_handle.cancel()
            self._refresh_handle = asyncio.get_running_loop().call_later(
                1.5, lambda: asyncio.ensure_future(self._safe_refresh())
            )

    async def _safe_refresh(self) -> None:
        try:
            await self.refresh()
        except Exception:  # noqa: BLE001
            LOG.exception("Refreshing registries failed")

    def _flush_states(self) -> None:
        self._flush_handle = None
        batch, self._pending_states = self._pending_states, {}
        asyncio.ensure_future(self.broadcast({"type": "states", "states": batch}))

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_json(msg)
            except (ConnectionError, RuntimeError):
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)

    def snapshot(self) -> dict:
        model = self.model
        states = {}
        if model:
            states = {eid: self.states[eid] for eid in model["entities"] if eid in self.states}
        return {
            "model": model,
            "states": states,
            "layout": self.layout,
            "connected": self.connected,
            "demo": getattr(self.client, "demo", False),
            "options": {"accent_color": self.options.get("accent_color")},
        }

    async def save_layout(self, layout: Any) -> dict:
        self.layout = self._clean_layout(layout)
        save_json(LAYOUT_FILE, self.layout)
        await self.broadcast({"type": "layout", "layout": self.layout})
        return self.layout


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
HUB = web.AppKey("hub", Hub)

def json_error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


async def handle_index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


async def handle_model(request: web.Request) -> web.Response:
    hub: Hub = request.app[HUB]
    return web.json_response(hub.snapshot())


async def handle_layout_put(request: web.Request) -> web.Response:
    hub: Hub = request.app[HUB]
    try:
        body = await request.json()
    except ValueError:
        return json_error(400, "Invalid JSON")
    if not isinstance(body, dict):
        return json_error(400, "Layout must be an object")
    return web.json_response(await hub.save_layout(body))


async def handle_call(request: web.Request) -> web.Response:
    hub: Hub = request.app[HUB]
    try:
        body = await request.json()
    except ValueError:
        return json_error(400, "Invalid JSON")
    domain = str(body.get("domain", ""))
    service = str(body.get("service", ""))
    entity_id = str(body.get("entity_id", ""))
    data = body.get("data") or {}
    if not SLUG_RE.match(domain) or not SLUG_RE.match(service):
        return json_error(400, "Invalid domain or service")
    if not ENTITY_RE.match(entity_id):
        return json_error(400, "Invalid entity_id")
    if not isinstance(data, dict):
        return json_error(400, "data must be an object")
    try:
        await hub.client.call(
            "call_service",
            domain=domain,
            service=service,
            service_data=data,
            target={"entity_id": entity_id},
        )
    except HAError as err:
        return json_error(502, str(err))
    except asyncio.TimeoutError:
        return json_error(504, "Home Assistant did not respond")
    return web.json_response({"ok": True})


async def handle_history(request: web.Request) -> web.Response:
    hub: Hub = request.app[HUB]
    entity_id = request.query.get("entity_id", "")
    if not ENTITY_RE.match(entity_id):
        return json_error(400, "Invalid entity_id")
    try:
        hours = max(1, min(int(request.query.get("hours", "24")), 168))
    except ValueError:
        hours = 24
    start = datetime.now(timezone.utc) - timedelta(hours=hours)
    try:
        result = await hub.client.call(
            "history/history_during_period",
            start_time=start.isoformat(),
            entity_ids=[entity_id],
            minimal_response=True,
            no_attributes=True,
            significant_changes_only=False,
        )
    except (HAError, asyncio.TimeoutError) as err:
        return json_error(502, str(err))
    points = [
        {"s": p.get("s"), "t": p.get("lu") or p.get("lc")}
        for p in (result or {}).get(entity_id, [])
    ]
    return web.json_response({"entity_id": entity_id, "start": start.timestamp(), "points": points})


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    hub: Hub = request.app[HUB]
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    hub.sockets.add(ws)
    try:
        await ws.send_json({"type": "status", "connected": hub.connected})
        async for _msg in ws:
            pass  # client -> server traffic is not used
    finally:
        hub.sockets.discard(ws)
    return ws


def make_client() -> Any:
    if os.environ.get("DEMO"):
        from demo import DemoClient

        LOG.info("Running in DEMO mode with a fake house")
        return DemoClient()
    token = os.environ.get("SUPERVISOR_TOKEN")
    if token:
        return HAClient("ws://supervisor/core/websocket", token)
    url = os.environ.get("HA_URL")
    token = os.environ.get("HA_TOKEN")
    if url and token:
        ws_url = re.sub(r"^http", "ws", url.rstrip("/")) + "/api/websocket"
        return HAClient(ws_url, token)
    from demo import DemoClient

    LOG.warning("No SUPERVISOR_TOKEN or HA_URL/HA_TOKEN set, falling back to DEMO mode")
    return DemoClient()


async def on_startup(app: web.Application) -> None:
    await app[HUB].client.start(app[HUB])


async def on_cleanup(app: web.Application) -> None:
    for ws in list(app[HUB].sockets):
        await ws.close()
    await app[HUB].client.stop()


# Home Assistant's ingress proxy always connects from this address.
INGRESS_PEERS = {"172.30.32.2", "127.0.0.1", "::1"}


@web.middleware
async def ingress_only(request: web.Request, handler):
    """When running as an add-on, refuse anything that doesn't come through Ingress."""
    if request.remote not in INGRESS_PEERS:
        LOG.warning("Refused direct request from %s", request.remote)
        return json_error(403, "Open this dashboard from the Home Assistant sidebar")
    return await handler(request)


def create_app() -> web.Application:
    options = {**DEFAULT_OPTIONS, **load_json(OPTIONS_FILE, {})}
    hub = Hub(make_client(), options)
    middlewares = [ingress_only] if os.environ.get("SUPERVISOR_TOKEN") else []
    app = web.Application(middlewares=middlewares)
    app[HUB] = hub
    app.router.add_get("/", handle_index)
    app.router.add_get("/api/model", handle_model)
    app.router.add_put("/api/layout", handle_layout_put)
    app.router.add_post("/api/call", handle_call)
    app.router.add_get("/api/history", handle_history)
    app.router.add_get("/api/ws", handle_ws)
    app.router.add_static("/", STATIC_DIR, show_index=False)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    web.run_app(create_app(), host="0.0.0.0", port=PORT, access_log=None)
