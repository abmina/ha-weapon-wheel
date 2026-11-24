/* Weapon Wheel dashboard — vanilla JS, no build step. */
(() => {
'use strict';

// ===================================================================
// Utilities
// ===================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SVGNS = 'http://www.w3.org/2000/svg';

// Let replaceChildren skip null/false like h() does, so `cond ? el : null` never renders the text "null".
const nativeReplaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function replaceChildren(...kids) {
  return nativeReplaceChildren.apply(this, kids.filter((k) => k != null && k !== false));
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const mdiClass = (icon) => {
  if (!icon) return 'mdi-help-circle-outline';
  const m = /^(?:mdi|hass):(.+)$/.exec(icon);
  if (m) return `mdi-${m[1]}`;
  if (!icon.includes(':')) return `mdi-${icon}`;
  return 'mdi-shape-outline';
};
const ico = (icon, cls = '') => h('i', { class: `mdi ${mdiClass(icon)} ${cls}` });
const cap = (t) => (t ? String(t).charAt(0).toUpperCase() + String(t).slice(1) : '');
const pretty = (t) => cap(String(t ?? '').replace(/_/g, ' '));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function toast(msg, kind = '', action = null) {
  const el = h('div', { class: `toast ${kind}` }, h('span', {}, msg));
  if (action) el.append(h('button', { onclick: () => { action.fn(); el.remove(); } }, action.label));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 6000 : 4000);
}

function rel(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts * 1000 : Date.parse(ts);
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

// ===================================================================
// State
// ===================================================================
const S = {
  model: null,
  states: {},
  layout: { floors: {}, areas: {}, devices: {}, entities: {}, settings: {} },
  demo: false,
  connected: false,
  nav: { level: 'house', areaId: null, nodeId: null, entityId: null },
  interacting: false,
  history: {},
  houseFocus: -1,
  rooms: [],
};
/** The structure being shown: the custom home when one is enabled, else the one built from Home Assistant. */
const M = () => S.view || S.model;
/** Last time someone used the dashboard (for the idle timer: back to the house after a while). */
let lastActivity = Date.now();
function markActive() { lastActivity = Date.now(); }
/** Run fn against the automatic (Home Assistant) structure, whatever is on screen. */
function withReal(fn) {
  const saved = S.view;
  S.view = null;
  try { return fn(); } finally { S.view = saved; }
}
const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

/**
 * Turns a custom home definition into the same shape as the model built from Home Assistant
 * (floors, areas, devices, entities), so the house, wheels and sidebar work unchanged.
 *   custom = { enabled, levels: [{id, name, level, outdoor, icon}],
 *              rooms: [{id, name, icon, level, plan: {c, r, w, h} | null,
 *                       members: [{kind: 'device'|'entity', id, group}], groups: [{id, name, icon}]}] }
 */
function buildCustomModel(real, def) {
  const floors = (def.levels || []).map((l) => ({
    id: l.id, name: l.name || 'Level', level: Number(l.level) || 0, icon: l.icon || null, outdoor: !!l.outdoor,
  }));
  const levelIds = new Set(floors.map((f) => f.id));
  const areas = {}, devices = {}, entities = { ...real.entities };
  for (const room of def.rooms || []) {
    if (!levelIds.has(room.level)) continue;
    const aid = room.id;
    areas[aid] = {
      id: aid, name: room.name || 'Room', icon: room.icon || null, floor_id: room.level,
      plan: room.plan || null, groups: room.groups || [], devices: [],
    };
    for (const m of room.members || []) {
      let node = null;
      if (m.kind === 'device') {
        const d = real.all_devices?.[m.id];
        if (!d) continue;
        node = {
          id: `${aid}/${m.id}`, device_id: m.id, name: d.name, manufacturer: d.manufacturer, model: d.model,
          integration: d.integration, integration_name: d.integration_name, entities: [...d.entities],
        };
      } else {
        const e = real.entities[m.id];
        if (!e) continue;
        node = { id: `${aid}/${m.id}`, device_id: null, name: e.full_name || e.name, single: true, entities: [m.id] };
      }
      Object.assign(node, { area_id: aid, virtual: false, group: m.group || null });
      if (devices[node.id]) continue; // listed twice in the same room
      devices[node.id] = node;
      areas[aid].devices.push(node.id);
      for (const eid of node.entities) {
        if (entities[eid] && entities[eid].node && devices[entities[eid].node]) continue; // keep its first room
        entities[eid] = { ...real.entities[eid], node: node.id, area_id: aid };
      }
    }
  }
  return { ...real, floors, areas, devices, entities, custom: true };
}
function refreshView() {
  const c = S.layout.custom;
  S.view = c && c.enabled && S.model ? buildCustomModel(S.model, c) : null;
}

// --- customization lookups --------------------------------------------
const L = (kind, key) => (S.layout[kind] && S.layout[kind][key]) || {};
const setting = (k) => !!(S.layout.settings || {})[k];
/** Name of the house: the dashboard's own name, else Home Assistant's home name, else "Home". */
const houseName = () => (S.layout.settings || {}).houseName || M()?.home_name || 'Home';
const devKey = (nid) => M().devices[nid]?.device_id || nid;
const isHidden = (kind, key) => !!L(kind, key).hidden;

const floorName = (f) => L('floors', f.id).name || f.name;
const areaName = (aid) => L('areas', aid).name || M().areas[aid]?.name || aid;
const devName = (nid) => {
  const d = M().devices[nid];
  return L('devices', devKey(nid)).name || (d.virtual ? `${areaName(d.area_id)} extras` : d.name);
};
const entName = (eid) => L('entities', eid).name || M().entities[eid]?.name || eid;
const domainOf = (eid) => eid.split('.', 1)[0];
const areaFloor = (aid) => L('areas', aid).floor || M().areas[aid].floor_id;
/** Rooms placed here are drawn in the garden next to the house instead of inside it. */
const OUTDOOR = '__outdoor__';
const OUTDOOR_FLOOR = { id: OUTDOOR, name: 'Outdoor', level: null, icon: 'mdi:tree', outdoor: true };
const allFloors = () => (M().custom ? M().floors : [...M().floors, OUTDOOR_FLOOR]);
/** A level is outdoor if it is the built-in Outdoor level or was marked outdoor in Customize. */
const isOutdoorFloor = (f) => !!(f.id === OUTDOOR || f.outdoor || L('floors', f.id).outdoor);

function sortAreas(ids) {
  return [...ids].sort((a, b) => {
    const oa = L('areas', a).order ?? 1e6, ob = L('areas', b).order ?? 1e6;
    return oa - ob || areaName(a).localeCompare(areaName(b));
  });
}

function visibleEntities(nid) {
  const d = M().devices[nid];
  if (!d) return [];
  return d.entities.filter((e) => !isHidden('entities', e) && S.states[e]);
}
/** Domains you operate from the wheel. Everything else (sensors, binary sensors, weather, events, updates…)
 *  and every config/diagnostic entity is listed in the device's sidebar panel instead. */
const CONTROL_DOMAINS = new Set([
  'light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'lock', 'vacuum', 'lawn_mower', 'valve',
  'water_heater', 'humidifier', 'alarm_control_panel', 'siren', 'remote', 'camera', 'scene', 'script', 'automation',
  'button', 'input_button', 'number', 'input_number', 'select', 'input_select', 'input_boolean', 'input_text', 'text',
  'input_datetime', 'date', 'time', 'datetime', 'timer', 'counter',
]);
const category = (eid) => M().entities[eid]?.entity_category || null;
const isControl = (eid) => CONTROL_DOMAINS.has(domainOf(eid)) && !category(eid);
/** Entities shown on the entity wheel. */
const controlEntities = (nid) => visibleEntities(nid).filter(isControl);
/** Entities listed in the device panel (readings, settings, diagnostics). */
const infoEntities = (nid) => visibleEntities(nid).filter((e) => !isControl(e));
/** The device's "real" entities, without config/diagnostic ones (for icons, summaries, room stats). */
function mainEntities(nid) {
  const all = visibleEntities(nid);
  const main = all.filter((e) => !category(e));
  return main.length ? main : all;
}

function visibleNodes(aid) {
  const a = M().areas[aid];
  if (!a) return [];
  return a.devices
    .filter((nid) => !isHidden('devices', devKey(nid)) && visibleEntities(nid).length)
    .sort((x, y) => {
      const vx = M().devices[x].virtual, vy = M().devices[y].virtual;
      return (vx - vy) || devName(x).localeCompare(devName(y));
    });
}
/** Floors (top-down) with their visible, ordered areas. */
function visibleFloors(includeHidden = false) {
  const m = M();
  const byFloor = {};
  for (const aid of Object.keys(m.areas)) {
    if (!includeHidden && isHidden('areas', aid)) continue;
    let fid = areaFloor(aid);
    if (!allFloors().some((f) => f.id === fid)) fid = m.areas[aid].floor_id;
    (byFloor[fid] ||= []).push(aid);
  }
  const hideEmpty = setting('hideEmptyRooms');
  return allFloors()
    .filter((f) => includeHidden || !isHidden('floors', f.id))
    .map((f) => ({
      ...f,
      outdoor: isOutdoorFloor(f),
      areas: sortAreas(byFloor[f.id] || []).filter((aid) => includeHidden || !hideEmpty || visibleNodes(aid).length),
    }))
    .filter((f) => includeHidden || f.areas.length);
}

// ===================================================================
// Icons, state labels
// ===================================================================
const DOMAIN_ICONS = {
  light: 'lightbulb', switch: 'toggle-switch-variant', fan: 'fan', cover: 'window-shutter', climate: 'thermostat',
  media_player: 'cast', lock: 'lock', sensor: 'eye', binary_sensor: 'radiobox-blank', camera: 'cctv',
  vacuum: 'robot-vacuum', scene: 'palette', script: 'script-text-outline', automation: 'robot',
  button: 'gesture-tap-button', input_button: 'gesture-tap-button', number: 'ray-vertex', input_number: 'ray-vertex',
  select: 'format-list-bulleted', input_select: 'format-list-bulleted', input_boolean: 'toggle-switch-outline',
  input_text: 'form-textbox', text: 'form-textbox', alarm_control_panel: 'shield-home', update: 'package-up',
  weather: 'weather-partly-cloudy', water_heater: 'water-boiler', humidifier: 'air-humidifier', valve: 'valve',
  siren: 'bullhorn', person: 'account', device_tracker: 'map-marker', timer: 'timer-outline', counter: 'counter',
  event: 'gesture-double-tap', lawn_mower: 'robot-mower', remote: 'remote', image: 'image', calendar: 'calendar',
  todo: 'clipboard-list', input_datetime: 'calendar-clock', date: 'calendar', time: 'clock-outline',
  datetime: 'calendar-clock', notify: 'message', tts: 'speaker-message', stt: 'microphone',
};
const SENSOR_ICONS = {
  temperature: 'thermometer', humidity: 'water-percent', battery: 'battery', power: 'flash', energy: 'lightning-bolt',
  illuminance: 'brightness-5', pressure: 'gauge', atmospheric_pressure: 'gauge', co2: 'molecule-co2',
  carbon_dioxide: 'molecule-co2', voltage: 'sine-wave', current: 'current-ac', signal_strength: 'wifi',
  duration: 'timer-outline', timestamp: 'clock-outline', gas: 'meter-gas', water: 'water', moisture: 'water-percent',
  pm25: 'blur', pm10: 'blur', monetary: 'cash', speed: 'speedometer', distance: 'arrow-left-right',
  weight: 'weight', volatile_organic_compounds: 'air-filter', frequency: 'sine-wave', power_factor: 'angle-acute',
  enum: 'format-list-bulleted',
};
const BINARY_ICONS = {
  door: ['door-open', 'door-closed'], window: ['window-open', 'window-closed'], garage_door: ['garage-open', 'garage'],
  opening: ['square-outline', 'square'], motion: ['motion-sensor', 'motion-sensor-off'],
  occupancy: ['home-account', 'home-outline'], presence: ['home-account', 'home-outline'],
  moisture: ['water-alert', 'water-off'], smoke: ['smoke-detector-alert', 'smoke-detector'],
  carbon_monoxide: ['smoke-detector-alert', 'smoke-detector'], gas: ['alert', 'check-circle'],
  lock: ['lock-open-variant', 'lock'], battery: ['battery-alert', 'battery'],
  connectivity: ['check-network', 'close-network'], plug: ['power-plug', 'power-plug-off'],
  power: ['power-plug', 'power-plug-off'], light: ['brightness-7', 'brightness-5'],
  sound: ['music-note', 'music-note-off'], vibration: ['vibrate', 'crop-portrait'],
  problem: ['alert-circle', 'check-circle'], safety: ['alert-circle', 'check-circle'], tamper: ['alert', 'check-circle'],
  running: ['play', 'stop'], heat: ['fire', 'thermometer'], cold: ['snowflake', 'thermometer'],
  update: ['package-up', 'package'],
};
const COVER_ICONS = {
  garage: ['garage-open', 'garage'], door: ['door-open', 'door-closed'], gate: ['gate-open', 'gate'],
  blind: ['blinds-open', 'blinds'], curtain: ['curtains', 'curtains-closed'], shade: ['roller-shade', 'roller-shade-closed'],
  shutter: ['window-shutter-open', 'window-shutter'], window: ['window-open', 'window-closed'], awning: ['awning-outline', 'awning-outline'],
};
const ROOM_ICONS = [
  [/kitchen|cuisine|küche|cocina/i, 'stove'], [/living|lounge|salon|family/i, 'sofa'],
  [/master|bed|sleep|guest room|chambre/i, 'bed'], [/kid|child|nursery|baby/i, 'teddy-bear'],
  [/bath|shower|toilet|wc|restroom/i, 'shower'], [/office|study|desk|work ?room/i, 'desk'],
  [/dining/i, 'silverware-fork-knife'], [/garage|car/i, 'garage'], [/garden|yard|patio|terrace|outdoor|balcon/i, 'flower'],
  [/laundry|utility|wash/i, 'washing-machine'], [/hall|entry|entrance|corridor|foyer|stair/i, 'door'],
  [/basement|cellar|storage/i, 'archive'], [/attic|loft/i, 'home-roof'], [/gym|fitness/i, 'dumbbell'],
  [/workshop|shed/i, 'hammer-wrench'], [/media|cinema|theater|game/i, 'television-classic'],
  [/pool/i, 'pool'], [/server|network|tech/i, 'server-network'], [/closet|wardrobe|dressing/i, 'hanger'],
];

const WEATHER = {
  'clear-night': ['weather-night', 'Clear night'], cloudy: ['weather-cloudy', 'Cloudy'],
  exceptional: ['alert-circle-outline', 'Exceptional'], fog: ['weather-fog', 'Fog'], hail: ['weather-hail', 'Hail'],
  lightning: ['weather-lightning', 'Lightning'], 'lightning-rainy': ['weather-lightning-rainy', 'Thunderstorm'],
  partlycloudy: ['weather-partly-cloudy', 'Partly cloudy'], pouring: ['weather-pouring', 'Pouring'],
  rainy: ['weather-rainy', 'Rainy'], snowy: ['weather-snowy', 'Snowy'], 'snowy-rainy': ['weather-snowy-rainy', 'Sleet'],
  sunny: ['weather-sunny', 'Sunny'], windy: ['weather-windy', 'Windy'], 'windy-variant': ['weather-windy-variant', 'Windy'],
};
const weatherIcon = (cond) => `mdi:${(WEATHER[cond] || ['weather-partly-cloudy'])[0]}`;
const weatherLabel = (cond) => (WEATHER[cond] || [null, pretty(cond)])[1];

function entityIcon(eid) {
  const ov = L('entities', eid).icon;
  if (ov) return ov;
  const ent = M().entities[eid];
  if (ent?.icon) return ent.icon;
  const st = S.states[eid];
  const a = st?.attributes || {};
  if (a.icon) return a.icon;
  const d = domainOf(eid);
  const v = st?.state;
  const dc = a.device_class;
  const pick = (pair, active) => `mdi:${pair[active ? 0 : 1]}`;
  switch (d) {
    case 'light': return v === 'on' ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline';
    case 'weather': return weatherIcon(v);
    case 'lock': return v === 'locked' ? 'mdi:lock' : 'mdi:lock-open-variant';
    case 'fan': return v === 'on' ? 'mdi:fan' : 'mdi:fan-off';
    case 'switch': return dc === 'outlet' ? 'mdi:power-socket-eu' : (v === 'on' ? 'mdi:toggle-switch-variant' : 'mdi:toggle-switch-variant-off');
    case 'media_player': return dc === 'tv' ? 'mdi:television' : dc === 'speaker' ? 'mdi:speaker' : 'mdi:cast';
    case 'binary_sensor': if (BINARY_ICONS[dc]) return pick(BINARY_ICONS[dc], v === 'on'); break;
    case 'cover': if (COVER_ICONS[dc]) return pick(COVER_ICONS[dc], v === 'open' || v === 'opening'); break;
    case 'sensor': if (SENSOR_ICONS[dc]) return `mdi:${SENSOR_ICONS[dc]}`; break;
    default: break;
  }
  return `mdi:${DOMAIN_ICONS[d] || 'shape-outline'}`;
}

const PRIMARY_ORDER = ['climate', 'media_player', 'light', 'cover', 'lock', 'fan', 'vacuum', 'alarm_control_panel',
  'camera', 'water_heater', 'humidifier', 'lawn_mower', 'valve', 'switch', 'select', 'number', 'button', 'sensor', 'binary_sensor'];
function primaryEntity(ents) {
  let best = null, bestRank = 1e9;
  for (const e of ents) {
    const r = PRIMARY_ORDER.indexOf(domainOf(e));
    const rank = r < 0 ? 500 : r;
    if (rank < bestRank) { best = e; bestRank = rank; }
  }
  return best || ents[0];
}
function deviceIcon(nid) {
  const ov = L('devices', devKey(nid)).icon;
  if (ov) return ov;
  if (M().devices[nid].virtual) return 'mdi:shape-plus';
  const p = primaryEntity(mainEntities(nid));
  return p ? entityIcon(p) : 'mdi:devices';
}
function roomIcon(aid) {
  const ov = L('areas', aid).icon || M().areas[aid].icon;
  if (ov) return ov;
  const name = M().areas[aid].name;
  for (const [re, i] of ROOM_ICONS) if (re.test(name)) return `mdi:${i}`;
  return 'mdi:floor-plan';
}

function isActive(eid) {
  const st = S.states[eid];
  if (!st) return false;
  const v = st.state;
  switch (domainOf(eid)) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': case 'siren': case 'humidifier': case 'remote':
    case 'binary_sensor':
      return v === 'on';
    case 'cover': case 'valve': return v === 'open' || v === 'opening';
    case 'media_player': return v === 'playing';
    case 'climate': return v !== 'off' && v !== 'unavailable' && v !== 'unknown';
    case 'lock': return v === 'unlocked' || v === 'open' || v === 'unlocking';
    case 'vacuum': case 'lawn_mower': return v === 'cleaning' || v === 'mowing';
    case 'alarm_control_panel': return v.startsWith('armed') || v === 'triggered';
    default: return false;
  }
}

const BINARY_LABELS = {
  door: ['Open', 'Closed'], window: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], opening: ['Open', 'Closed'],
  motion: ['Detected', 'Clear'], occupancy: ['Detected', 'Clear'], presence: ['Home', 'Away'],
  moisture: ['Wet', 'Dry'], smoke: ['Detected', 'Clear'], gas: ['Detected', 'Clear'], carbon_monoxide: ['Detected', 'Clear'],
  lock: ['Unlocked', 'Locked'], battery: ['Low', 'Normal'], connectivity: ['Connected', 'Disconnected'],
  plug: ['Plugged in', 'Unplugged'], problem: ['Problem', 'OK'], safety: ['Unsafe', 'Safe'], tamper: ['Tampered', 'Clear'],
  running: ['Running', 'Not running'], update: ['Update available', 'Up to date'],
};

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const abs = Math.abs(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2 });
}
const isNumeric = (v) => v !== '' && v != null && Number.isFinite(Number(v));

/** Returns [value, unit] for display. */
function stateParts(eid) {
  const st = S.states[eid];
  if (!st) return ['Unavailable', ''];
  const a = st.attributes || {};
  const v = st.state;
  const d = domainOf(eid);
  if (v === 'unavailable') return ['Unavailable', ''];
  if (v === 'unknown' && !['button', 'scene', 'input_button'].includes(d)) return ['Unknown', ''];
  switch (d) {
    case 'light':
      if (v === 'on' && a.brightness != null) return [`${Math.round(a.brightness / 2.55)}`, '%'];
      break;
    case 'climate':
      if (a.current_temperature != null) return [fmtNum(a.current_temperature), '°'];
      break;
    case 'cover': case 'valve':
      if (a.current_position != null && v === 'open') return [`${a.current_position}`, '% open'];
      break;
    case 'binary_sensor': {
      const l = BINARY_LABELS[a.device_class];
      if (l) return [v === 'on' ? l[0] : l[1], ''];
      break;
    }
    case 'weather':
      return [weatherLabel(v), a.temperature != null ? `· ${fmtNum(a.temperature)}${a.temperature_unit || '°'}` : ''];
    case 'button': case 'input_button': return ['Ready', ''];
    case 'scene': return ['Scene', ''];
    case 'sensor':
      if (a.device_class === 'timestamp') return [rel(v), ''];
      break;
    case 'media_player':
      if (a.volume_level != null && v === 'playing') return ['Playing', ''];
      break;
    default: break;
  }
  if (isNumeric(v)) return [fmtNum(v), a.unit_of_measurement || ''];
  return [pretty(v), a.unit_of_measurement || ''];
}
function stateLabel(eid) {
  const [v, u] = stateParts(eid);
  const st = S.states[eid];
  const d = domainOf(eid);
  if (d === 'light' && st?.state === 'on' && u === '%') return `On · ${v}%`;
  if (d === 'climate' && st) return `${pretty(st.state)} · ${v}${u}`;
  if (d === 'media_player' && st?.attributes?.media_title && ['playing', 'paused'].includes(st.state)) {
    return `${pretty(st.state)} · ${st.attributes.media_title}`;
  }
  return u && !u.startsWith('%') && !u.startsWith('°') ? `${v} ${u}` : `${v}${u}`;
}
function deviceSub(nid) {
  const ents = mainEntities(nid);
  if (ents.length === 1) return stateLabel(ents[0]);
  const p = primaryEntity(ents);
  if (p && PRIMARY_ORDER.indexOf(domainOf(p)) >= 0 && PRIMARY_ORDER.indexOf(domainOf(p)) < 14) {
    return `${stateLabel(p)} · +${ents.length - 1}`;
  }
  return `${ents.length} entities`;
}

// ===================================================================
// House view
// ===================================================================
const HW = 1000;
const houseView = $('#house-view');
const wheelView = $('#wheel-view');

function houseGeometry(allVisible) {
  const yards = allVisible.filter((f) => f.outdoor && f.areas.length);
  const floors = allVisible.filter((f) => !f.outdoor);
  const above = floors.filter((f) => f.level == null || f.level >= 0)
    .sort((a, b) => (b.level ?? -0.5) - (a.level ?? -0.5));
  const below = floors.filter((f) => f.level != null && f.level < 0).sort((a, b) => b.level - a.level);
  const stageW = $('#stage').clientWidth;
  const maxCols = stageW < 560 ? 2 : stageW < 900 ? 3 : 5;
  const X0 = 110, X1 = 890, TOP = 30, ROOF = 170, PAD = 14, LABEL = 34, GAP = 12;
  const ROWH = maxCols === 2 ? 210 : maxCols === 3 ? 170 : 150;
  const bands = [];
  let y = TOP + ROOF;
  // Custom home: rooms sit on a 12-column grid where you placed them in the floor-plan editor.
  const PLAN_COLS = 12, PLAN_ROW = 75;
  const layoutPlanned = (f, x0, x1, under) => {
    const unitW = (x1 - x0 - 2 * PAD) / PLAN_COLS;
    const placed = [];
    const overlaps = (p) => placed.some((q) => p.c < q.c + q.w && q.c < p.c + p.w && p.r < q.r + q.h && q.r < p.r + p.h);
    const clampPlan = (p) => {
      const w = clamp(Math.round(p.w) || 4, 1, PLAN_COLS), hgt = Math.max(1, Math.round(p.h) || 2);
      return { c: clamp(Math.round(p.c) || 0, 0, PLAN_COLS - w), r: Math.max(0, Math.round(p.r) || 0), w, h: hgt };
    };
    const firstFit = (w, hgt) => {
      for (let r = 0; ; r++) for (let c = 0; c + w <= PLAN_COLS; c++) if (!overlaps({ c, r, w, h: hgt })) return { c, r, w, h: hgt };
    };
    const planOf = (aid) => {
      const draft = S.plan?.draft[aid];
      return draft === 'auto' ? null : (draft || M().areas[aid].plan);
    };
    const want = f.areas.map((aid) => ({ aid, plan: planOf(aid) }));
    for (const x of want.filter((q) => q.plan)) {
      const p = clampPlan(x.plan);
      placed.push({ ...(overlaps(p) ? firstFit(p.w, p.h) : p), aid: x.aid });
    }
    for (const x of want.filter((q) => !q.plan)) placed.push({ ...firstFit(4, 2), aid: x.aid });
    const rowsUsed = Math.max(2, ...placed.map((p) => p.r + p.h)) + (S.plan ? 1 : 0); // a spare row to drag into
    const height = LABEL + rowsUsed * PLAN_ROW + PAD;
    const gx = x0 + PAD, gy = y + LABEL;
    const rooms = placed.map((p) => ({
      aid: p.aid, plan: { c: p.c, r: p.r, w: p.w, h: p.h },
      x: gx + p.c * unitW + 4, y: gy + p.r * PLAN_ROW + 4, w: p.w * unitW - 8, h: p.h * PLAN_ROW - 8,
    }));
    const band = { floor: f, x0, x1, y, h: height, rooms, under, grid: { x: gx, y: gy, unitW, unitH: PLAN_ROW, cols: PLAN_COLS, rows: rowsUsed } };
    rooms.forEach((r) => { r.band = band; });
    bands.push(band);
    y += height;
  };
  const layoutFloor = (f, x0, x1, under, auto = false) => {
    if (M().custom && !auto) { layoutPlanned(f, x0, x1, under); return; }
    const n = f.areas.length;
    const rows = Math.max(1, Math.ceil(n / maxCols));
    const perRow = Math.ceil(n / rows);
    const height = LABEL + rows * ROWH + (rows - 1) * GAP + PAD;
    const rooms = [];
    f.areas.forEach((aid, i) => {
      const row = Math.floor(i / perRow);
      const inRow = row === rows - 1 ? n - perRow * (rows - 1) : perRow;
      const col = i - row * perRow;
      const w = (x1 - x0 - 2 * PAD - (inRow - 1) * GAP) / inRow;
      rooms.push({
        aid, x: x0 + PAD + col * (w + GAP), y: y + LABEL + row * (ROWH + GAP), w, h: ROWH,
      });
    });
    bands.push({ floor: f, x0, x1, y, h: height, rooms, under });
    y += height;
  };
  for (const f of above) layoutFloor(f, X0, X1, false);
  const groundY = y;
  if (below.length) y += 18;
  for (const f of below) layoutFloor(f, X0 + 30, X1 - 30, true);
  // Phones and other portrait screens: outdoor levels become full-width gardens below the house,
  // so the house keeps the whole width and uses the screen's height.
  const stageEl = $('#stage');
  const narrow = maxCols === 2 || stageEl.clientWidth < stageEl.clientHeight * 0.9;
  const gardens = [];
  if (narrow) {
    for (const yard of yards) {
      y += 30;
      layoutFloor(yard, X0 - 40, X1 + 40, false, true);
      const g = bands[bands.length - 1];
      g.outdoor = true;
      gardens.push(g);
    }
  }
  const H = y + 36;
  // Wider screens: each outdoor level is a fenced garden standing on the ground to the right of the house.
  let W = HW;
  let gx0 = X1 + 80;
  let gBottom = groundY; // on narrow screens gardens stack upwards instead of side by side
  let colRight = gx0;
  for (const yard of narrow ? [] : yards) {
    const n = yard.areas.length;
    const ROOMW = 270;
    const maxRows = Math.max(1, Math.floor((groundY - TOP - LABEL - PAD + GAP) / (ROWH + GAP)));
    const cols = Math.ceil(n / maxRows);
    const rows = Math.ceil(n / cols);
    const gh = LABEL + rows * ROWH + (rows - 1) * GAP + PAD;
    const gw = 2 * PAD + cols * ROOMW + (cols - 1) * GAP;
    const stack = maxCols === 2 && gardens.length && gBottom - gh >= TOP;
    if (!stack && gardens.length) { gx0 = colRight + 40; gBottom = groundY; }
    const gy = gBottom - gh;
    const rooms = yard.areas.map((aid, k) => ({
      aid, x: gx0 + PAD + (k % cols) * (ROOMW + GAP), y: gy + LABEL + Math.floor(k / cols) * (ROWH + GAP), w: ROOMW, h: ROWH,
    }));
    const garden = { floor: yard, x0: gx0, x1: gx0 + gw, y: gy, h: gh, rooms, outdoor: true };
    gardens.push(garden);
    bands.push(garden);
    gBottom = gy - 20;
    colRight = Math.max(stack ? colRight : 0, garden.x1);
    W = Math.max(W, garden.x1 + 30);
  }
  return { bands, gardens, narrow, X0, X1, TOP, ROOF, groundY, H, W, hasAbove: above.length > 0 };
}

function buildHouse() {
  const svg = $('#house');
  const labels = $('#house-labels');
  const floors = visibleFloors();
  const empty = floors.length === 0;
  $('#empty-house').hidden = !empty;
  $('#house-frame').hidden = empty;
  if (empty) {
    const [title, text] = $('#empty-house').querySelectorAll('p');
    title.textContent = M().custom ? 'Your custom home has no rooms yet.' : 'No rooms found yet.';
    text.textContent = M().custom
      ? 'Open Customize to add levels and rooms, and put devices in them.'
      : 'Create areas (and optionally floors) in Home Assistant, assign devices to them, and they will appear here.';
  }
  S.rooms = [];
  if (empty) return;
  const g = houseGeometry(floors);
  S.houseGeom = g;
  svg.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
  const parts = [];
  parts.push(s('defs', {},
    s('linearGradient', { id: 'earth', x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { class: 'h-earth-stop', offset: 0, 'stop-opacity': 0.1 }),
      s('stop', { class: 'h-earth-stop', offset: 1, 'stop-opacity': 0 }))));

  // Roof + chimney + attic window
  const eaveL = g.X0 - 50, eaveR = g.X1 + 50, apexY = g.TOP, eaveY = g.TOP + g.ROOF;
  parts.push(s('rect', { class: 'h-chimney', x: 690, y: apexY + 30, width: 46, height: 110 }));
  const roofName = s('text', { class: 'h-house-name', x: HW / 2, y: eaveY - 16 }, houseName());
  parts.push(s('polygon', { class: 'h-roof', points: `${eaveL},${eaveY} ${HW / 2},${apexY} ${eaveR},${eaveY}` }));
  parts.push(s('polyline', { class: 'h-roof-line', points: `${eaveL + 40},${eaveY - 14} ${HW / 2},${apexY + 22} ${eaveR - 40},${eaveY - 14}` }));
  parts.push(s('circle', { class: 'h-attic', cx: HW / 2, cy: apexY + g.ROOF * 0.62, r: 20 }));
  parts.push(s('path', { class: 'h-attic', d: `M${HW / 2 - 20},${apexY + g.ROOF * 0.62}h40M${HW / 2},${apexY + g.ROOF * 0.62 - 20}v40` }));

  // Earth + ground line
  parts.push(s('rect', { class: 'h-earth', x: 0, y: g.groundY, width: g.W, height: g.H - g.groundY }));
  if (g.gardens.length && !g.narrow) { // a tree between the house and the garden
    const tx = g.X1 + 40, ty = g.groundY;
    parts.push(s('rect', { class: 'h-trunk', x: tx - 4, y: ty - 34, width: 8, height: 34 }));
    parts.push(s('circle', { class: 'h-tree', cx: tx, cy: ty - 52, r: 24 }));
  }

  const roomEls = [];
  for (const b of g.bands) {
    const wallCls = b.outdoor ? 'h-garden' : `h-wall ${b.under ? 'under' : ''} ${b.floor.id === '__unassigned__' ? 'annex' : ''}`;
    parts.push(s('rect', { class: wallCls, x: b.x0, y: b.y, width: b.x1 - b.x0, height: b.h, rx: b.outdoor ? 16 : 0 }));
    parts.push(s('text', { class: 'h-floor-label', x: b.x0 + 16, y: b.y + 23 }, floorName(b.floor)));
    if (S.plan && b.grid) { // dotted grid to snap to
      const gr = b.grid;
      const dots = [];
      for (let r = 0; r <= gr.rows; r++) for (let c = 0; c <= gr.cols; c++) dots.push(`M${gr.x + c * gr.unitW},${gr.y + r * gr.unitH}h0.01`);
      parts.push(s('path', { class: 'plan-grid', d: dots.join('') }));
    }
    for (const r of b.rooms) {
      const idx = S.rooms.length;
      const room = s('g', { class: 'room', 'data-area': r.aid, 'data-idx': idx },
        s('rect', { class: 'r-body', x: r.x, y: r.y, width: r.w, height: r.h, rx: 10 }),
        S.plan && r.plan ? s('path', {
          class: 'r-handle', 'data-handle': idx,
          d: `M${r.x + r.w - 4},${r.y + r.h - 26}V${r.y + r.h - 4}H${r.x + r.w - 26}Z`,
        }) : null);
      // Round count pill in the card's corner: how many items the room's wheel has.
      const pr = g.narrow ? 22 : 13; // the house is drawn smaller on phones, so the pill is drawn bigger
      const count = s('g', { class: 'r-count' },
        s('circle', { cx: r.x + r.w - pr - 7, cy: r.y + pr + 7, r: pr }),
        s('text', { x: r.x + r.w - pr - 7, y: r.y + pr + 7, style: `font-size:${pr}px` }, ''));
      room.append(count);
      roomEls.push(room);
      S.rooms.push({ ...r, el: room, count });
    }
  }
  parts.push(roofName);
  parts.push(s('line', { class: 'h-ground', x1: 10, x2: g.W - 10, y1: g.groundY, y2: g.groundY }));
  svg.replaceChildren(...parts, ...roomEls);

  labels.replaceChildren(...S.rooms.map((r) => {
    const el = h('div', {
      class: 'room-label',
      style: `left:${((r.x + r.w / 2) / g.W) * 100}%;top:${((r.y + r.h / 2 + 18) / g.H) * 100}%;max-width:${(r.w / g.W) * 100 - 1}%`,
    }, ico(roomIcon(r.aid)), h('div', { class: 'name' }, areaName(r.aid)), h('div', { class: 'chips' }));
    r.label = el;
    return el;
  }), ...(S.plan ? S.rooms.map((r) => h('button', {
    class: 'card-edit', title: `Edit the ${areaName(r.aid)} card`, 'data-area': r.aid,
    style: `left:${((r.x + r.w - 22) / g.W) * 100}%;top:${((r.y + 22) / g.H) * 100}%`,
    onclick: () => openCardEditor(r.aid),
  }, ico('mdi:pencil'))) : []));
  $('#house').classList.toggle('plan-edit', !!S.plan);
  paintWeather();
  sizeHouse();
  paintHouse();
}

// ===================================================================
// Floor-plan editor (custom home): drag rooms to move them, drag the corner to resize
// ===================================================================
/** Edit mode on the house: a pencil on every room card; in a custom home also drag/resize rooms. */
function startPlanEdit() {
  if (!S.admin || S.nav.level !== 'house') return;
  S.plan = { draft: {} };
  hideTooltip();
  setHouseFocus(-1, true);
  document.body.classList.add('plan-editing');
  buildHouse();
  renderPlanBar();
  updatePlanButton();
}
async function endPlanEdit(save) {
  if (!S.plan) return;
  if (save && M().custom) {
    const placed = Object.fromEntries(S.rooms.filter((r) => r.plan).map((r) => [r.aid, r.plan]));
    for (const room of S.layout.custom.rooms) if (placed[room.id]) room.plan = placed[room.id];
    S.plan = null;
    await saveLayout();
    toast('Saved');
  }
  S.plan = null;
  document.body.classList.remove('plan-editing');
  renderPlanBar();
  buildHouse();
  updatePlanButton();
}
function renderPlanBar() {
  const bar = $('#plan-bar');
  bar.hidden = !S.plan;
  if (!S.plan) { sizeHouse(); return; }
  const custom = M().custom;
  bar.replaceChildren(...[
    h('span', { class: 'muted' }, ico('mdi:pencil'), custom
      ? ' Tap the pencil on a room to edit its card. Drag a room to move it, drag its corner to resize.'
      : ' Tap the pencil on a room to edit its card.'),
    custom ? act('Auto-arrange', 'mdi:auto-fix', () => {
      for (const r of S.rooms) if (r.plan) S.plan.draft[r.aid] = 'auto';
      buildHouse();
      for (const r of S.rooms) if (r.plan) S.plan.draft[r.aid] = r.plan; // keep the arranged result
    }, 'small') : null,
    act('Customize…', 'mdi:tune-variant', () => { endPlanEdit(false); openEditor(); }, 'small'),
    custom ? act('Cancel', null, () => endPlanEdit(false), 'small') : null,
    act(custom ? 'Save' : 'Done', custom ? 'mdi:content-save' : 'mdi:check', () => endPlanEdit(true), 'small primary'),
  ].filter(Boolean));
  sizeHouse();
}
/** Like a Home Assistant card editor: name, icon and what the card shows, with a live preview. */
function openCardEditor(aid) {
  if (!S.admin) return;
  W = JSON.parse(JSON.stringify(S.layout));
  W.settings ||= {};
  const custom = !!M().custom;
  const room = custom ? W.custom.rooms.find((r) => r.id === aid) : null;
  const ed = $('#card-editor');
  // Compute things as they would look with the unsaved changes in W.
  const withDraft = (fn) => {
    const saved = S.layout;
    S.layout = W;
    refreshView();
    try { return fn(); } finally { S.layout = saved; refreshView(); }
  };
  const preview = h('div', { class: 'card-preview' });
  const drawPreview = () => withDraft(() => {
    const st = roomStats(aid);
    preview.replaceChildren(
      h('div', { class: `room-label preview ${st.lights ? 'lit' : ''}` },
        ico(roomIcon(aid)), h('div', { class: 'name' }, areaName(aid)),
        h('div', { class: 'chips' }, st.chips.map((c) => h('span', {}, ico(c.icon), c.text)))));
  });
  const nameIn = textIn(custom ? room.name : wget('areas', aid).name || '', (v) => {
    if (custom) room.name = v || 'Room'; else wset('areas', aid, { name: v });
    drawPreview();
  }, custom ? 'Room name' : withReal(() => M().areas[aid]?.name || 'Room name'));
  const iconNow = custom ? room.icon : wget('areas', aid).icon;
  const iconIn = textIn((iconNow || '').replace(/^mdi:/, ''), (v) => {
    const icon = v ? (v.includes(':') ? v : `mdi:${v}`) : '';
    if (custom) room.icon = icon; else wset('areas', aid, { icon });
    drawPreview();
  }, 'automatic, or e.g. sofa', 'icon-in');
  const entities = M().areas[aid].devices.flatMap((nid) => M().devices[nid].entities);
  const close = () => { ed.hidden = true; W = null; };
  ed.replaceChildren(h('div', { class: 'modal-card card-dialog', role: 'dialog', 'aria-label': 'Edit room card' },
    h('div', { class: 'modal-head' }, h('h2', {}, `${areaName(aid)} card`),
      h('button', { class: 'sb-close', onclick: close, title: 'Close' }, ico('mdi:close'))),
    h('div', { class: 'modal-body card-body' },
      h('div', { class: 'card-form' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
        h('label', { class: 'field' }, h('span', {}, 'Icon'), iconIn,
          h('a', { href: 'https://pictogrammers.com/library/mdi/', target: '_blank', rel: 'noopener', class: 'muted' }, 'Browse icons')),
        h('div', { class: 'field' }, h('span', {}, 'Shows'),
          statusEditor(aid, entities, drawPreview),
          h('p', { class: 'muted' }, 'Add summaries (temperature, lights on, devices on, doors & windows open, motion) or any entity to show its live state. Use ‹ to reorder.'))),
      h('div', { class: 'card-side' }, h('span', { class: 'muted' }, 'Preview'), preview)),
    h('div', { class: 'modal-foot' },
      h('span', { class: 'spacer' }),
      act('Cancel', null, close, 'small'),
      act('Save', 'mdi:content-save', async () => {
        // Stay in edit mode, and keep room positions dragged but not yet saved.
        if (custom && S.plan) {
          for (const def of W.custom.rooms) if (S.plan.draft[def.id] && S.plan.draft[def.id] !== 'auto') def.plan = S.plan.draft[def.id];
        }
        S.layout = W;
        close();
        await saveLayout();
        buildHouse();
        toast('Card saved');
      }, 'small primary'))));
  ed.hidden = false;
  drawPreview();
  nameIn.focus();
}

function updatePlanButton() {
  $('#btn-plan').hidden = !(S.admin && M() && S.nav.level === 'house' && !S.plan);
}
const svgPoint = (svg, e) => {
  const p = svg.createSVGPoint();
  p.x = e.clientX; p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
};
let planDrag = null;
$('#house').addEventListener('pointerdown', (e) => {
  if (!S.plan) return;
  const handle = e.target.closest('[data-handle]');
  const t = handle || e.target.closest('g.room');
  const r = t && S.rooms[+(handle ? handle.dataset.handle : t.dataset.idx)];
  if (!r || !r.plan) return;
  e.preventDefault();
  $('#house').setPointerCapture(e.pointerId);
  planDrag = { mode: handle ? 'resize' : 'move', aid: r.aid, floor: r.band.floor.id, start: svgPoint($('#house'), e), plan: { ...r.plan }, grid: r.band.grid };
});
$('#house').addEventListener('pointermove', (e) => {
  if (!planDrag) return;
  const d = planDrag, gr = d.grid;
  const p = svgPoint($('#house'), e);
  const dc = Math.round((p.x - d.start.x) / gr.unitW), dr = Math.round((p.y - d.start.y) / gr.unitH);
  const next = { ...d.plan };
  if (d.mode === 'move') {
    next.c = clamp(d.plan.c + dc, 0, gr.cols - d.plan.w);
    next.r = clamp(d.plan.r + dr, 0, gr.rows - 1);
  } else {
    next.w = clamp(d.plan.w + dc, 1, gr.cols - d.plan.c);
    next.h = clamp(d.plan.h + dr, 1, gr.rows - d.plan.r + 1);
  }
  const cur = S.rooms.find((r) => r.aid === d.aid)?.plan;
  if (!cur || (cur.c === next.c && cur.r === next.r && cur.w === next.w && cur.h === next.h)) return;
  const others = S.rooms.filter((r) => r.plan && r.aid !== d.aid && r.band.floor.id === d.floor);
  const hit = others.some(({ plan: q }) => next.c < q.c + q.w && q.c < next.c + next.w && next.r < q.r + q.h && q.r < next.r + next.h);
  if (hit) return; // rooms can't overlap
  for (const r of others) S.plan.draft[r.aid] ||= r.plan; // pin the others where they are
  S.plan.draft[d.aid] = next;
  buildHouse();
});
const endDrag = () => { planDrag = null; };
$('#house').addEventListener('pointerup', endDrag);
$('#house').addEventListener('pointercancel', endDrag);

/** What a room card can show. Rooms without a choice show DEFAULT_STATUS. */
const STATUS_SUMMARIES = {
  temp: { label: 'Temperature (automatic)', short: 'Temperature', icon: 'mdi:thermometer' },
  lights: { label: 'Lights on', short: 'Lights on', icon: 'mdi:lightbulb-on' },
  active: { label: 'Devices on', short: 'Devices on', icon: 'mdi:power' },
  open: { label: 'Doors & windows open', short: 'Open', icon: 'mdi:door-open' },
  motion: { label: 'Motion', short: 'Motion', icon: 'mdi:motion-sensor' },
};
const DEFAULT_STATUS = [{ kind: 'temp' }, { kind: 'lights' }, { kind: 'motion' }];
const roomStatus = (aid) => (Array.isArray(L('areas', aid).status) ? L('areas', aid).status : DEFAULT_STATUS);
const OPENING_CLASSES = ['door', 'window', 'opening', 'garage_door'];

function roomStats(aid) {
  const nodes = visibleNodes(aid);
  let lights = 0, active = 0, temp = null, motion = false, open = 0;
  for (const nid of nodes) {
    for (const eid of visibleEntities(nid)) {
      if (category(eid)) continue;
      const d = domainOf(eid);
      const st = S.states[eid];
      if (d === 'light' && st.state === 'on') lights++;
      if (isActive(eid) && d !== 'binary_sensor') active++;
      if (temp == null && d === 'sensor' && st.attributes.device_class === 'temperature' && isNumeric(st.state)) {
        temp = `${fmtNum(st.state)}${st.attributes.unit_of_measurement || ''}`;
      }
      if (temp == null && d === 'climate' && st.attributes.current_temperature != null) {
        temp = `${fmtNum(st.attributes.current_temperature)}°`;
      }
      if (d === 'binary_sensor' && ['motion', 'occupancy', 'presence'].includes(st.attributes.device_class) && st.state === 'on') motion = true;
      if (d === 'binary_sensor' && OPENING_CLASSES.includes(st.attributes.device_class) && st.state === 'on') open++;
      if (d === 'cover' && (st.state === 'open' || st.state === 'opening')) open++;
    }
  }
  const values = { temp, lights, active, open, motion };
  // The chips on the room card, in the order the user chose.
  const chips = [];
  for (const item of roomStatus(aid)) {
    if (item.kind === 'entity') {
      if (S.states[item.id]) chips.push({ icon: entityIcon(item.id), text: stateLabel(item.id), eid: item.id, label: entName(item.id) });
    } else if (STATUS_SUMMARIES[item.kind]) {
      const v = values[item.kind];
      if (!v) continue; // nothing to report (0 lights on, no motion, no temperature)
      chips.push({
        icon: STATUS_SUMMARIES[item.kind].icon, text: item.kind === 'motion' ? '' : String(v),
        label: STATUS_SUMMARIES[item.kind].short, value: item.kind === 'motion' ? 'Detected' : String(v),
      });
    }
  }
  return { devices: nodes.length, leaves: roomItems(aid).length, lights, active, temp, motion, open, chips };
}

// ===================================================================
// Weather card (top left of the house)
// ===================================================================
/** All weather entities, Home Assistant's own Met.no first. */
function weatherEntities() {
  return Object.values(S.model?.entities || {})
    .filter((e) => e.domain === 'weather' && S.states[e.entity_id])
    .sort((a, b) => ((b.platform === 'met') - (a.platform === 'met')) || (a.full_name || '').localeCompare(b.full_name || ''));
}
/** The weather entity to show: the user's choice, else Met.no, else the first one; null = don't show. */
function weatherEntity(settings = S.layout.settings || {}) {
  const choice = settings.weather;
  if (choice === 'none') return null;
  if (choice && S.states[choice]) return choice;
  return weatherEntities()[0]?.entity_id || null;
}
const forecasts = {}; // entity_id -> { at, list }
function loadForecast(eid) {
  const f = forecasts[eid];
  if (f && (f.loading || Date.now() - f.at < 30 * 60000)) return;
  forecasts[eid] = { ...(f || {}), loading: true };
  api(`api/forecast?entity_id=${encodeURIComponent(eid)}&type=daily`)
    .then((d) => { forecasts[eid] = { at: Date.now(), list: d.forecast || [] }; })
    .catch(() => { forecasts[eid] = { at: Date.now(), list: [] }; }) // not every integration has a forecast
    .finally(() => { if (S.nav.level === 'house') paintWeather(); });
}
const dayName = (iso, i) => (i === 0 ? 'Today' : new Date(iso).toLocaleDateString(undefined, { weekday: 'short' }));

function weatherCard(eid, compact = false) {
  const st = S.states[eid];
  const a = st.attributes || {};
  const unit = a.temperature_unit || '°';
  const list = forecasts[eid]?.list || [];
  const today = list[0];
  return h('div', { class: 'wx-inner' },
    h('div', { class: 'wx-now' },
      ico(weatherIcon(st.state), 'wx-icon'),
      h('div', { class: 'wx-main' },
        h('div', { class: 'wx-temp' }, a.temperature != null ? `${fmtNum(a.temperature)}${unit}` : '–'),
        h('div', { class: 'wx-cond' }, weatherLabel(st.state)))),
    !compact && today && today.temperature != null
      ? h('div', { class: 'wx-range' }, `H ${fmtNum(today.temperature)}° · L ${today.templow != null ? `${fmtNum(today.templow)}°` : '–'}`
        + (a.humidity != null ? ` · ${fmtNum(a.humidity)}% humidity` : ''))
      : null,
    !compact && list.length > 1 ? h('div', { class: 'wx-days' }, list.slice(1, 5).map((d, i) => h('div', { class: 'wx-day' },
      h('span', { class: 'wx-dn' }, dayName(d.datetime, i + 1)),
      ico(weatherIcon(d.condition)),
      h('span', { class: 'wx-dt' }, d.temperature != null ? `${Math.round(d.temperature)}°` : '')))) : null);
}

function paintWeather() {
  const box = $('#weather');
  const eid = weatherEntity();
  if (!eid || !S.model) { if (!box.hidden) { box.hidden = true; sizeHouse(); } return; }
  loadForecast(eid);
  box.hidden = false;
  box.title = `${entName(eid)}: tap for details`;
  const wasHidden = box.hidden;
  box.replaceChildren(weatherCard(eid),
    S.plan ? h('button', { class: 'card-edit wx-edit', title: 'Choose the weather to show', onclick: (e) => { e.stopPropagation(); openWeatherEditor(); } }, ico('mdi:pencil')) : null);
  if (wasHidden) sizeHouse(); // the house may need to make room for it
}
$('#weather').addEventListener('click', () => {
  if (S.plan) { openWeatherEditor(); return; }
  const eid = weatherEntity();
  if (eid) openEntity(eid);
});

/** Edit-mode dialog: pick which weather entity the house shows. */
function openWeatherEditor() {
  if (!S.admin) return;
  W = JSON.parse(JSON.stringify(S.layout));
  W.settings ||= {};
  const ed = $('#card-editor');
  const preview = h('div', { class: 'card-preview' });
  const drawPreview = () => {
    const eid = weatherEntity(W.settings);
    preview.replaceChildren(eid ? h('div', { class: 'wx preview' }, weatherCard(eid)) : h('span', { class: 'muted' }, 'No weather on the house'));
    if (eid) loadForecast(eid);
  };
  const close = () => { ed.hidden = true; W = null; };
  ed.replaceChildren(h('div', { class: 'modal-card card-dialog', role: 'dialog', 'aria-label': 'Weather' },
    h('div', { class: 'modal-head' }, h('h2', {}, 'Weather'), h('button', { class: 'sb-close', onclick: close, title: 'Close' }, ico('mdi:close'))),
    h('div', { class: 'modal-body card-body' },
      h('div', { class: 'card-form' },
        h('label', { class: 'field' }, h('span', {}, 'Show weather from'), weatherSelect(drawPreview)),
        h('p', { class: 'muted' }, 'Any weather integration you have in Home Assistant works. Automatic uses Home Assistant’s own Met.no weather when you have it.')),
      h('div', { class: 'card-side' }, h('span', { class: 'muted' }, 'Preview'), preview)),
    h('div', { class: 'modal-foot' }, h('span', { class: 'spacer' }), act('Cancel', null, close, 'small'),
      act('Save', 'mdi:content-save', async () => { S.layout = W; close(); await saveLayout(); paintWeather(); toast('Weather saved'); }, 'small primary'))));
  ed.hidden = false;
  drawPreview();
}
/** <select> bound to W.settings.weather: Automatic, each weather entity, or none. */
function weatherSelect(onChange) {
  const opts = weatherEntities();
  const auto = opts[0];
  const sel = h('select', { class: 'wx-select' },
    h('option', { value: '' }, auto ? `Automatic (${auto.full_name}${auto.platform === 'met' ? ', Met.no' : ''})` : 'Automatic (no weather found)'),
    opts.map((e) => h('option', { value: e.entity_id }, `${e.full_name} · ${e.platform === 'met' ? 'Met.no' : pretty(e.platform || 'weather')}`)),
    h('option', { value: 'none' }, "Don't show weather"));
  sel.value = W.settings.weather || '';
  sel.addEventListener('change', () => {
    if (sel.value) W.settings.weather = sel.value; else delete W.settings.weather;
    onChange?.();
  });
  return sel;
}

function paintHouse() {
  paintWeather();
  for (const r of S.rooms) {
    const st = roomStats(r.aid);
    r.stats = st;
    const empty = st.devices === 0;
    r.el.classList.toggle('lit', st.lights > 0);
    r.el.classList.toggle('empty', empty);
    r.count.querySelector('text').textContent = st.leaves; // what the room's wheel will show
    r.label.classList.toggle('lit', st.lights > 0);
    r.label.classList.toggle('empty', empty);
    r.label.querySelector('.chips').replaceChildren(...st.chips.map((c) => h('span', { title: c.eid ? entName(c.eid) : null }, ico(c.icon), c.text)));
  }
}

function sizeHouse() {
  const g = S.houseGeom;
  if (!g) return;
  const stage = $('#stage');
  const availW = stage.clientWidth * 0.96;
  const bar = S.plan ? $('#plan-bar').offsetHeight + 20 : 0; // keep the house clear of the plan toolbar
  // On portrait screens the house is as wide as the screen, so it starts below the weather card.
  const wxEl = $('#weather');
  wxEl.style.top = `${bar + 12}px`;
  const portrait = stage.clientWidth < stage.clientHeight;
  const wxSpace = portrait && !wxEl.hidden ? wxEl.offsetHeight + 16 : 0;
  const top = bar + wxSpace;
  houseView.style.paddingTop = top ? `${top}px` : '';
  const availH = stage.clientHeight - 24 - top;
  const w = Math.min(availW, availH * (g.W / g.H), 1300 * (g.W / HW));
  const frame = $('#house-frame');
  frame.style.width = `${w}px`;
  frame.style.height = `${(w * g.H) / g.W}px`;
  frame.style.fontSize = `${Math.max(10.5, (w / g.W) * 15)}px`;
}

function setHouseFocus(idx, fromPointer = false) {
  S.houseFocus = idx;
  S.rooms.forEach((r, i) => {
    r.el.classList.toggle('focus', i === idx);
    r.label.classList.toggle('hover', i === idx);
  });
  const r = S.rooms[idx];
  if (!r || r.stats?.devices === 0) { hideTooltip(); return; }
  const box = r.el.getBoundingClientRect();
  const tip = $('#tooltip');
  const st = r.stats;
  tip.replaceChildren(...[
    h('h4', {}, areaName(r.aid)),
    h('div', { class: 'row' }, 'Devices', h('b', {}, st.devices)),
    // Exactly what the room card shows, in the same order (so a chosen temperature sensor wins over the automatic one).
    ...st.chips.map((c) => h('div', { class: 'row' }, h('span', { class: 'tip-label' }, ico(c.icon), c.label), h('b', {}, c.value ?? c.text))),
  ].filter(Boolean));
  tip.hidden = false;
  const tw = tip.offsetWidth;
  const left = clamp(box.left + box.width / 2, tw / 2 + 8, innerWidth - tw / 2 - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(box.top - 10, tip.offsetHeight + 30)}px`;
  if (!fromPointer) r.el.scrollIntoView?.({ block: 'nearest' });
}
function hideTooltip() { $('#tooltip').hidden = true; }

$('#house').addEventListener('pointerover', (e) => {
  if (S.plan) return;
  const t = e.target.closest('[data-idx]');
  if (t) setHouseFocus(+t.dataset.idx, true);
});
$('#house').addEventListener('pointerleave', () => { setHouseFocus(-1, true); });
$('#house').addEventListener('click', (e) => {
  if (S.plan) return;
  const t = e.target.closest('[data-idx]');
  if (!t) return;
  const r = S.rooms[+t.dataset.idx];
  if (r && r.stats?.devices) enterArea(r.aid, r);
});

// ===================================================================
// Weapon wheel
// ===================================================================
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rad = (deg) => (deg * Math.PI) / 180;
const pt = (a, r) => [Math.cos(rad(a)) * r, Math.sin(rad(a)) * r];

/**
 * Annular slice from angle a0 to a1 (degrees). `gap` is the width of the channel between
 * neighbouring slices in user units: each edge is offset by gap/2 perpendicular to its
 * radial line, so the channel has parallel sides instead of widening outwards.
 */
function sectorPath(a0, a1, r0, r1, gap = 0) {
  if (a1 - a0 >= 359.99) {
    return `M${r1},0A${r1},${r1} 0 1 1 ${-r1},0A${r1},${r1} 0 1 1 ${r1},0Z`
      + `M${r0},0A${r0},${r0} 0 1 0 ${-r0},0A${r0},${r0} 0 1 0 ${r0},0Z`;
  }
  const off = (r) => (Math.asin(Math.min(1, gap / 2 / r)) * 180) / Math.PI;
  const span = a1 - a0;
  // Never let the offsets eat the whole slice (tiny slices mid-animation).
  const dO = Math.min(off(r1), span * 0.45), dI = Math.min(off(r0), span * 0.45);
  const o0 = a0 + dO, o1 = a1 - dO, i0 = a0 + dI, i1 = a1 - dI;
  const largeO = o1 - o0 > 180 ? 1 : 0, largeI = i1 - i0 > 180 ? 1 : 0;
  const [x0, y0] = pt(o0, r1), [x1, y1] = pt(o1, r1), [x2, y2] = pt(i1, r0), [x3, y3] = pt(i0, r0);
  return `M${x0},${y0}A${r1},${r1} 0 ${largeO} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${largeI} 0 ${x3},${y3}Z`;
}

class Wheel {
  constructor() {
    this.el = $('#wheel');
    this.segG = $('#wheel-segs');
    this.labelBox = $('#wheel-labels');
    this.centerEl = $('#wheel-center');
    this.items = [];
    this.opts = {};
    this.page = 0;
    this.per = 10;
    this.hover = -1;      // index within page, -1 none, -2 center
    this.t = 0;
    this.R = 312;
    this.r = 120;
    this.segs = [];
    this.labels = [];
    this._anim = null;
  }
  get pages() { return Math.max(1, Math.ceil(this.items.length / this.per)); }
  get pageItems() { return this.items.slice(this.page * this.per, (this.page + 1) * this.per); }

  set(items, opts = {}) {
    this.items = items;
    this.opts = opts;
    this.page = clamp(opts.page || 0, 0, this.pages - 1);
    this.hover = -1;
    this.build();
  }
  /** Refresh item content in place (live state updates). */
  update(items) {
    const same = items.length === this.items.length && items.every((it, i) => it.id === this.items[i].id);
    this.items = items;
    if (!same) { this.page = clamp(this.page, 0, this.pages - 1); this.build(); return; }
    this.pageItems.forEach((it, i) => this.fillLabel(this.labels[i], it));
    this.paintClasses();
    this.renderCenter();
  }
  fillLabel(el, it) {
    el.replaceChildren(ico(it.icon), h('div', { class: 'lbl' }, it.label), it.sub ? h('div', { class: 'sub' }, it.sub) : null);
  }
  build() {
    const items = this.pageItems;
    this.segs = items.map((it, i) => s('path', { class: 'seg', 'data-i': i }));
    this.labels = items.map((it) => { const el = h('div', { class: 'w-label' }); this.fillLabel(el, it); return el; });
    this.segG.replaceChildren(...this.segs);
    this.labelBox.replaceChildren(...this.labels);
    const many = this.pages > 1;
    $('#page-prev').classList.toggle('show', many);
    $('#page-next').classList.toggle('show', many);
    $('#page-dots').replaceChildren(...(many ? Array.from({ length: this.pages }, (_, i) => h('span', { class: i === this.page ? 'on' : '' })) : []));
    this.paintClasses();
    this.draw(this.t);
    this.renderCenter();
  }
  paintClasses() {
    const items = this.pageItems;
    items.forEach((it, i) => {
      const cls = (el) => {
        el.classList.toggle('active', !!it.active);
        el.classList.toggle('hover', i === this.hover);
        el.classList.toggle('selected', it.id === this.opts.selectedId);
      };
      cls(this.segs[i]);
      cls(this.labels[i]);
    });
    this.centerEl.classList.toggle('hover', this.hover === -2);
  }
  draw(t) {
    this.t = t;
    const items = this.pageItems;
    const n = items.length;
    if (!n) return;
    const e = easeInOut(t);
    const span = 360 / n;
    const gap = n === 1 ? 0 : 7; // channel width between slices, in wheel units
    const anchor = -90;
    const swirl = (1 - e) * -50;
    const mapA = (a) => anchor + (a - anchor) * e + swirl;
    const Ro = this.r + (this.R - this.r) * (0.12 + 0.88 * e);
    const W = 660;
    items.forEach((it, i) => {
      const hov = i === this.hover && t === 1;
      const a0 = -90 - span / 2 + i * span;
      const a1 = a0 + span;
      const r0 = this.r + 6 + (hov ? 6 : 0);
      const r1 = Ro + (hov ? 14 : 0);
      this.segs[i].setAttribute('d', sectorPath(mapA(a0), mapA(a1), r0, r1, gap));
      this.segs[i].style.opacity = Math.min(1, e * 1.6);
      const mid = mapA((a0 + a1) / 2);
      const [x, y] = pt(mid, (r0 + r1) / 2 + (n === 1 ? 0 : 4));
      const lb = this.labels[i];
      lb.style.left = `${((x + W / 2) / W) * 100}%`;
      lb.style.top = `${((y + W / 2) / W) * 100}%`;
      lb.style.opacity = e * e * e;
      const maxW = n <= 2 ? 9 : n <= 4 ? 8 : n <= 7 ? 7 : 6;
      lb.style.width = `${maxW}em`;
    });
    this.centerEl.style.opacity = 0.3 + 0.7 * e;
  }
  animate(to, dur) {
    if (this._anim) cancelAnimationFrame(this._anim.raf);
    const from = this.t;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) dur = 1;
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = clamp((now - start) / dur, 0, 1);
        this.draw(from + (to - from) * k);
        if (k < 1) this._anim = { raf: requestAnimationFrame(step) };
        else { this._anim = null; this.paintClasses(); resolve(); }
      };
      this._anim = { raf: requestAnimationFrame(step) };
    });
  }
  open() { return this.animate(1, 460); }
  close() { this.setHover(-1); return this.animate(0, 280); }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this.paintClasses();
    if (this.t === 1) this.draw(1);
    this.renderCenter();
  }
  renderCenter() {
    const c = this.centerEl;
    const it = this.hover >= 0 ? this.pageItems[this.hover] : null;
    const o = this.opts.center || {};
    if (it) {
      c.replaceChildren(ico(it.icon), h('div', { class: 'c-title' }, it.label), it.sub ? h('div', { class: 'c-sub' }, it.sub) : null);
    } else {
      c.replaceChildren(ico(o.icon || 'mdi:home'), h('div', { class: 'c-title' }, o.title || ''),
        o.sub ? h('div', { class: 'c-sub' }, o.sub) : null,
        h('div', { class: 'c-back' }, ico('mdi:arrow-u-left-top'), ' Back'));
    }
  }
  hitTest(clientX, clientY) {
    const box = this.el.getBoundingClientRect();
    const k = 660 / box.width;
    const dx = (clientX - (box.left + box.width / 2)) * k;
    const dy = (clientY - (box.top + box.height / 2)) * k;
    const dist = Math.hypot(dx, dy);
    if (dist < this.r) return -2;
    if (dist > this.R + 16) return -1; // outside the wheel: nothing to aim at or click
    const n = this.pageItems.length;
    if (!n) return -1;
    const span = 360 / n;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    return Math.floor((((ang + 90 + span / 2) % 360) + 360) % 360 / span) % n;
  }
  async turnPage(dir) {
    if (this.pages < 2 || this._paging) return;
    this._paging = true;
    await this.animate(0, 180);
    this.page = (this.page + dir + this.pages) % this.pages;
    this.hover = -1;
    this.build();
    await this.animate(1, 300);
    this._paging = false;
  }
  current() { return this.hover >= 0 ? this.pageItems[this.hover] : null; }
  moveHover(dir) {
    const n = this.pageItems.length;
    if (!n) return;
    const cur = this.hover < 0 ? (dir > 0 ? -1 : 0) : this.hover;
    this.setHover((cur + dir + n) % n);
  }
}
const wheel = new Wheel();

const busy = { v: false };
async function guard(fn) {
  if (busy.v) return;
  busy.v = true;
  try { await fn(); } finally { busy.v = false; }
}

wheelView.addEventListener('pointermove', (e) => {
  if (busy.v || wheel.t !== 1) return;
  wheel.setHover(wheel.hitTest(e.clientX, e.clientY));
});
wheelView.addEventListener('pointerdown', (e) => {
  if (wheel.t === 1) wheel.setHover(wheel.hitTest(e.clientX, e.clientY));
});
wheelView.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse') wheel.setHover(-1);
});
wheelView.addEventListener('click', (e) => {
  if (e.target.closest('.page-btn') || busy.v || wheel.t !== 1) return;
  const hit = wheel.hitTest(e.clientX, e.clientY);
  if (hit === -2) back();
  else if (hit >= 0) wheel.opts.onSelect?.(wheel.pageItems[hit]);
});
wheelView.addEventListener('contextmenu', (e) => {
  const hit = wheel.hitTest(e.clientX, e.clientY);
  if (S.admin && hit >= 0 && wheel.opts.onHide) {
    e.preventDefault();
    wheel.opts.onHide(wheel.pageItems[hit]);
  }
});
let wheelScrollAt = 0;
wheelView.addEventListener('wheel', (e) => {
  if (wheel.pages < 2) return;
  e.preventDefault();
  if (Date.now() - wheelScrollAt < 350) return;
  wheelScrollAt = Date.now();
  wheel.turnPage(e.deltaY > 0 ? 1 : -1);
}, { passive: false });
$('#page-prev').addEventListener('click', () => wheel.turnPage(-1));
$('#page-next').addEventListener('click', () => wheel.turnPage(1));

// ===================================================================
// Navigation
// ===================================================================
const GROUP = 'grp:';
const isGroupId = (id) => typeof id === 'string' && id.startsWith(GROUP);

/** A room's devices, with 2+ devices of the same integration folded into one group. */
function roomGroups(aid) {
  const nodes = visibleNodes(aid);
  if (M().custom) { // groups you made yourself
    const defs = new Set((M().areas[aid]?.groups || []).map((g) => g.id));
    const groups = {}, loose = [];
    for (const nid of nodes) {
      const gid = M().devices[nid].group;
      if (gid && defs.has(gid)) (groups[gid] ||= []).push(nid); else loose.push(nid);
    }
    return { groups, loose };
  }
  if (setting('noGrouping')) return { groups: {}, loose: nodes };
  const byIntegration = {};
  for (const nid of nodes) {
    const d = M().devices[nid];
    if (!d.virtual && d.integration) (byIntegration[d.integration] ||= []).push(nid);
  }
  const groups = Object.fromEntries(Object.entries(byIntegration).filter(([, ids]) => ids.length >= 2));
  const grouped = new Set(Object.values(groups).flat());
  // A room that would become a single group gains nothing from grouping - show its devices directly.
  if (Object.keys(groups).length === 1 && grouped.size === nodes.length) return { groups: {}, loose: nodes };
  return { groups, loose: nodes.filter((n) => !grouped.has(n)) };
}
/** Name and icon of a group leaf: an integration, or one of your own groups. */
function groupInfo(aid, key) {
  if (M().custom) {
    const g = (M().areas[aid]?.groups || []).find((x) => x.id === key);
    return { name: g?.name || 'Group', icon: g?.icon || 'mdi:folder-outline' };
  }
  return { name: L('areas', aid).groups?.[key]?.name || integrationName(key), icon: 'mdi:puzzle-outline' };
}
function integrationName(integ) {
  const d = Object.values(M().devices).find((x) => x.integration === integ);
  return d?.integration_name || pretty(integ);
}

function deviceItem(nid) {
  return {
    id: nid,
    label: devName(nid),
    icon: deviceIcon(nid),
    sub: deviceSub(nid),
    active: mainEntities(nid).some(isActive),
    virtual: !!M().devices[nid].virtual,
  };
}
/** Leaves of a room's wheel: integration groups and the devices that are not in a group. */
function roomItems(aid) {
  const { groups, loose } = roomGroups(aid);
  const items = loose.map(deviceItem);
  for (const [integ, ids] of Object.entries(groups)) {
    const on = ids.filter((n) => mainEntities(n).some(isActive)).length;
    items.push({
      id: GROUP + integ,
      label: groupInfo(aid, integ).name,
      icon: groupInfo(aid, integ).icon,
      sub: `${ids.length} device${ids.length === 1 ? '' : 's'}${on ? ` · ${on} on` : ''}`,
      active: on > 0,
    });
  }
  return items.sort((a, b) => (a.virtual === b.virtual ? a.label.localeCompare(b.label) : a.virtual ? 1 : -1));
}
function groupItems(aid, integ) {
  return (roomGroups(aid).groups[integ] || []).map(deviceItem);
}
/** Items of the device-level wheel currently on screen (a room, or one integration group in it). */
function currentDeviceItems() {
  return S.nav.group ? groupItems(S.nav.areaId, S.nav.group) : roomItems(S.nav.areaId);
}
function entityItems(nid) {
  return controlEntities(nid).map((eid) => ({
    id: eid, label: entName(eid), icon: entityIcon(eid), sub: stateLabel(eid), active: isActive(eid),
  }));
}
function deviceWheelOpts(aid, selectedId = null) {
  const st = roomStats(aid);
  const g = S.nav.group;
  const center = g
    ? { icon: groupInfo(aid, g).icon, title: groupInfo(aid, g).name, sub: `${groupItems(aid, g).length} devices in ${areaName(aid)}` }
    : { icon: roomIcon(aid), title: areaName(aid), sub: `${st.devices} device${st.devices === 1 ? '' : 's'}${st.temp ? ` · ${st.temp}` : ''}` };
  return {
    center,
    selectedId,
    onSelect: (it) => guard(() => (isGroupId(it.id) ? enterGroup(it.id.slice(GROUP.length)) : enterDevice(it.id))),
    onHide: (it) => {
      if (isGroupId(it.id)) { toast('Open the group to hide its devices'); return; }
      hideItem('devices', devKey(it.id), devName(it.id));
    },
  };
}
function entityWheelOpts(nid) {
  const d = M().devices[nid];
  return {
    center: { icon: deviceIcon(nid), title: devName(nid), sub: [d.manufacturer, d.model].filter(Boolean).join(' · ') || `${controlEntities(nid).length} controls` },
    selectedId: S.nav.entityId,
    onSelect: (it) => openEntity(it.id),
    onHide: (it) => hideItem('entities', it.id, entName(it.id)),
  };
}

async function enterArea(aid, room) {
  await guard(async () => {
    hideTooltip();
    S.nav = { level: 'devices', areaId: aid, nodeId: null, entityId: null, group: null };
    if (room) {
      const g = S.houseGeom;
      const frame = $('#house-frame').getBoundingClientRect();
      const stage = houseView.getBoundingClientRect();
      const ox = frame.left - stage.left + ((room.x + room.w / 2) / g.W) * frame.width;
      const oy = frame.top - stage.top + ((room.y + room.h / 2) / g.H) * frame.height;
      houseView.style.transformOrigin = `${ox}px ${oy}px`;
    }
    houseView.classList.add('leaving');
    renderCrumbs();
    await sleep(280);
    wheel.t = 0;
    wheel.set(roomItems(aid), deviceWheelOpts(aid));
    wheelView.classList.remove('hidden');
    await wheel.open();
  });
}

async function enterDevice(nid) {
  if (M().devices[nid]?.single) { // a single entity placed in a custom room
    closeSidebar();
    openEntity(M().devices[nid].entities[0]);
    wheel.opts.selectedId = nid;
    wheel.paintClasses();
    return;
  }
  const ctl = controlEntities(nid);
  // Nothing to operate (e.g. a temperature sensor): just show its readings in the sidebar.
  // One control and "skip" turned on: go straight to it.
  if (!ctl.length || (setting('skipSingleEntity') && ctl.length === 1)) {
    openDevicePanel(nid);
    if (ctl.length) openEntity(ctl[0]);
    wheel.opts.selectedId = nid;
    wheel.paintClasses();
    return;
  }
  closeSidebar();
  await wheel.close();
  S.nav.level = 'entities';
  S.nav.nodeId = nid;
  S.nav.entityId = null;
  wheel.set(entityItems(nid), entityWheelOpts(nid));
  if (infoEntities(nid).length) openDevicePanel(nid);
  renderCrumbs();
  await wheel.open();
}

/** Sidebar panel for a device: its sensor readings, settings and diagnostics. */
function openDevicePanel(nid) {
  S.nav.panel = nid;
  S.nav.entityId = null;
  renderSidebar();
  document.body.classList.add('sidebar-open');
  $('#sidebar').setAttribute('aria-hidden', 'false');
  renderCrumbs();
}
/** From an entity back to its device panel. */
function backToPanel() {
  S.nav.entityId = null;
  if (S.nav.level === 'entities') { wheel.opts.selectedId = null; wheel.paintClasses(); }
  renderSidebar();
  renderCrumbs();
}

async function leaveDevice() {
  const nid = S.nav.nodeId;
  closeSidebar();
  await wheel.close();
  S.nav.level = 'devices';
  S.nav.nodeId = null;
  const items = currentDeviceItems();
  const idx = items.findIndex((it) => it.id === nid);
  wheel.set(items, { ...deviceWheelOpts(S.nav.areaId), page: idx >= 0 ? Math.floor(idx / wheel.per) : 0 });
  renderCrumbs();
  await wheel.open();
}

/** Open an integration group: a wheel with just that integration's devices in this room. */
async function enterGroup(integ) {
  closeSidebar();
  await wheel.close();
  S.nav.group = integ;
  wheel.set(groupItems(S.nav.areaId, integ), deviceWheelOpts(S.nav.areaId));
  renderCrumbs();
  await wheel.open();
}
/** Back to the room wheel (from a group, a device or an entity). */
async function goRoom() {
  const n = S.nav;
  if (n.level === 'devices' && !n.group) { closeSidebar(); return; }
  const from = n.group ? GROUP + n.group : n.nodeId;
  closeSidebar();
  await wheel.close();
  Object.assign(n, { level: 'devices', group: null, nodeId: null, entityId: null });
  const items = roomItems(n.areaId);
  const idx = items.findIndex((it) => it.id === from);
  wheel.set(items, { ...deviceWheelOpts(n.areaId), page: idx >= 0 ? Math.floor(idx / wheel.per) : 0 });
  renderCrumbs();
  await wheel.open();
}

async function goHouse() {
  closeSidebar();
  if (S.nav.level !== 'house') await wheel.close();
  S.nav = { level: 'house', areaId: null, nodeId: null, entityId: null, group: null };
  wheelView.classList.add('hidden');
  houseView.classList.remove('leaving');
  buildHouse();
  renderCrumbs();
}

function back() {
  guard(async () => {
    if (S.nav.level === 'entities') await leaveDevice();
    else if (S.nav.level === 'devices' && S.nav.group) await goRoom();
    else if (S.nav.level === 'devices') await goHouse();
  });
}

function openEntity(eid) {
  S.nav.entityId = eid;
  S.history[eid] = null;
  renderSidebar();
  document.body.classList.add('sidebar-open');
  $('#sidebar').setAttribute('aria-hidden', 'false');
  if (S.nav.level === 'entities') { wheel.opts.selectedId = eid; wheel.paintClasses(); }
  renderCrumbs();
}
function closeSidebar() {
  stopCamera();
  S.nav.panel = null;
  if (!document.body.classList.contains('sidebar-open')) return;
  document.body.classList.remove('sidebar-open');
  $('#sidebar').setAttribute('aria-hidden', 'true');
  S.nav.entityId = null;
  if (wheel.opts) { wheel.opts.selectedId = null; wheel.paintClasses(); }
  renderCrumbs();
}

function renderCrumbs() {
  markActive(); // every navigation step passes through here
  updatePlanButton();
  // Home button: shown in the wheels (and on the house while a sidebar is open), back to the house in one tap.
  $('#btn-home').hidden = S.nav.level === 'house' && !document.body.classList.contains('sidebar-open');
  const c = $('#crumbs');
  document.title = houseName();
  const parts = [[houseName(), () => guard(goHouse)]];
  const n = S.nav;
  if (n.areaId && M().areas[n.areaId]) {
    const fid = areaFloor(n.areaId);
    const f = allFloors().find((x) => x.id === fid);
    if (f && (isOutdoorFloor(f) || M().floors.length > 1)) parts.push([floorName(f), () => guard(goHouse)]);
    const inside = n.level === 'entities' || n.group || n.panel;
    parts.push([areaName(n.areaId), inside ? () => guard(goRoom) : null]);
    if (n.group) parts.push([groupInfo(n.areaId, n.group).name, n.level === 'entities' ? () => guard(leaveDevice) : (n.panel ? closeSidebar : null)]);
  }
  const dev = n.nodeId || n.panel;
  if (dev && M().devices[dev]) parts.push([devName(dev), n.entityId ? (n.panel ? backToPanel : closeSidebar) : null]);
  if (n.entityId && M().entities[n.entityId]) parts.push([entName(n.entityId), null]);
  const els = [];
  parts.forEach(([label, fn], i) => {
    if (i) els.push(h('span', { class: 'sep' }, '›'));
    const last = i === parts.length - 1;
    els.push(h('button', { class: last ? 'current' : '', onclick: last ? null : fn }, label));
  });
  c.replaceChildren(...els);
}

function hideItem(kind, key, label) {
  if (!S.admin) return;
  const prev = { ...(S.layout[kind][key] || {}) };
  S.layout[kind][key] = { ...prev, hidden: true };
  saveLayout().then(() => {
    toast(`Hidden “${label}”`, '', {
      label: 'UNDO',
      fn: () => { S.layout[kind][key] = prev; saveLayout().then(rerenderAll); },
    });
  });
  if (kind === 'entities' && S.nav.entityId === key) closeSidebar();
  rerenderAll();
}

async function saveLayout() {
  try {
    S.layout = await api('api/layout', { method: 'PUT', body: JSON.stringify(S.layout) });
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'err');
  }
  refreshView();
}

/** Re-render whatever view is active after model/layout changes. */
function rerenderAll() {
  const n = S.nav;
  if (n.level !== 'house' && (!M().areas[n.areaId] || !visibleNodes(n.areaId).length)) {
    goHouse();
    return;
  }
  if (n.group && !roomGroups(n.areaId).groups[n.group]) n.group = null; // group dissolved (e.g. a device hidden)
  if (n.level === 'entities' && (!M().devices[n.nodeId] || !visibleNodes(n.areaId).includes(n.nodeId) || !controlEntities(n.nodeId).length)) {
    leaveDevice();
    return;
  }
  if (n.entityId && (!M().entities[n.entityId] || isHidden('entities', n.entityId))) {
    if (n.panel) n.entityId = null; else closeSidebar();
  }
  if (n.panel && (!M().devices[n.panel] || isHidden('devices', devKey(n.panel)))) closeSidebar();
  if (n.level === 'house') buildHouse();
  else if (n.level === 'devices') { wheel.opts = deviceWheelOpts(n.areaId, wheel.opts.selectedId); wheel.update(currentDeviceItems()); }
  else { wheel.opts = entityWheelOpts(n.nodeId); wheel.update(entityItems(n.nodeId)); }
  if (n.entityId || n.panel) renderSidebar();
  renderCrumbs();
}

// ===================================================================
// Sidebar (entity actions)
// ===================================================================
async function svc(domain, service, data = {}, eid = S.nav.entityId) {
  try {
    await api('api/call', { method: 'POST', body: JSON.stringify({ domain, service, entity_id: eid, data }) });
  } catch (err) {
    toast(`${domain}.${service} failed: ${err.message}`, 'err');
  }
}
const sec = (title, ...kids) => h('div', { class: 'sec' }, title ? h('h3', {}, title) : null, ...kids);
const row = (...kids) => h('div', { class: 'row-btns' }, ...kids);
const act = (label, icon, fn, cls = '') => h('button', { class: `act ${cls}`, onclick: fn }, icon ? ico(icon) : null, label);

function slider({ min, max, step = 1, value, fmt = (v) => v, onchange, label = '' }) {
  const out = h('b', {}, fmt(value));
  const inp = h('input', { type: 'range', min, max, step });
  inp.value = value;
  const done = () => setTimeout(() => { S.interacting = false; }, 60);
  inp.addEventListener('pointerdown', () => { S.interacting = true; });
  inp.addEventListener('pointerup', done);
  inp.addEventListener('pointercancel', done);
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); });
  inp.addEventListener('change', () => { S.interacting = false; onchange(+inp.value); });
  return h('div', { class: 'ctl' }, h('label', {}, h('span', {}, label), out), inp);
}
function chips(options, current, onpick, fmt = pretty) {
  return row(...(options || []).map((o) => act(fmt(o), null, () => onpick(o), `small ${o === current ? 'on' : ''}`)));
}
function stepper(value, step, min, max, unit, onset) {
  let v = Number(value);
  const valEl = h('div', { class: 'val' }, `${fmtNum(v)}${unit}`);
  let timer = null;
  const bump = (d) => {
    v = clamp(Math.round((v + d) / step) * step, min ?? -Infinity, max ?? Infinity);
    valEl.textContent = `${fmtNum(v)}${unit}`;
    S.interacting = true;
    clearTimeout(timer);
    timer = setTimeout(() => { S.interacting = false; onset(v); }, 700);
  };
  return h('div', { class: 'stepper' },
    act('', 'mdi:minus', () => bump(-step), 'small'), valEl, act('', 'mdi:plus', () => bump(step), 'small'));
}
function toggleBig(eid) {
  const on = S.states[eid].state === 'on';
  const d = domainOf(eid);
  return act(on ? 'Turn off' : 'Turn on', 'mdi:power', () => svc(d, on ? 'turn_off' : 'turn_on'), `toggle-big ${on ? 'on' : ''}`);
}
function textSetter(placeholder, value, onset, type = 'text') {
  const inp = h('input', { class: 'txt', type, placeholder });
  inp.value = value ?? '';
  const go = () => onset(inp.value);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); e.stopPropagation(); });
  return row(inp, act('Set', 'mdi:check', go, 'small primary'));
}
function colorPicker(a) {
  const hues = [0, 25, 45, 120, 175, 210, 260, 300];
  const picker = h('input', { type: 'color' });
  if (a.rgb_color) picker.value = `#${a.rgb_color.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  picker.addEventListener('change', () => {
    const hex = picker.value.slice(1);
    svc('light', 'turn_on', { rgb_color: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) });
  });
  return h('div', { class: 'swatches' },
    hues.map((hue) => h('button', {
      class: 'swatch', title: `Hue ${hue}`, style: `background:hsl(${hue},100%,55%)`,
      onclick: () => svc('light', 'turn_on', { hs_color: [hue, 100] }),
    })),
    picker);
}

function controls(eid) {
  const st = S.states[eid];
  const a = st.attributes || {};
  const v = st.state;
  const d = domainOf(eid);
  const out = [];
  if (v === 'unavailable') return [sec(null, h('p', { class: 'muted' }, 'This entity is currently unavailable.'))];
  const call = (service, data) => () => svc(d, service, data);

  switch (d) {
    case 'light': {
      out.push(sec(null, toggleBig(eid)));
      const modes = a.supported_color_modes || [];
      if (modes.some((m) => m !== 'onoff')) {
        out.push(sec('Brightness', slider({
          min: 1, max: 100, value: v === 'on' ? Math.max(1, Math.round((a.brightness || 0) / 2.55)) : 1,
          fmt: (x) => `${x}%`, onchange: (x) => svc('light', 'turn_on', { brightness_pct: x }),
        })));
      }
      if (modes.includes('color_temp')) {
        const lo = a.min_color_temp_kelvin || 2000, hi = a.max_color_temp_kelvin || 6500;
        out.push(sec('Color temperature', slider({
          min: lo, max: hi, step: 50, value: a.color_temp_kelvin || Math.round((lo + hi) / 2),
          fmt: (x) => `${x} K`, onchange: (x) => svc('light', 'turn_on', { color_temp_kelvin: x }),
        })));
      }
      if (modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m))) out.push(sec('Color', colorPicker(a)));
      if (a.effect_list?.length) out.push(sec('Effect', chips(a.effect_list, a.effect, (x) => svc('light', 'turn_on', { effect: x }), String)));
      break;
    }
    case 'switch': case 'input_boolean': case 'siren': case 'remote': case 'automation': case 'humidifier':
      out.push(sec(null, toggleBig(eid)));
      if (d === 'automation') out.push(sec(null, row(act('Run actions now', 'mdi:play', call('trigger')))));
      if (d === 'humidifier' && a.humidity != null) {
        out.push(sec('Target humidity', slider({ min: a.min_humidity ?? 0, max: a.max_humidity ?? 100, value: a.humidity, fmt: (x) => `${x}%`, onchange: (x) => svc(d, 'set_humidity', { humidity: x }) })));
      }
      if (d === 'humidifier' && a.available_modes) out.push(sec('Mode', chips(a.available_modes, a.mode, (x) => svc(d, 'set_mode', { mode: x }))));
      break;
    case 'fan':
      out.push(sec(null, toggleBig(eid)));
      if ('percentage' in a) {
        out.push(sec('Speed', slider({ min: 0, max: 100, step: a.percentage_step ? Number(a.percentage_step.toFixed(2)) : 1, value: a.percentage || 0, fmt: (x) => `${Math.round(x)}%`, onchange: (x) => svc('fan', 'set_percentage', { percentage: Math.round(x) }) })));
      }
      if ('oscillating' in a) out.push(sec(null, row(act(a.oscillating ? 'Oscillating' : 'Oscillate', 'mdi:arrow-oscillating', call('oscillate', { oscillating: !a.oscillating }), a.oscillating ? 'on' : ''))));
      if (a.preset_modes?.length) out.push(sec('Preset', chips(a.preset_modes, a.preset_mode, (x) => svc('fan', 'set_preset_mode', { preset_mode: x }))));
      if ('direction' in a) out.push(sec('Direction', chips(['forward', 'reverse'], a.direction, (x) => svc('fan', 'set_direction', { direction: x }))));
      break;
    case 'cover':
      out.push(sec(null, row(
        act('Open', 'mdi:arrow-up', call('open_cover'), v === 'open' ? 'on' : ''),
        act('Stop', 'mdi:stop', call('stop_cover')),
        act('Close', 'mdi:arrow-down', call('close_cover'), v === 'closed' ? 'on' : ''))));
      if (a.current_position != null) out.push(sec('Position', slider({ min: 0, max: 100, value: a.current_position, fmt: (x) => `${x}%`, onchange: (x) => svc('cover', 'set_cover_position', { position: x }) })));
      if (a.current_tilt_position != null) out.push(sec('Tilt', slider({ min: 0, max: 100, value: a.current_tilt_position, fmt: (x) => `${x}%`, onchange: (x) => svc('cover', 'set_cover_tilt_position', { tilt_position: x }) })));
      break;
    case 'valve':
      out.push(sec(null, row(act('Open', 'mdi:valve-open', call('open_valve'), v === 'open' ? 'on' : ''), act('Close', 'mdi:valve-closed', call('close_valve'), v === 'closed' ? 'on' : ''))));
      if (a.current_position != null) out.push(sec('Position', slider({ min: 0, max: 100, value: a.current_position, fmt: (x) => `${x}%`, onchange: (x) => svc('valve', 'set_valve_position', { position: x }) })));
      break;
    case 'lock':
      out.push(sec(null, row(
        act('Lock', 'mdi:lock', call('lock'), v === 'locked' ? 'on' : ''),
        act('Unlock', 'mdi:lock-open-variant', call('unlock'), v === 'unlocked' ? 'on' : ''),
        (a.supported_features & 1) ? act('Open', 'mdi:door-open', call('open')) : null)));
      break;
    case 'climate': {
      const unit = a.unit_of_measurement || '°';
      const step = a.target_temp_step || 0.5;
      if (a.temperature != null) out.push(sec('Target', stepper(a.temperature, step, a.min_temp, a.max_temp, unit, (x) => svc('climate', 'set_temperature', { temperature: x }))));
      if (a.target_temp_low != null && a.target_temp_high != null) {
        out.push(sec('Heat to', stepper(a.target_temp_low, step, a.min_temp, a.max_temp, unit, (x) => svc('climate', 'set_temperature', { target_temp_low: x, target_temp_high: S.states[eid].attributes.target_temp_high }))));
        out.push(sec('Cool to', stepper(a.target_temp_high, step, a.min_temp, a.max_temp, unit, (x) => svc('climate', 'set_temperature', { target_temp_low: S.states[eid].attributes.target_temp_low, target_temp_high: x }))));
      }
      if (a.hvac_modes?.length) out.push(sec('Mode', chips(a.hvac_modes, v, (x) => svc('climate', 'set_hvac_mode', { hvac_mode: x }))));
      if (a.preset_modes?.length) out.push(sec('Preset', chips(a.preset_modes, a.preset_mode, (x) => svc('climate', 'set_preset_mode', { preset_mode: x }))));
      if (a.fan_modes?.length) out.push(sec('Fan', chips(a.fan_modes, a.fan_mode, (x) => svc('climate', 'set_fan_mode', { fan_mode: x }))));
      if (a.swing_modes?.length) out.push(sec('Swing', chips(a.swing_modes, a.swing_mode, (x) => svc('climate', 'set_swing_mode', { swing_mode: x }))));
      if (a.target_humidity != null) out.push(sec('Target humidity', slider({ min: a.min_humidity ?? 0, max: a.max_humidity ?? 100, value: a.target_humidity, fmt: (x) => `${x}%`, onchange: (x) => svc('climate', 'set_humidity', { humidity: x }) })));
      break;
    }
    case 'water_heater':
      if (a.temperature != null) out.push(sec('Target', stepper(a.temperature, a.target_temp_step || 1, a.min_temp, a.max_temp, a.unit_of_measurement || '°', (x) => svc(d, 'set_temperature', { temperature: x }))));
      if (a.operation_list?.length) out.push(sec('Mode', chips(a.operation_list, a.operation_mode || v, (x) => svc(d, 'set_operation_mode', { operation_mode: x }))));
      break;
    case 'media_player': {
      const off = v === 'off' || v === 'standby';
      if (a.entity_picture && !off) out.push(h('img', { class: 'media-art', src: a.entity_picture, alt: '' }));
      if (a.media_title) out.push(h('div', { class: 'media-meta' }, h('b', {}, a.media_title), h('span', { class: 'muted' }, a.media_artist || a.media_series_title || a.app_name || '')));
      if (!off) {
        out.push(sec(null, row(
          act('', 'mdi:skip-previous', call('media_previous_track')),
          act('', v === 'playing' ? 'mdi:pause' : 'mdi:play', call('media_play_pause'), 'primary'),
          act('', 'mdi:skip-next', call('media_next_track')))));
        if (a.volume_level != null) {
          out.push(sec('Volume', slider({ min: 0, max: 100, value: Math.round(a.volume_level * 100), fmt: (x) => `${x}%`, onchange: (x) => svc(d, 'volume_set', { volume_level: x / 100 }) }),
            row(act(a.is_volume_muted ? 'Unmute' : 'Mute', a.is_volume_muted ? 'mdi:volume-off' : 'mdi:volume-high', call('volume_mute', { is_volume_muted: !a.is_volume_muted }), `small ${a.is_volume_muted ? 'on' : ''}`))));
        }
        if (a.source_list?.length) out.push(sec('Source', chips(a.source_list, a.source, (x) => svc(d, 'select_source', { source: x }), String)));
        if (a.sound_mode_list?.length) out.push(sec('Sound mode', chips(a.sound_mode_list, a.sound_mode, (x) => svc(d, 'select_sound_mode', { sound_mode: x }), String)));
      }
      out.push(sec(null, row(act(off ? 'Turn on' : 'Turn off', 'mdi:power', call(off ? 'turn_on' : 'turn_off'), off ? 'primary' : 'danger'))));
      break;
    }
    case 'scene':
      out.push(sec(null, act('Activate scene', 'mdi:play', call('turn_on'), 'toggle-big primary')));
      break;
    case 'script':
      out.push(sec(null, row(act('Run', 'mdi:play', call('turn_on'), 'toggle-big primary'), v === 'on' ? act('Stop', 'mdi:stop', call('turn_off'), 'danger') : null)));
      break;
    case 'button': case 'input_button':
      out.push(sec(null, act('Press', 'mdi:gesture-tap-button', call('press'), 'toggle-big primary')));
      break;
    case 'number': case 'input_number': {
      const min = Number(a.min ?? 0), max = Number(a.max ?? 100), step = Number(a.step ?? 1);
      const unit = a.unit_of_measurement ? ` ${a.unit_of_measurement}` : '';
      if (a.mode === 'box' || (max - min) / step > 5000) out.push(sec('Value', textSetter(`${min} – ${max}`, v, (x) => svc(d, 'set_value', { value: Number(x) }), 'number')));
      else out.push(sec('Value', slider({ min, max, step, value: Number(v), fmt: (x) => `${fmtNum(x)}${unit}`, onchange: (x) => svc(d, 'set_value', { value: x }) })));
      break;
    }
    case 'select': case 'input_select':
      out.push(sec('Options', chips(a.options, v, (x) => svc(d, 'select_option', { option: x }), String)));
      break;
    case 'input_text': case 'text':
      out.push(sec('Value', textSetter('Text', v, (x) => svc(d, 'set_value', { value: x }))));
      break;
    case 'vacuum':
      out.push(sec(null, row(
        act('Start', 'mdi:play', call('start'), v === 'cleaning' ? 'on' : ''), act('Pause', 'mdi:pause', call('pause')),
        act('Stop', 'mdi:stop', call('stop')), act('Dock', 'mdi:home-import-outline', call('return_to_base'), v === 'docked' ? 'on' : ''),
        act('Locate', 'mdi:map-marker-question', call('locate')))));
      if (a.fan_speed_list?.length) out.push(sec('Suction', chips(a.fan_speed_list, a.fan_speed, (x) => svc(d, 'set_fan_speed', { fan_speed: x }))));
      break;
    case 'lawn_mower':
      out.push(sec(null, row(act('Mow', 'mdi:play', call('start_mowing'), v === 'mowing' ? 'on' : ''), act('Pause', 'mdi:pause', call('pause')), act('Dock', 'mdi:home-import-outline', call('dock'), v === 'docked' ? 'on' : ''))));
      break;
    case 'alarm_control_panel': {
      const code = a.code_format ? h('input', { class: 'txt', type: a.code_format === 'number' ? 'password' : 'password', inputmode: a.code_format === 'number' ? 'numeric' : 'text', placeholder: 'Code' }) : null;
      code?.addEventListener('keydown', (e) => e.stopPropagation());
      const withCode = (service) => () => svc(d, service, code?.value ? { code: code.value } : {});
      if (code) out.push(sec('Code', code));
      out.push(sec(null, row(
        act('Home', 'mdi:shield-home', withCode('alarm_arm_home'), v === 'armed_home' ? 'on' : ''),
        act('Away', 'mdi:shield-lock', withCode('alarm_arm_away'), v === 'armed_away' ? 'on' : ''),
        act('Night', 'mdi:shield-moon', withCode('alarm_arm_night'), v === 'armed_night' ? 'on' : ''),
        act('Disarm', 'mdi:shield-off', withCode('alarm_disarm'), v === 'disarmed' ? 'on' : ''))));
      break;
    }
    case 'update':
      out.push(sec('Version', h('div', {}, `Installed: ${a.installed_version ?? '–'}`), h('div', {}, `Latest: ${a.latest_version ?? '–'}`)));
      if (v === 'on') out.push(sec(null, act('Install update', 'mdi:download', call('install'), 'toggle-big primary')));
      break;
    case 'camera':
      out.push(...cameraBlock(eid));
      break;
    case 'timer':
      out.push(sec(null, row(act('Start', 'mdi:play', call('start')), act('Pause', 'mdi:pause', call('pause')), act('Cancel', 'mdi:stop', call('cancel')))));
      break;
    case 'counter':
      out.push(sec(null, row(act('', 'mdi:minus', call('decrement')), act('', 'mdi:plus', call('increment')), act('Reset', 'mdi:restore', call('reset')))));
      break;
    default: break;
  }
  return out;
}

// ---------- cameras: snapshot or live stream ----------
const cam = { session: 0, stop: null, live: {} };
const STREAM_FEATURE = 2; // CameraEntityFeature.STREAM

function stopCamera() {
  cam.session++;
  if (cam.stop) { try { cam.stop(); } catch { /* already gone */ } }
  cam.stop = null;
}
const bust = (u) => `${u}${u.includes('?') ? '&' : '?'}_=${Date.now()}`;

let hlsLoading = null;
/** Loads the bundled hls.js once; resolves to the Hls class or null. */
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoading ||= new Promise((resolve) => {
    const tag = h('script', { src: 'vendor/hls/hls.min.js' });
    tag.onload = () => resolve(window.Hls || null);
    tag.onerror = () => resolve(null);
    document.head.append(tag);
  });
  return hlsLoading;
}

function cameraBlock(eid) {
  const a = S.states[eid].attributes || {};
  const live = !!cam.live[eid];
  const setLive = (on) => { cam.live[eid] = on; renderSidebar(); };
  const box = h('div', { class: 'cam-box' });
  const badge = h('span', { class: 'cam-badge', hidden: true });
  box.append(badge);
  const switcher = h('div', { class: 'seg' },
    h('button', { class: live ? '' : 'active', onclick: () => live && setLive(false) }, ico('mdi:camera-outline'), 'Snapshot'),
    h('button', { class: live ? 'active' : '', onclick: () => !live && setLive(true) }, ico('mdi:record-circle-outline'), 'Live'));
  if (!a.entity_picture) return [sec(null, switcher), h('p', { class: 'muted' }, 'This camera has no picture right now.')];
  stopCamera();
  const session = cam.session;
  if (live) startLive(eid, box, badge, session);
  else startSnapshot(eid, box);
  const full = act('Full screen', 'mdi:fullscreen', () => {
    const media = box.querySelector('video, img');
    (media?.requestFullscreen || media?.webkitEnterFullscreen)?.call(media);
  }, 'small');
  return [sec(null, switcher), box, row(full)];
}

function startSnapshot(eid, box) {
  const img = h('img', { class: 'cam', alt: 'Camera snapshot' });
  const load = () => {
    const pic = S.states[eid]?.attributes?.entity_picture; // the access token in this URL rotates
    if (pic) img.src = bust(pic);
  };
  load();
  const timer = setInterval(load, 10000);
  box.prepend(img);
  cam.stop = () => clearInterval(timer);
}

function startMjpeg(eid, box, badge) {
  const pic = S.states[eid]?.attributes?.entity_picture || '';
  const img = h('img', { class: 'cam', alt: 'Live camera' });
  img.src = bust(pic.replace('/camera_proxy/', '/camera_proxy_stream/'));
  box.prepend(img);
  badge.hidden = false;
  badge.textContent = 'LIVE · MJPEG';
  // Dropping the src closes the long-running stream connection.
  cam.stop = () => { img.removeAttribute('src'); img.src = ''; };
}

async function startLive(eid, box, badge, session) {
  const a = S.states[eid].attributes || {};
  const current = () => session === cam.session;
  if (a.supported_features & STREAM_FEATURE) {
    try {
      const { url } = await api(`api/camera_stream?entity_id=${encodeURIComponent(eid)}`);
      if (!current()) return;
      const video = h('video', { class: 'cam', autoplay: true, playsinline: true, controls: true });
      video.muted = true; // browsers only autoplay muted video
      let hls = null;
      const stopHls = () => { hls?.destroy(); hls = null; video.removeAttribute('src'); video.load(); };
      let fellBack = false;
      const fallback = (why) => {
        if (fellBack || !current()) return;
        fellBack = true;
        console.info(`HLS stream for ${eid} failed (${why}), using MJPEG`);
        clearTimeout(watchdog);
        stopHls();
        video.remove();
        startMjpeg(eid, box, badge);
      };
      // No picture within 12 s (stream integration slow or broken) -> MJPEG.
      const watchdog = setTimeout(() => fallback('timeout'), 12000);
      video.addEventListener('playing', () => clearTimeout(watchdog), { once: true });
      video.addEventListener('error', () => fallback('playback error'));
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url; // Safari, iOS and recent Chrome play HLS natively
      } else {
        const Hls = await loadHls();
        if (!current()) { clearTimeout(watchdog); return; }
        if (!Hls || !Hls.isSupported()) { clearTimeout(watchdog); throw new Error('HLS not supported in this browser'); }
        hls = new Hls({ liveSyncDurationCount: 2 });
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) fallback(data.details); });
        hls.loadSource(url);
        hls.attachMedia(video);
      }
      box.prepend(video);
      badge.hidden = false;
      badge.textContent = 'LIVE · HLS';
      cam.stop = () => { clearTimeout(watchdog); stopHls(); };
      return;
    } catch (err) {
      if (!current()) return;
      console.info(`HLS unavailable for ${eid}, using MJPEG:`, err.message);
    }
  }
  if (current()) startMjpeg(eid, box, badge);
}

function stateBlock(eid) {
  const st = S.states[eid];
  const a = st.attributes || {};
  const d = domainOf(eid);
  let [v, u] = stateParts(eid);
  let extra = null;
  if (d === 'climate') {
    extra = [pretty(a.hvac_action || st.state), a.temperature != null ? `target ${fmtNum(a.temperature)}°` : null].filter(Boolean).join(' · ');
  } else if (d === 'light' && st.state === 'on') {
    extra = 'On';
  } else if (d === 'media_player') {
    [v, u] = [pretty(st.state), ''];
  }
  return h('div', { class: 'sb-state' },
    h('span', { class: 'v' }, v), u ? h('span', { class: 'u' }, u) : null,
    extra ? h('span', { class: 'u' }, extra) : null,
    h('span', { class: 'since' }, `Changed ${rel(st.last_changed)}`));
}

const NO_HISTORY = new Set(['button', 'input_button', 'scene', 'camera', 'update', 'script', 'image']);
const TIMELINE_COLORS = ['var(--primary)', 'var(--warn)', 'var(--ok)', '#8b5cf6', 'var(--danger)', '#14b8a6', 'var(--muted)'];

function historyBlock(eid) {
  if (NO_HISTORY.has(domainOf(eid))) return null;
  const box = h('div', { class: 'sec', id: 'history-box' }, h('h3', {}, 'Last 24 hours'));
  const cached = S.history[eid];
  if (cached && Date.now() - cached.at < 60000) {
    box.append(drawHistory(cached.data));
  } else {
    box.append(h('div', { class: 'muted' }, 'Loading…'));
    if (!cached?.loading) {
      S.history[eid] = { loading: true, at: 0 };
      api(`api/history?entity_id=${encodeURIComponent(eid)}&hours=24`)
        .then((data) => {
          S.history[eid] = { at: Date.now(), data };
          const cur = $('#history-box');
          if (cur && S.nav.entityId === eid) cur.replaceWith(historyBlock(eid));
        })
        .catch(() => { S.history[eid] = { at: Date.now(), data: { points: [] } }; });
    }
  }
  return box;
}

function drawHistory(data) {
  const pts = (data.points || []).filter((p) => p.s != null && p.s !== 'unavailable' && p.s !== 'unknown');
  if (pts.length < 2) return h('div', { class: 'muted' }, 'No history recorded.');
  const t0 = data.start, t1 = Date.now() / 1000;
  const numeric = pts.every((p) => isNumeric(p.s));
  if (numeric) {
    const vals = pts.map((p) => Number(p.s));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const X = (t) => ((Math.max(t, t0) - t0) / (t1 - t0)) * 300;
    const Y = (v) => 86 - ((v - lo) / (hi - lo)) * 80;
    let d = '';
    pts.forEach((p, i) => {
      const x = X(p.t).toFixed(1), y = Y(Number(p.s)).toFixed(1);
      d += i ? `H${x}V${y}` : `M${x},${y}`;
    });
    d += `H300`;
    const area = `${d}V90H${X(pts[0].t).toFixed(1)}Z`;
    return h('div', {},
      s('svg', { class: 'chart', viewBox: '0 0 300 90', preserveAspectRatio: 'none' },
        s('path', { class: 'area', d: area }), s('path', { class: 'ln', d })),
      h('div', { class: 'chart-axis' }, h('span', {}, `min ${fmtNum(Math.min(...vals))}`), h('span', {}, `max ${fmtNum(Math.max(...vals))}`)));
  }
  const colors = {};
  let ci = 0;
  const segs = [];
  pts.forEach((p, i) => {
    const end = i + 1 < pts.length ? pts[i + 1].t : t1;
    const start = Math.max(p.t, t0);
    if (end <= start) return;
    if (!(p.s in colors)) colors[p.s] = p.s === 'off' ? 'var(--line)' : TIMELINE_COLORS[ci++ % TIMELINE_COLORS.length];
    segs.push(h('span', { title: pretty(p.s), style: `width:${((end - start) / (t1 - t0)) * 100}%;background:${colors[p.s]}` }));
  });
  return h('div', {},
    h('div', { class: 'timeline' }, segs),
    h('div', { class: 'legend' }, Object.entries(colors).map(([k, c]) => h('span', {}, h('i', { style: `background:${c}` }), pretty(k)))));
}

function servicesBlock(eid) {
  const d = domainOf(eid);
  const list = Object.entries(M().services[d] || {}).filter(([, sp]) => !sp.required && sp.target);
  if (!list.length) return null;
  return h('details', { class: 'attrs' }, h('summary', {}, `More actions (${list.length})`),
    h('div', { class: 'row-btns', style: 'margin-top:10px' },
      list.map(([name, sp]) => act(sp.name || pretty(name), null, () => svc(d, name), 'small'))));
}

function attrsBlock(eid) {
  const a = S.states[eid].attributes || {};
  const skip = new Set(['friendly_name', 'icon', 'entity_picture', 'supported_features']);
  const rows = Object.entries(a).filter(([k]) => !skip.has(k));
  if (!rows.length) return null;
  return h('details', { class: 'attrs' }, h('summary', {}, `Attributes (${rows.length})`),
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, pretty(k)), h('td', {}, typeof v === 'object' ? JSON.stringify(v) : String(v))))));
}

function entityRow(eid) {
  const v = stateLabel(eid);
  return h('button', { class: 'ent-row', onclick: () => openEntity(eid), title: eid },
    ico(entityIcon(eid), isActive(eid) ? 'on' : ''),
    h('span', { class: 'n' }, entName(eid)),
    h('span', { class: 'v' }, v),
    ico('mdi:chevron-right', 'chev'));
}

function renderDevicePanel(nid) {
  const sb = $('#sidebar');
  const d = M().devices[nid];
  const info = infoEntities(nid);
  const readings = info.filter((e) => !category(e));
  const settings = info.filter((e) => category(e) === 'config');
  const diags = info.filter((e) => category(e) === 'diagnostic');
  const ctl = controlEntities(nid);
  const list = (ids) => h('div', { class: 'ent-list' }, ids.map(entityRow));
  const sub = [d.manufacturer, d.model].filter(Boolean).join(' · ');
  const scroll = $('.sb-body', sb)?.scrollTop || 0;
  const diagOpen = !!sb.querySelector('details.diag[open]');
  sb.replaceChildren(
    h('div', { class: 'sb-head' },
      ico(deviceIcon(nid), 'big-icon'),
      h('div', { class: 't' }, h('h2', {}, devName(nid)), sub ? h('div', { class: 'eid' }, sub) : null),
      h('button', { class: 'sb-close', title: 'Close (Esc)', onclick: closeSidebar }, ico('mdi:close'))),
    h('div', { class: 'sb-body' },
      ctl.length && S.nav.level === 'entities'
        ? h('p', { class: 'muted hint-left' }, ico('mdi:gesture-tap'), ` Pick a control on the wheel to operate it.`)
        : null,
      readings.length ? sec('Sensors', list(readings)) : null,
      settings.length ? sec('Settings', list(settings)) : null,
      diags.length ? h('details', { class: 'attrs diag', open: diagOpen }, h('summary', {}, `Diagnostics (${diags.length})`), list(diags)) : null,
      !info.length && !ctl.length ? h('p', { class: 'muted' }, 'This device has nothing to show.') : null,
      S.admin && !d.virtual ? sec('Dashboard', row(act('Hide device', 'mdi:eye-off-outline', () => hideItem('devices', devKey(nid), devName(nid)), 'small'))) : null));
  $('.sb-body', sb).scrollTop = scroll;
}

function renderSidebar() {
  stopCamera();
  const eid = S.nav.entityId;
  const sb = $('#sidebar');
  if (!eid && S.nav.panel && M().devices[S.nav.panel]) { renderDevicePanel(S.nav.panel); return; }
  if (!eid || !S.states[eid] || !M().entities[eid]) { closeSidebar(); return; }
  const scroll = $('.sb-body', sb)?.scrollTop || 0;
  const openDetails = [...sb.querySelectorAll('details[open] > summary')].map((x) => x.textContent);
  const node = M().entities[eid].node;
  const panel = S.nav.panel && M().devices[S.nav.panel] ? S.nav.panel : null;
  sb.replaceChildren(
    panel ? h('button', { class: 'sb-back', onclick: backToPanel, title: 'Back to the device (Esc)' },
      ico('mdi:chevron-left'), devName(panel)) : null,
    h('div', { class: 'sb-head' },
      ico(entityIcon(eid), `big-icon`),
      h('div', { class: 't' }, h('h2', {}, entName(eid)), h('div', { class: 'eid' }, eid)),
      h('button', { class: 'sb-close', title: 'Close (Esc)', onclick: closeSidebar }, ico('mdi:close'))),
    h('div', { class: 'sb-body' },
      stateBlock(eid),
      controls(eid),
      historyBlock(eid),
      servicesBlock(eid),
      attrsBlock(eid),
      !S.admin ? null : sec('Dashboard', row(
        act('Hide entity', 'mdi:eye-off', () => hideItem('entities', eid, entName(eid)), 'small'),
        node && !M().devices[node]?.virtual ? act('Hide device', 'mdi:eye-off-outline', () => hideItem('devices', devKey(node), devName(node)), 'small') : null,
      ))));
  const body = $('.sb-body', sb);
  body.scrollTop = scroll;
  for (const sum of body.querySelectorAll('details > summary')) {
    if (openDetails.includes(sum.textContent)) sum.parentElement.open = true;
  }
}

// ===================================================================
// Customize editor
// ===================================================================
let W = null; // working copy of the layout
const wget = (kind, key) => (W[kind] && W[kind][key]) || {};
function wset(kind, key, patch) {
  W[kind] ||= {};
  const next = { ...(W[kind][key] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null || next[k] === false) delete next[k];
  if (Object.keys(next).length) W[kind][key] = next;
  else delete W[kind][key];
}

let edSearch = null;
let edTree = null;
const edOpen = new Set(); // custom rooms that are unfolded in the editor
const stopKeys = (el) => { el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };

function openEditor() {
  if (!S.admin) return;
  W = JSON.parse(JSON.stringify(S.layout));
  W.settings ||= {};
  const ed = $('#editor');
  edSearch = stopKeys(h('input', { class: 'txt', type: 'search', placeholder: 'Filter rooms, devices, entities…' }));
  edTree = h('div', { class: 'tree' });
  edSearch.addEventListener('input', () => renderTree(edTree, edSearch.value.trim().toLowerCase()));
  ed.replaceChildren(h('div', { class: 'modal-card', role: 'dialog', 'aria-label': 'Customize dashboard' },
    h('div', { class: 'modal-head' }, h('h2', {}, 'Customize'), edSearch,
      h('button', { class: 'sb-close', onclick: closeEditor, title: 'Close' }, ico('mdi:close'))),
    h('div', { class: 'modal-body' }, settingsBlock(), h('div', { id: 'ed-mode' }), h('div', { id: 'ed-main' })),
    h('div', { class: 'modal-foot' },
      act('Reset everything', 'mdi:restore', () => {
        if (confirm('Remove all customizations, including your custom home?')) {
          W = { settings: {} };
          $('.settings', $('#editor')).replaceWith(settingsBlock());
          renderEditorMain();
        }
      }, 'small danger'),
      h('span', { class: 'spacer' }),
      act('Cancel', null, closeEditor, 'small'),
      act('Save', 'mdi:content-save', async () => {
        const wasCustom = !!S.layout.custom?.enabled, isCustom = !!W.custom?.enabled;
        S.layout = W;
        await saveLayout();
        closeEditor();
        if (wasCustom || isCustom) await guard(goHouse); // the whole structure may have changed
        rerenderAll();
        toast('Customization saved');
      }, 'small primary'))));
  ed.hidden = false;
  renderEditorMain();
}

/** Body of the editor: the automatic home's tree, or the custom home editor. */
function renderEditorMain() {
  const custom = !!W.custom?.enabled;
  $('#ed-mode').replaceChildren(modeSwitch(custom));
  edSearch.hidden = custom;
  if (custom) {
    $('#ed-main').replaceChildren(customEditor());
  } else {
    $('#ed-main').replaceChildren(
      h('p', { class: 'muted', style: 'margin:4px 0 8px;font-size:13px' },
        'Use the eye to show or hide items. Type a name to rename; leave it empty to use the Home Assistant name. Mark a level as Outdoor to show its rooms in a garden outside the house, or move single rooms to the Outdoor level. All of this only affects this dashboard.'),
      edTree);
    renderTree(edTree, edSearch.value.trim().toLowerCase());
  }
}

function modeSwitch(custom) {
  return h('div', { class: 'mode-row' },
    h('span', { class: 'mode-label' }, 'Home layout'),
    h('div', { class: 'seg' },
      h('button', { class: custom ? '' : 'active', onclick: () => { if (custom) { W.custom.enabled = false; renderEditorMain(); } } },
        ico('mdi:home-automation'), 'Automatic'),
      h('button', { class: custom ? 'active' : '', onclick: () => { if (!custom) chooseCustomStart(); } },
        ico('mdi:pencil-ruler'), 'Custom')),
    h('span', { class: 'muted' }, custom
      ? 'Your own levels, rooms and groups. Arrange the rooms with Floor plan on the house.'
      : 'Built from Home Assistant floors, areas, devices and integrations.'));
}

function chooseCustomStart() {
  const has = W.custom && ((W.custom.rooms || []).length || (W.custom.levels || []).length);
  const pick = (make) => { W.custom = { ...make(), enabled: true }; renderEditorMain(); };
  const card = (icon, title, text, fn) => h('button', { class: 'choice', onclick: fn }, ico(icon), h('b', {}, title), h('span', { class: 'muted' }, text));
  $('#ed-main').replaceChildren(h('div', { class: 'start-choice' },
    h('h3', {}, 'Start your custom home'),
    h('div', { class: 'choices' },
      has ? card('mdi:history', 'Continue my custom home', `${W.custom.levels.length} levels, ${W.custom.rooms.length} rooms`,
        () => pick(() => W.custom)) : null,
      card('mdi:content-copy', 'Copy the automatic home', 'Start from your current levels, rooms, devices and groups, then change what you like.',
        () => pick(copyAutoHome)),
      card('mdi:file-outline', 'Start empty', 'One empty level. Add every room and device yourself.',
        () => pick(() => ({ levels: [{ id: uid('lvl'), name: 'Ground floor', level: 0, outdoor: false }], rooms: [] })))),
    has ? h('p', { class: 'muted' }, 'Copying or starting empty replaces your current custom home when you save.') : null,
    act('Cancel', null, renderEditorMain, 'small')));
}

/** A custom home that looks exactly like the automatic one right now. */
function copyAutoHome() {
  return withReal(() => {
    const levels = [], rooms = [];
    for (const f of visibleFloors()) {
      const lid = uid('lvl');
      levels.push({ id: lid, name: floorName(f), level: f.level ?? 0, outdoor: !!f.outdoor, icon: f.icon || null });
      for (const aid of f.areas) {
        const { groups } = roomGroups(aid);
        const groupDefs = [], groupOf = {};
        for (const [key, ids] of Object.entries(groups)) {
          const id = uid('grp');
          groupDefs.push({ id, name: groupInfo(aid, key).name, icon: null });
          for (const nid of ids) groupOf[nid] = id;
        }
        const members = [];
        for (const nid of visibleNodes(aid)) {
          const d = M().devices[nid];
          const group = groupOf[nid] || null;
          // A whole device - unless only some of its entities are in this room.
          if (d.device_id && !nid.includes('@')) members.push({ kind: 'device', id: d.device_id, group });
          else for (const eid of visibleEntities(nid)) members.push({ kind: 'entity', id: eid, group });
        }
        const id = uid('room');
        rooms.push({ id, name: areaName(aid), icon: roomIcon(aid), level: lid, plan: null, members, groups: groupDefs });
        if (Array.isArray(L('areas', aid).status)) wset('areas', id, { status: L('areas', aid).status });
      }
    }
    return { levels, rooms };
  });
}

/**
 * "Room card shows" editor. `roomEntities` are the entity ids in the room (listed first);
 * the choice is stored as an ordered list in W.areas[aid].status.
 */
function statusEditor(aid, roomEntities, onChange = null) {
  const box = h('div', { class: 'status-ed' });
  const current = () => (Array.isArray(wget('areas', aid).status) ? wget('areas', aid).status : DEFAULT_STATUS);
  const save = (list) => { wset('areas', aid, { status: list }); draw(); onChange?.(); };
  const label = (item) => (item.kind === 'entity'
    ? (S.model.entities[item.id]?.full_name || item.id) : STATUS_SUMMARIES[item.kind]?.label || item.kind);
  const icon = (item) => (item.kind === 'entity' ? withReal(() => entityIcon(item.id)) : STATUS_SUMMARIES[item.kind]?.icon);
  const draw = () => {
    const list = current();
    const has = (it) => list.some((x) => x.kind === it.kind && x.id === it.id);
    const inRoom = new Set(roomEntities);
    const others = Object.values(S.model.entities)
      .filter((e) => !inRoom.has(e.entity_id) && ['sensor', 'binary_sensor', 'climate', 'weather'].includes(e.domain) && !e.entity_category)
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    const opt = (value, text, disabled) => { const o = h('option', { value }, text); o.disabled = !!disabled; return o; };
    const add = h('select', { title: 'Add to the room card' },
      opt('', '+ Add…'),
      h('optgroup', { label: 'Summaries' }, Object.entries(STATUS_SUMMARIES).map(([k, v]) => opt(`s:${k}`, v.label, has({ kind: k })))),
      roomEntities.length ? h('optgroup', { label: 'Entities in this room' },
        roomEntities.map((eid) => opt(`e:${eid}`, S.model.entities[eid]?.full_name || eid, has({ kind: 'entity', id: eid })))) : null,
      others.length ? h('optgroup', { label: 'Other sensors' },
        others.map((e) => opt(`e:${e.entity_id}`, e.full_name || e.entity_id, has({ kind: 'entity', id: e.entity_id })))) : null);
    add.addEventListener('change', () => {
      const v = add.value;
      if (!v) return;
      save([...current(), v.startsWith('s:') ? { kind: v.slice(2) } : { kind: 'entity', id: v.slice(2) }]);
    });
    box.replaceChildren(...[
      h('span', { class: 'status-title' }, ico('mdi:card-text-outline'), 'Room card shows'),
      list.length ? null : h('span', { class: 'muted' }, 'nothing'),
      ...list.map((item, i) => h('span', { class: 'status-chip' }, ico(icon(item)), label(item),
        i ? h('button', { title: 'Move left', onclick: () => { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; save(l); } }, ico('mdi:chevron-left')) : null,
        h('button', { title: 'Remove', onclick: () => save(list.filter((_, k) => k !== i)) }, ico('mdi:close')))),
      add,
      Array.isArray(wget('areas', aid).status)
        ? h('button', { class: 'link-btn', title: 'Back to temperature, lights on and motion', onclick: () => { wset('areas', aid, { status: null }); draw(); onChange?.(); } }, 'Default')
        : null,
    ].filter(Boolean));
  };
  draw();
  return box;
}

function textIn(value, onChange, placeholder, cls = '') {
  const el = stopKeys(h('input', { class: `txt ${cls}`, type: 'text', placeholder }));
  el.value = value || '';
  el.addEventListener('input', () => onChange(el.value.trim()));
  return el;
}
function selectIn(options, value, onChange, title = '') {
  const el = h('select', { title }, options.map(([v, label]) => {
    const o = h('option', { value: v }, label);
    o.selected = v === value;
    return o;
  }));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function customEditor() {
  const C = W.custom;
  C.levels ||= []; C.rooms ||= [];
  const levels = [...C.levels].sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0));
  return h('div', { class: 'custom-ed' },
    h('p', { class: 'muted', style: 'margin:4px 0 10px;font-size:13px' },
      'Levels are stacked by their number: higher is upstairs, below 0 is underground. Tick Outdoor to draw a level as a garden next to the house. Rooms are placed automatically; to arrange them like your real home, save and use Floor plan on the house.'),
    levels.map(levelCard),
    act('Add level', 'mdi:plus', () => {
      const top = Math.max(-1, ...C.levels.map((l) => Number(l.level) || 0));
      C.levels.push({ id: uid('lvl'), name: 'New level', level: top + 1, outdoor: false });
      renderEditorMain();
    }, 'small'));
}

function levelCard(lv) {
  const C = W.custom;
  const rooms = C.rooms.filter((r) => r.level === lv.id);
  const num = stopKeys(h('input', { class: 'txt num', type: 'number', step: 1, title: 'Level number' }));
  num.value = lv.level;
  num.addEventListener('change', () => { lv.level = Number(num.value) || 0; renderEditorMain(); });
  const out = h('input', { type: 'checkbox' });
  out.checked = !!lv.outdoor;
  out.addEventListener('change', () => { lv.outdoor = out.checked; renderEditorMain(); });
  return h('div', { class: `c-level ${lv.outdoor ? 'outdoor' : ''}` },
    h('div', { class: 'c-head' },
      ico(lv.outdoor ? 'mdi:tree' : 'mdi:layers-outline', 'ico'),
      textIn(lv.name, (v) => { lv.name = v || 'Level'; }, 'Level name'),
      h('label', { class: 'lvl-num' }, 'Level', num),
      h('label', { class: 'outdoor-switch' }, out, ico('mdi:tree'), 'Outdoor'),
      h('button', {
        class: 'eye', title: 'Delete level',
        onclick: () => {
          if (rooms.length && !confirm(`Delete “${lv.name}” and its ${rooms.length} room(s)?`)) return;
          C.levels = C.levels.filter((x) => x !== lv);
          C.rooms = C.rooms.filter((r) => r.level !== lv.id);
          renderEditorMain();
        },
      }, ico('mdi:delete-outline'))),
    h('div', { class: 'c-rooms' },
      rooms.map(roomCard),
      act('Add room', 'mdi:plus', () => {
        const room = { id: uid('room'), name: 'New room', icon: '', level: lv.id, plan: null, members: [], groups: [] };
        C.rooms.push(room);
        edOpen.add(room.id);
        renderEditorMain();
      }, 'small')));
}

function roomCard(room) {
  const C = W.custom;
  const open = edOpen.has(room.id);
  const preview = ico(room.icon || 'mdi:floor-plan', 'ico');
  const iconIn = textIn((room.icon || '').replace(/^mdi:/, ''), (v) => {
    room.icon = v ? (v.includes(':') ? v : `mdi:${v}`) : '';
    preview.className = `mdi ${mdiClass(room.icon || 'mdi:floor-plan')} ico`;
  }, 'icon, e.g. sofa', 'icon-in');
  const toggle = () => { if (open) edOpen.delete(room.id); else edOpen.add(room.id); renderEditorMain(); };
  const groupsOpts = [['', 'No group'], ...room.groups.map((g) => [g.id, g.name])];
  return h('div', { class: 'c-room' },
    h('div', { class: 'c-head' },
      h('button', { class: 'ord', title: open ? 'Fold' : 'Unfold', onclick: toggle }, ico(open ? 'mdi:chevron-down' : 'mdi:chevron-right')),
      preview,
      textIn(room.name, (v) => { room.name = v || 'Room'; }, 'Room name'),
      iconIn,
      selectIn(C.levels.map((l) => [l.id, l.name]), room.level, (v) => { room.level = v; room.plan = null; renderEditorMain(); }, 'Level'),
      h('span', { class: 'orig' }, `${room.members.length} item${room.members.length === 1 ? '' : 's'}`),
      h('button', {
        class: 'eye', title: 'Delete room',
        onclick: () => {
          if (room.members.length && !confirm(`Delete “${room.name}”?`)) return;
          C.rooms = C.rooms.filter((r) => r !== room);
          renderEditorMain();
        },
      }, ico('mdi:delete-outline'))),
    open ? h('div', { class: 'c-room-body' },
      statusEditor(room.id, room.members.flatMap((m) => (m.kind === 'device' ? S.model.all_devices?.[m.id]?.entities || [] : [m.id]))),
      room.members.length
        ? h('div', { class: 'c-members' }, room.members.map((m) => memberRow(room, m, groupsOpts)))
        : h('p', { class: 'muted' }, 'Nothing in this room yet.'),
      room.groups.length ? h('div', { class: 'c-groups' }, h('span', { class: 'muted' }, 'Groups'), room.groups.map((g) => groupChip(room, g))) : null,
      row(
        act('Add devices or entities', 'mdi:plus', () => openPicker(room), 'small'),
        act('Add group', 'mdi:folder-plus-outline', () => {
          room.groups.push({ id: uid('grp'), name: `Group ${room.groups.length + 1}`, icon: null });
          renderEditorMain();
        }, 'small'))) : null);
}

/** Display info for a custom-home member, from the Home Assistant data. */
function memberInfo(m) {
  return withReal(() => {
    if (m.kind === 'device') {
      const d = S.model.all_devices?.[m.id];
      if (!d) return { name: 'Missing device', sub: m.id, icon: 'mdi:alert-circle-outline', missing: true };
      const node = Object.values(S.model.devices).find((n) => n.device_id === m.id);
      const icon = node ? deviceIcon(node.id) : `mdi:${DOMAIN_ICONS[domainOf(d.entities[0] || 'x.y')] || 'devices'}`;
      return { name: d.name, sub: [d.integration_name, d.manufacturer, d.model].filter(Boolean).join(' · '), icon };
    }
    const e = S.model.entities[m.id];
    if (!e) return { name: 'Missing entity', sub: m.id, icon: 'mdi:alert-circle-outline', missing: true };
    return { name: e.full_name || e.name, sub: m.id, icon: entityIcon(m.id) };
  });
}

/** Is a custom-home member hidden on the dashboard? A device also counts as hidden when all its entities are. */
function memberHidden(m) {
  if (m.kind === 'entity') return !!wget('entities', m.id).hidden;
  const ents = S.model.all_devices?.[m.id]?.entities || [];
  return !!wget('devices', m.id).hidden || (ents.length > 0 && ents.every((e) => wget('entities', e).hidden));
}
/** Show a member on the dashboard again (in the working copy W). */
function showMember(m) {
  if (m.kind === 'entity') { wset('entities', m.id, { hidden: null }); return; }
  wset('devices', m.id, { hidden: null });
  const ents = S.model.all_devices?.[m.id]?.entities || [];
  if (ents.length && ents.every((e) => wget('entities', e).hidden)) ents.forEach((e) => wset('entities', e, { hidden: null }));
}

function memberRow(room, m, groupsOpts) {
  const C = W.custom;
  const info = memberInfo(m);
  const hidden = memberHidden(m);
  return h('div', { class: `c-member ${info.missing ? 'missing' : ''} ${hidden ? 'off' : ''}` },
    ico(info.icon, 'ico'),
    h('div', { class: 'c-m-text' }, h('span', {}, info.name),
      h('span', { class: 'muted' }, `${m.kind === 'device' ? 'Device' : 'Entity'} · ${hidden ? 'hidden on the dashboard · ' : ''}${info.sub}`)),
    room.groups.length ? selectIn(groupsOpts, m.group || '', (v) => { m.group = v || null; }, 'Group') : null,
    selectIn(C.rooms.map((r) => [r.id, `in ${r.name}`]), room.id, (v) => {
      const to = C.rooms.find((r) => r.id === v);
      room.members = room.members.filter((x) => x !== m);
      if (!to.members.some((x) => x.kind === m.kind && x.id === m.id)) to.members.push({ ...m, group: null });
      renderEditorMain();
    }, 'Move to another room'),
    h('button', {
      class: 'eye', title: hidden ? 'Hidden on the dashboard - click to show' : 'Shown - click to hide',
      onclick: () => {
        if (hidden) showMember(m); else wset(m.kind === 'device' ? 'devices' : 'entities', m.id, { hidden: true });
        renderEditorMain();
      },
    }, ico(hidden ? 'mdi:eye-off' : 'mdi:eye')),
    h('button', { class: 'eye', title: 'Remove from room', onclick: () => { room.members = room.members.filter((x) => x !== m); renderEditorMain(); } }, ico('mdi:close')));
}

function groupChip(room, g) {
  const icon = textIn((g.icon || '').replace(/^mdi:/, ''), (v) => { g.icon = v ? (v.includes(':') ? v : `mdi:${v}`) : null; }, 'icon', 'icon-in');
  return h('div', { class: 'c-group' },
    ico('mdi:folder-outline', 'ico'),
    textIn(g.name, (v) => {
      g.name = v || 'Group';
      // Keep the devices' Group lists in step while typing (they're only rebuilt on the next redraw).
      for (const o of document.querySelectorAll('#editor select[title="Group"] option')) if (o.value === g.id) o.textContent = g.name;
    }, 'Group name'),
    icon,
    h('span', { class: 'orig' }, `${room.members.filter((m) => m.group === g.id).length} in group`),
    h('button', {
      class: 'eye', title: 'Delete group (its devices stay in the room)',
      onclick: () => {
        room.groups = room.groups.filter((x) => x !== g);
        for (const m of room.members) if (m.group === g.id) m.group = null;
        renderEditorMain();
      },
    }, ico('mdi:delete-outline')));
}

/** Pick devices and entities from Home Assistant to add to a custom room. */
function openPicker(room) {
  const card = $('#editor .modal-card');
  const chosen = new Set();
  const key = (m) => `${m.kind}|${m.id}`;
  const inRoom = new Set(room.members.map(key));
  const where = {};
  for (const r of W.custom.rooms) for (const m of r.members) (where[key(m)] ||= []).push(r.name);
  const realArea = (aid) => S.model.areas[aid]?.name || 'No area';
  const devices = Object.values(S.model.all_devices || {}).map((d) => ({
    key: `device|${d.id}`, name: d.name, sub: [realArea(d.area_id), d.integration_name].filter(Boolean).join(' · '),
    icon: memberInfo({ kind: 'device', id: d.id }).icon,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const entities = Object.values(S.model.entities).map((e) => ({
    key: `entity|${e.entity_id}`, name: e.full_name || e.name, sub: e.entity_id, icon: withReal(() => entityIcon(e.entity_id)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  let tab = 'device';
  const search = stopKeys(h('input', { class: 'txt', type: 'search', placeholder: 'Search…' }));
  const list = h('div', { class: 'pick-list' });
  const count = h('span', { class: 'muted' });
  const tabs = h('div', { class: 'seg' });
  const render = () => {
    tabs.replaceChildren(
      h('button', { class: tab === 'device' ? 'active' : '', onclick: () => { tab = 'device'; render(); } }, ico('mdi:devices'), `Devices (${devices.length})`),
      h('button', { class: tab === 'entity' ? 'active' : '', onclick: () => { tab = 'entity'; render(); } }, ico('mdi:shape-outline'), `Entities (${entities.length})`));
    const q = search.value.trim().toLowerCase();
    const rows = (tab === 'device' ? devices : entities).filter((x) => !q || x.name.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q));
    list.replaceChildren(...rows.slice(0, 300).map((x) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = inRoom.has(x.key) || chosen.has(x.key);
      cb.disabled = inRoom.has(x.key);
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(x.key); else chosen.delete(x.key); count.textContent = `${chosen.size} selected`; });
      const elsewhere = (where[x.key] || []).filter((n) => n !== room.name);
      return h('label', { class: `pick-row ${cb.disabled ? 'done' : ''}` }, cb, ico(x.icon, 'ico'),
        h('span', { class: 'c-m-text' }, h('span', {}, x.name), h('span', { class: 'muted' }, x.sub)),
        inRoom.has(x.key) ? h('span', { class: 'badge-in' }, 'in this room') : elsewhere.length ? h('span', { class: 'badge-in' }, `in ${elsewhere.join(', ')}`) : null);
    }), rows.length > 300 ? h('p', { class: 'muted' }, `${rows.length - 300} more - type to narrow the list.`) : null);
    if (!rows.length) list.replaceChildren(h('p', { class: 'muted' }, 'Nothing matches.'));
  };
  search.addEventListener('input', render);
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'picker' },
    h('div', { class: 'modal-head' }, h('h2', {}, `Add to ${room.name}`), h('button', { class: 'sb-close', onclick: close, title: 'Close' }, ico('mdi:close'))),
    h('div', { class: 'pick-tools' }, tabs, search),
    list,
    h('div', { class: 'modal-foot' }, count, h('span', { class: 'spacer' }), act('Cancel', null, close, 'small'),
      act('Add', 'mdi:plus', () => {
        for (const k of chosen) {
          const [kind, id] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
          room.members.push({ kind, id, group: null });
          showMember({ kind, id }); // adding something to a room means you want to see it
        }
        edOpen.add(room.id);
        close();
        renderEditorMain();
      }, 'small primary')));
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  card.append(overlay);
  render();
  search.focus();
}

function settingsBlock() {
  const name = h('input', { class: 'txt', type: 'text', maxlength: 60, placeholder: S.model?.home_name || 'Home' });
  name.value = W.settings.houseName || '';
  name.addEventListener('input', () => {
    const v = name.value.trim();
    if (v) W.settings.houseName = v; else delete W.settings.houseName;
  });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div', { class: 'settings' },
    h('label', { class: 'house-name' }, h('span', {}, 'House name'), name),
    settingBox('hideEmptyRooms', 'Hide rooms without devices'),
    settingBox('skipSingleEntity', 'Skip entity wheel for single-entity devices'),
    settingBox('noGrouping', 'Group devices of the same integration', true),
    h('label', { class: 'house-name' }, h('span', {}, 'Weather'), weatherSelect()));
}
/** Checkbox bound to a layout setting; `invert` shows a setting stored as "off" (e.g. noGrouping) as a positive option. */
function settingBox(key, label, invert = false) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = invert ? !W.settings[key] : !!W.settings[key];
  cb.addEventListener('change', () => {
    const value = invert ? !cb.checked : cb.checked;
    if (value) W.settings[key] = true; else delete W.settings[key];
  });
  return h('label', {}, cb, label);
}
function closeEditor() { $('#editor').hidden = true; W = null; }

/** "Outdoor" switch on a level row: its rooms are drawn in a garden outside the house. */
function outdoorSwitch(f, tree, q) {
  const builtIn = f.id === OUTDOOR;
  const cb = h('input', { type: 'checkbox' });
  cb.checked = builtIn || !!wget('floors', f.id).outdoor;
  cb.disabled = builtIn;
  cb.addEventListener('click', (e) => e.stopPropagation()); // don't fold the <details>
  cb.addEventListener('change', () => { wset('floors', f.id, { outdoor: cb.checked }); renderTree(tree, q); });
  return h('label', {
    class: 'outdoor-switch',
    title: builtIn ? 'Rooms on this level are always shown outside the house' : 'Show the rooms of this level outside the house',
    onclick: (e) => e.stopPropagation(),
  }, cb, ico('mdi:tree'), 'Outdoor');
}

function editRow({ kind, key, label, fallback, icon, orig, extra = [], summary = true }) {
  const hidden = !!wget(kind, key).hidden;
  const name = h('input', { class: 'txt', placeholder: fallback });
  name.value = wget(kind, key).name || '';
  name.addEventListener('input', () => wset(kind, key, { name: name.value.trim() }));
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === ' ') e.stopPropagation(); });
  name.addEventListener('click', (e) => e.preventDefault()); // don't toggle <details>
  const rowEl = h('div', { class: `trow ${hidden ? 'off' : ''}` },
    summary ? ico('mdi:chevron-right', 'caret') : null,
    h('span', { class: 'kind' }, label),
    ico(icon, 'ico'),
    name,
    orig ? h('span', { class: 'orig', title: orig }, orig) : null,
    ...extra);
  const eye = h('button', { class: 'eye', title: hidden ? 'Hidden — click to show' : 'Shown — click to hide' }, ico(hidden ? 'mdi:eye-off' : 'mdi:eye'));
  eye.addEventListener('click', (e) => {
    e.preventDefault();
    const now = !wget(kind, key).hidden;
    wset(kind, key, { hidden: now });
    rowEl.classList.toggle('off', now);
    eye.replaceChildren(ico(now ? 'mdi:eye-off' : 'mdi:eye'));
  });
  rowEl.append(eye);
  return rowEl;
}

function renderTree(tree, q) {
  withReal(() => renderAutoTree(tree, q));
}
/** Rename a room's integration group (stored per room; empty = the integration's name). */
function setGroupName(aid, key, name) {
  const groups = { ...(wget('areas', aid).groups || {}) };
  if (name) groups[key] = { name }; else delete groups[key];
  wset('areas', aid, { groups: Object.keys(groups).length ? groups : null });
}

function renderAutoTree(tree, q) {
  const m = M();
  // Group the tree exactly like the wheels, using the unsaved settings.
  const draftGroups = (aid) => { const saved = S.layout; S.layout = W; try { return roomGroups(aid); } finally { S.layout = saved; } };
  const match = (...strs) => !q || strs.some((x) => x && x.toLowerCase().includes(q));
  const wAreaFloor = (aid) => wget('areas', aid).floor || m.areas[aid].floor_id;
  const sortW = (ids) => [...ids].sort((a, b) => ((wget('areas', a).order ?? 1e6) - (wget('areas', b).order ?? 1e6)) || m.areas[a].name.localeCompare(m.areas[b].name));
  const floors = [...m.floors].sort((a, b) => (b.level ?? -0.5) - (a.level ?? -0.5)).concat(OUTDOOR_FLOOR);
  const out = [];
  for (const f of floors) {
    const areaIds = sortW(Object.keys(m.areas).filter((aid) => wAreaFloor(aid) === f.id));
    const areaEls = [];
    areaIds.forEach((aid, idx) => {
      const a = m.areas[aid];
      const deviceEl = (nid, extraMatch = '') => {
        const d = m.devices[nid];
        const dkey = d.device_id || nid;
        const devText = [d.name, wget('devices', dkey).name, d.manufacturer, d.model, a.name, extraMatch];
        const entEls = d.entities.filter((eid) => match(m.entities[eid].full_name, eid, wget('entities', eid).name) || match(...devText))
          .map((eid) => h('div', { class: 'leaf' }, editRow({
            kind: 'entities', key: eid, label: domainOf(eid), fallback: m.entities[eid].name, icon: entityIcon(eid), orig: eid, summary: false,
          })));
        if (!entEls.length && !match(...devText)) return null;
        return h('details', { open: !!q },
          h('summary', {}, editRow({
            kind: 'devices', key: dkey, label: 'Device', fallback: d.virtual ? `${a.name} extras` : d.name,
            icon: deviceIcon(nid), orig: [d.manufacturer, d.model].filter(Boolean).join(' ') || `${d.entities.length} entities`,
          })),
          entEls);
      };
      const devEls = [];
      const { groups, loose } = draftGroups(aid);
      const grouped = new Set(Object.values(groups).flat());
      // Integration groups first (as on the wheel), each with its devices inside.
      for (const [key, ids] of Object.entries(groups).sort((x, y) => integrationName(x[0]).localeCompare(integrationName(y[0])))) {
        const custom = wget('areas', aid).groups?.[key]?.name || '';
        const inner = ids.map((nid) => deviceEl(nid, `${custom} ${integrationName(key)}`)).filter(Boolean);
        if (!inner.length && !match(custom, integrationName(key))) continue;
        const name = textIn(custom, (v) => setGroupName(aid, key, v), integrationName(key));
        name.addEventListener('click', (e) => e.preventDefault()); // don't fold the <details>
        devEls.push(h('details', { open: !!q, class: 'tree-group' },
          h('summary', {}, h('div', { class: 'trow' },
            ico('mdi:chevron-right', 'caret'),
            h('span', { class: 'kind' }, 'Group'),
            ico('mdi:puzzle-outline', 'ico'),
            name,
            h('span', { class: 'orig', title: integrationName(key) }, `${ids.length} devices · ${integrationName(key)}`))),
          inner));
      }
      // Then the devices outside a group - and hidden ones, so they can be shown again.
      for (const nid of [...loose, ...a.devices.filter((n) => !grouped.has(n) && !loose.includes(n))]) {
        const el = deviceEl(nid);
        if (el) devEls.push(el);
      }
      if (!devEls.length && !match(a.name)) return;
      const floorSel = h('select', { title: 'Floor, or outside the house' }, allFloors().map((ff) => {
        const label = ff.id === OUTDOOR ? 'Outdoor (outside the house)'
          : (wget('floors', ff.id).name || ff.name) + (wget('floors', ff.id).outdoor ? ' (outdoor)' : '');
        const o = h('option', { value: ff.id }, label);
        o.selected = ff.id === f.id;
        return o;
      }));
      floorSel.addEventListener('click', (e) => e.preventDefault());
      floorSel.addEventListener('change', () => {
        wset('areas', aid, { floor: floorSel.value === a.floor_id ? null : floorSel.value });
        renderTree(tree, q);
      });
      const move = (dir) => (e) => {
        e.preventDefault();
        const ids = sortW(Object.keys(m.areas).filter((x) => wAreaFloor(x) === f.id));
        const i = ids.indexOf(aid), j = i + dir;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        ids.forEach((x, k) => wset('areas', x, { order: k + 1 }));
        renderTree(tree, q);
      };
      areaEls.push(h('details', { open: !!q },
        h('summary', {}, editRow({
          kind: 'areas', key: aid, label: 'Room', fallback: a.name, icon: roomIcon(aid), orig: `${a.devices.length} devices`,
          extra: [floorSel, h('button', { class: 'ord', title: 'Move up', onclick: move(-1) }, ico('mdi:chevron-up')),
            h('button', { class: 'ord', title: 'Move down', onclick: move(1) }, ico('mdi:chevron-down'))],
        })),
        h('div', { class: 'leaf' }, statusEditor(aid, a.devices.flatMap((nid) => m.devices[nid].entities))),
        devEls.length ? devEls : h('div', { class: 'leaf muted' }, 'No devices')));
      void idx;
    });
    if (!areaEls.length && q) continue;
    out.push(h('details', { open: true },
      h('summary', {}, editRow({
        kind: 'floors', key: f.id, label: 'Floor', fallback: f.name, icon: f.icon || 'mdi:layers-outline',
        orig: f.level != null ? `level ${f.level}` : '',
        extra: [outdoorSwitch(f, tree, q)],
      })),
      areaEls.length ? areaEls : h('div', { class: 'leaf muted' }, 'No rooms')));
  }
  tree.replaceChildren(...(out.length ? out : [h('p', { class: 'muted' }, 'Nothing matches.')]));
}

$('#btn-edit').addEventListener('click', () => { if (!M()) return; if (S.plan) endPlanEdit(false); openEditor(); });
$('#btn-plan').addEventListener('click', startPlanEdit);
$('#btn-home').addEventListener('click', () => guard(goHouse));

// ===================================================================
// Full screen
// Inside Home Assistant the dashboard runs in an Ingress iframe under HA's
// title bar and sidebar. Ingress is served from HA's own origin, so the
// dashboard can reach its own iframe element in HA's page and stretch it over
// the whole window ("cover"): HA's bars are hidden without the browser's
// Fullscreen API, which kiosk browsers such as Fully often don't offer, and
// without needing a tap. Where the browser does offer full screen, the frame
// also goes properly full screen (hiding the browser's bars too).
// The choice is remembered on the device: a wall panel covers HA's bars again
// as soon as it loads, and re-enters browser full screen on the first tap
// (browsers only allow that after a tap).
// Opened directly (not in HA), only browser full screen is possible.
// ===================================================================
const fullscreen = (() => {
  const KEY = 'ww-fullscreen';
  const btn = $('#btn-full');
  const logo = $('#topbar .logo');
  let frame = null;
  try { if (window.frameElement?.ownerDocument) frame = window.frameElement; } catch { /* other origin */ }
  const target = frame || document.documentElement;
  const doc = target.ownerDocument;
  const fsOk = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)
    && !!(target.requestFullscreen || target.webkitRequestFullscreen);
  const fsActive = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  const store = (on) => { try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch { /* private mode */ } };
  const wanted = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  let covered = false;
  let savedStyle = '';

  function cover() {
    if (!frame || covered) return;
    savedStyle = frame.getAttribute('style') || '';
    frame.style.cssText += ';position:fixed!important;inset:0!important;left:0!important;top:0!important;'
      + 'width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;'
      + 'max-height:none!important;margin:0!important;border:0!important;z-index:2147483647!important;';
    covered = true;
    // Check HA's bars are really under the frame (an HA layout change could trap it in its box).
    requestAnimationFrame(() => {
      const r = frame.getBoundingClientRect();
      const win = doc.defaultView;
      const root = frame.getRootNode();
      const top = root.elementFromPoint ? root.elementFromPoint(4, 4) : frame;
      if (r.left > 1 || r.top > 1 || r.width < win.innerWidth - 2 || (top && top !== frame)) {
        toast("Couldn't hide Home Assistant's bars in this browser.", 'err');
      }
    });
  }
  function uncover() {
    if (!frame || !covered) return;
    if (savedStyle) frame.setAttribute('style', savedStyle); else frame.removeAttribute('style');
    covered = false;
  }
  function enterFs(quiet = false) {
    if (!fsOk || fsActive()) return;
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    const fail = (err) => { if (!quiet && !frame) toast(`Full screen is not allowed here: ${err.message || err}`, 'err'); };
    try { req.call(target, { navigationUI: 'hide' })?.catch?.(fail); } catch (err) { fail(err); }
  }
  function exitFs() { if (fsActive()) (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc); }
  const isOn = () => (frame ? covered : fsActive());
  function sync() {
    const on = isOn();
    btn.firstElementChild.className = `mdi ${on ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'}`;
    btn.title = on ? "Leave full screen: show Home Assistant's title bar and sidebar"
      : "Full screen: hide Home Assistant's title bar and sidebar";
    btn.hidden = on; // in full screen the button goes away; hold the logo to leave
    logo.title = on ? 'Hold to leave full screen' : '';
  }
  function turnOn() {
    cover(); enterFs(); store(true); sync();
    toast('Full screen. Hold the logo in the top-left corner for 2 seconds to leave.');
  }
  function turnOff() { exitFs(); uncover(); store(false); sync(); }

  if (!frame && !fsOk) return { isOn };
  btn.hidden = false;
  btn.addEventListener('click', () => (isOn() ? turnOff() : turnOn()));
  // Leaving full screen: hold the logo for 2 s (a plain tap does nothing, so a
  // wall panel isn't knocked out of full screen by accident).
  let holdTimer = null;
  const release = () => { clearTimeout(holdTimer); holdTimer = null; logo.classList.remove('holding'); };
  logo.addEventListener('pointerdown', (e) => {
    if (!isOn()) return;
    e.preventDefault();
    logo.classList.add('holding');
    holdTimer = setTimeout(() => { release(); turnOff(); }, 2000);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) logo.addEventListener(ev, release);
  logo.addEventListener('contextmenu', (e) => { if (isOn()) e.preventDefault(); });
  const onChange = () => {
    // Directly opened: leaving browser full screen (Esc) means off. In HA the cover stays.
    if (!frame && !fsActive() && !document.hidden) store(false);
    sync();
  };
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  window.addEventListener('pagehide', () => {
    doc.removeEventListener('fullscreenchange', onChange);
    doc.removeEventListener('webkitfullscreenchange', onChange);
  });
  if (wanted()) {
    cover();
    if (fsOk && !fsActive()) {
      const again = (e) => {
        document.removeEventListener('pointerup', again, true);
        if (wanted() && !e.target.closest?.('#btn-full')) enterFs(true);
      };
      document.addEventListener('pointerup', again, true);
    }
  }
  sync();
  return { isOn };
})();

// ===================================================================
// Idle timeout: after 30 s without a touch, click, mouse move or key press
// in the wheel menus, fold the wheel and the sidebar and return to the house.
// Not while Customize, a card editor or the dashboard edit mode is open.
// ===================================================================
const IDLE_MS = (() => { try { return Number(localStorage.getItem('ww-idle-ms')) || 30000; } catch { return 30000; } })();
// Every kind of input counts. Some web views (e.g. the Companion app) don't deliver pointer events to the
// dashboard's frame but still deliver touches and clicks, so listen for all of them.
for (const ev of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'mousedown', 'mousemove', 'click',
  'keydown', 'wheel', 'scroll', 'input', 'change', 'focusin']) {
  document.addEventListener(ev, markActive, { capture: true, passive: true });
}
setInterval(() => {
  if (S.nav.level === 'house' || busy.v || S.plan) { if (S.nav.level === 'house') lastActivity = Date.now(); return; }
  if (!$('#editor').hidden || !$('#card-editor').hidden) { lastActivity = Date.now(); return; }
  if (Date.now() - lastActivity < IDLE_MS) return;
  lastActivity = Date.now();
  guard(goHouse);
}, 1000);

// ===================================================================
// Keyboard
// ===================================================================
document.addEventListener('keydown', (e) => {
  if (!$('#editor').hidden) { if (e.key === 'Escape' && !$('#editor .picker')) closeEditor(); return; }
  if (!$('#card-editor').hidden) { if (e.key === 'Escape') { $('#card-editor').hidden = true; W = null; } return; }
  if (S.plan) { if (e.key === 'Escape') endPlanEdit(false); return; }
  if (e.target.matches('input, select, textarea')) return;
  const lvl = S.nav.level;
  if (lvl === 'house') {
    if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) { closeSidebar(); return; }
    const n = S.rooms.length;
    if (!n) return;
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { setHouseFocus((S.houseFocus + 1) % n); e.preventDefault(); }
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { setHouseFocus((S.houseFocus - 1 + n) % n); e.preventDefault(); }
    else if (e.key === 'Enter' && S.houseFocus >= 0) {
      const r = S.rooms[S.houseFocus];
      if (r.stats?.devices) enterArea(r.aid, r);
    }
    return;
  }
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': wheel.moveHover(1); e.preventDefault(); break;
    case 'ArrowLeft': case 'ArrowUp': wheel.moveHover(-1); e.preventDefault(); break;
    case 'PageDown': wheel.turnPage(1); break;
    case 'PageUp': wheel.turnPage(-1); break;
    case 'Enter': case ' ': {
      const it = wheel.current();
      if (it) wheel.opts.onSelect?.(it);
      else if (wheel.hover === -2) back();
      e.preventDefault();
      break;
    }
    case 'Escape': case 'Backspace':
      if (S.nav.entityId && S.nav.panel) backToPanel();
      else if (document.body.classList.contains('sidebar-open')) closeSidebar();
      else back();
      e.preventDefault();
      break;
    default: break;
  }
});
$('#wheel-center').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); back(); } });

// ===================================================================
// Live updates + boot
// ===================================================================
let paintQueued = false;
function onStates(batch) {
  let touchesSidebar = false;
  for (const [eid, st] of Object.entries(batch)) {
    if (st) S.states[eid] = st; else delete S.states[eid];
    if (eid === S.nav.entityId) touchesSidebar = true;
    else if (!S.nav.entityId && S.nav.panel && M().entities[eid]?.node === S.nav.panel) touchesSidebar = true;
  }
  if (touchesSidebar && (!S.nav.entityId || domainOf(S.nav.entityId) !== 'camera')
      && !S.interacting && !document.activeElement?.closest?.('#sidebar input')) renderSidebar();
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    const n = S.nav;
    if (n.level === 'house') paintHouse();
    else if (wheel.t === 1 && !busy.v) {
      if (n.level === 'devices') wheel.update(currentDeviceItems());
      else if (n.level === 'entities') wheel.update(entityItems(n.nodeId));
    }
  });
}

function setConn(ok) {
  S.connected = ok;
  const c = $('#conn');
  c.classList.toggle('ok', ok && !S.demo);
  c.classList.toggle('demo', ok && S.demo);
  c.textContent = !ok ? 'Offline' : S.demo ? 'Demo house' : 'Connected';
  c.title = ok ? (S.demo ? 'Demo mode (no Home Assistant)' : 'Connected to Home Assistant') : 'Disconnected';
}

/** Optional colour override from the app's options; the theme's blue is used otherwise. */
function applyAccent(hex) {
  const root = document.documentElement.style;
  // #ff7a1a was the default of version 0.1.0 - treat it as "not set".
  if (!/^#[0-9a-f]{6}$/i.test(hex || '') || hex.toLowerCase() === '#ff7a1a') {
    root.removeProperty('--primary');
    root.removeProperty('--primary-soft');
    return;
  }
  root.setProperty('--primary', hex);
  root.setProperty('--primary-soft', `color-mix(in srgb, ${hex} 16%, var(--card))`);
}

async function loadModel() {
  const data = await api('api/model');
  S.demo = data.demo;
  // Non-admin users (e.g. a wall panel) can use the dashboard but not edit it; the server enforces this too.
  S.admin = data.viewer?.admin !== false;
  document.body.classList.toggle('viewer-locked', !S.admin);
  $('#wheel-hint').textContent = S.admin
    ? 'Point to aim · click to select · center or Esc to go back · right-click to hide'
    : 'Point to aim · click to select · center or Esc to go back';
  applyAccent(data.options?.accent_color);
  S.layout = { floors: {}, areas: {}, devices: {}, entities: {}, settings: {}, ...data.layout };
  setConn(data.connected);
  if (!data.model) return false;
  S.model = data.model;
  S.states = data.states;
  refreshView();
  return true;
}

let ws = null;
let wsRetry = 1000;
function connectWS() {
  const url = new URL('api/ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(url);
  ws.onopen = () => { wsRetry = 1000; };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'states') { if (S.model) onStates(msg.states); }
    else if (msg.type === 'status') {
      setConn(msg.connected);
      if (msg.connected && !S.model) boot();
    } else if (msg.type === 'model') {
      if (await loadModel()) { if (!booted) boot(); else rerenderAll(); }
    } else if (msg.type === 'layout') {
      S.layout = { floors: {}, areas: {}, devices: {}, entities: {}, settings: {}, ...msg.layout };
      if (S.plan) return; // don't yank the plan out from under the editor
      refreshView();
      if (S.model && $('#editor').hidden) rerenderAll();
    }
  };
  ws.onclose = () => {
    setConn(false);
    setTimeout(async () => {
      connectWS();
      try { if (await loadModel() && booted) rerenderAll(); } catch { /* retry later */ }
    }, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 15000);
  };
}

let booted = false;
async function boot() {
  try {
    if (!S.model && !(await loadModel())) {
      $('#empty-house').hidden = false;
      $('#empty-house p').textContent = 'Connecting to Home Assistant…';
      $('#house-frame').hidden = true;
      return;
    }
  } catch (err) {
    toast(`Could not load: ${err.message}`, 'err');
    return;
  }
  booted = true;
  buildHouse();
  renderCrumbs();
}

let lastShape = '';
new ResizeObserver(() => {
  if (S.nav.level !== 'house' || !S.model) return;
  const st = $('#stage');
  const w = st.clientWidth;
  // Rebuild when the column count or portrait/landscape changes (gardens move), otherwise just rescale.
  const shape = `${w < 560 ? 2 : w < 900 ? 3 : 5}/${w < st.clientHeight * 0.9 ? 'p' : 'l'}`;
  if (shape !== lastShape) { lastShape = shape; buildHouse(); } else sizeHouse();
}).observe($('#stage'));
connectWS();
boot();
})();
