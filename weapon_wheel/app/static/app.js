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
const M = () => S.model;

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
const allFloors = () => [...M().floors, OUTDOOR_FLOOR];
/** A level is outdoor if it is the built-in Outdoor level or was marked outdoor in Customize. */
const isOutdoorFloor = (f) => !!(f.id === OUTDOOR || L('floors', f.id).outdoor);

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
  const p = primaryEntity(visibleEntities(nid));
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
  const ents = visibleEntities(nid);
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
  const layoutFloor = (f, x0, x1, under) => {
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
  const H = y + 36;
  // Outdoor levels: each one is a fenced garden standing on the ground to the right of the house.
  let W = HW;
  const gardens = [];
  let gx0 = X1 + 80;
  let gBottom = groundY; // on narrow screens gardens stack upwards instead of side by side
  let colRight = gx0;
  for (const yard of yards) {
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
  return { bands, gardens, X0, X1, TOP, ROOF, groundY, H, W, hasAbove: above.length > 0 };
}

function buildHouse() {
  const svg = $('#house');
  const labels = $('#house-labels');
  const floors = visibleFloors();
  const empty = floors.length === 0;
  $('#empty-house').hidden = !empty;
  $('#house-frame').hidden = empty;
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
  if (g.gardens.length) { // a tree between the house and the garden
    const tx = g.X1 + 40, ty = g.groundY;
    parts.push(s('rect', { class: 'h-trunk', x: tx - 4, y: ty - 34, width: 8, height: 34 }));
    parts.push(s('circle', { class: 'h-tree', cx: tx, cy: ty - 52, r: 24 }));
  }

  const roomEls = [];
  const pinEls = [];
  for (const b of g.bands) {
    const wallCls = b.outdoor ? 'h-garden' : `h-wall ${b.under ? 'under' : ''} ${b.floor.id === '__unassigned__' ? 'annex' : ''}`;
    parts.push(s('rect', { class: wallCls, x: b.x0, y: b.y, width: b.x1 - b.x0, height: b.h, rx: b.outdoor ? 16 : 0 }));
    parts.push(s('text', { class: 'h-floor-label', x: b.x0 + 16, y: b.y + 23 }, floorName(b.floor)));
    for (const r of b.rooms) {
      const idx = S.rooms.length;
      const room = s('g', { class: 'room', 'data-area': r.aid, 'data-idx': idx },
        s('rect', { class: 'r-body', x: r.x, y: r.y, width: r.w, height: r.h, rx: 10 }));
      const px = r.x + r.w - 24, py = r.y + 34;
      const pin = s('g', { class: 'pin', transform: `translate(${px},${py})`, 'data-area': r.aid, 'data-idx': idx },
        s('ellipse', { class: 'p-shadow', cx: 0, cy: 2, rx: 9, ry: 3 }),
        s('g', { class: 'bob' },
          s('path', { class: 'p-body', d: 'M0,0 C-4,-10 -16,-18 -16,-32 A16,16 0 1 1 16,-32 C16,-18 4,-10 0,0 Z' }),
          s('circle', { class: 'p-dot', cx: 0, cy: -32, r: 10 }),
          s('text', { class: 'p-count', x: 0, y: -32 }, '')));
      roomEls.push(room);
      pinEls.push(pin);
      S.rooms.push({ ...r, el: room, pin });
    }
  }
  parts.push(roofName);
  parts.push(s('line', { class: 'h-ground', x1: 10, x2: g.W - 10, y1: g.groundY, y2: g.groundY }));
  svg.replaceChildren(...parts, ...roomEls, ...pinEls);

  labels.replaceChildren(...S.rooms.map((r) => {
    const el = h('div', {
      class: 'room-label',
      style: `left:${((r.x + r.w / 2) / g.W) * 100}%;top:${((r.y + r.h / 2 + 18) / g.H) * 100}%;max-width:${(r.w / g.W) * 100 - 1}%`,
    }, ico(roomIcon(r.aid)), h('div', { class: 'name' }, areaName(r.aid)), h('div', { class: 'chips' }));
    r.label = el;
    return el;
  }));
  sizeHouse();
  paintHouse();
}

function roomStats(aid) {
  const nodes = visibleNodes(aid);
  let lights = 0, active = 0, temp = null, motion = false;
  for (const nid of nodes) {
    for (const eid of visibleEntities(nid)) {
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
    }
  }
  return { devices: nodes.length, lights, active, temp, motion };
}

function paintHouse() {
  for (const r of S.rooms) {
    const st = roomStats(r.aid);
    r.stats = st;
    const empty = st.devices === 0;
    r.el.classList.toggle('lit', st.lights > 0);
    r.el.classList.toggle('empty', empty);
    r.pin.classList.toggle('empty', empty);
    r.pin.querySelector('.p-count').textContent = st.devices;
    r.label.classList.toggle('lit', st.lights > 0);
    r.label.classList.toggle('empty', empty);
    const chips = [];
    if (st.temp) chips.push(h('span', {}, ico('mdi:thermometer'), st.temp));
    if (st.lights) chips.push(h('span', {}, ico('mdi:lightbulb-on'), st.lights));
    if (st.motion) chips.push(h('span', {}, ico('mdi:motion-sensor')));
    r.label.querySelector('.chips').replaceChildren(...chips);
  }
}

function sizeHouse() {
  const g = S.houseGeom;
  if (!g) return;
  const stage = $('#stage');
  const availW = stage.clientWidth * 0.96;
  const availH = stage.clientHeight - 24;
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
    st.lights ? h('div', { class: 'row' }, 'Lights on', h('b', {}, st.lights)) : null,
    st.active ? h('div', { class: 'row' }, 'Active', h('b', {}, st.active)) : null,
    st.temp ? h('div', { class: 'row' }, 'Temperature', h('b', {}, st.temp)) : null,
    st.motion ? h('div', { class: 'row' }, 'Motion', h('b', {}, 'Detected')) : null,
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
  const t = e.target.closest('[data-idx]');
  if (t) setHouseFocus(+t.dataset.idx, true);
});
$('#house').addEventListener('pointerleave', () => { setHouseFocus(-1, true); });
$('#house').addEventListener('click', (e) => {
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
  if (hit >= 0 && wheel.opts.onHide) {
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
function deviceItems(aid) {
  return visibleNodes(aid).map((nid) => ({
    id: nid,
    label: devName(nid),
    icon: deviceIcon(nid),
    sub: deviceSub(nid),
    active: visibleEntities(nid).some(isActive),
  }));
}
function entityItems(nid) {
  return visibleEntities(nid).map((eid) => ({
    id: eid, label: entName(eid), icon: entityIcon(eid), sub: stateLabel(eid), active: isActive(eid),
  }));
}
function deviceWheelOpts(aid, selectedId = null) {
  const st = roomStats(aid);
  return {
    center: { icon: roomIcon(aid), title: areaName(aid), sub: `${st.devices} device${st.devices === 1 ? '' : 's'}${st.temp ? ` · ${st.temp}` : ''}` },
    selectedId,
    onSelect: (it) => guard(() => enterDevice(it.id)),
    onHide: (it) => hideItem('devices', devKey(it.id), devName(it.id)),
  };
}
function entityWheelOpts(nid) {
  const d = M().devices[nid];
  return {
    center: { icon: deviceIcon(nid), title: devName(nid), sub: [d.manufacturer, d.model].filter(Boolean).join(' · ') || `${visibleEntities(nid).length} entities` },
    selectedId: S.nav.entityId,
    onSelect: (it) => openEntity(it.id),
    onHide: (it) => hideItem('entities', it.id, entName(it.id)),
  };
}

async function enterArea(aid, room) {
  await guard(async () => {
    hideTooltip();
    S.nav = { level: 'devices', areaId: aid, nodeId: null, entityId: null };
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
    wheel.set(deviceItems(aid), deviceWheelOpts(aid));
    wheelView.classList.remove('hidden');
    await wheel.open();
  });
}

async function enterDevice(nid) {
  const ents = visibleEntities(nid);
  if (setting('skipSingleEntity') && ents.length === 1) {
    S.nav.nodeId = null;
    openEntity(ents[0]);
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
  renderCrumbs();
  await wheel.open();
}

async function leaveDevice() {
  const nid = S.nav.nodeId;
  closeSidebar();
  await wheel.close();
  S.nav.level = 'devices';
  S.nav.nodeId = null;
  const items = deviceItems(S.nav.areaId);
  const idx = items.findIndex((it) => it.id === nid);
  wheel.set(items, { ...deviceWheelOpts(S.nav.areaId), page: idx >= 0 ? Math.floor(idx / wheel.per) : 0 });
  renderCrumbs();
  await wheel.open();
}

async function goHouse() {
  closeSidebar();
  if (S.nav.level !== 'house') await wheel.close();
  S.nav = { level: 'house', areaId: null, nodeId: null, entityId: null };
  wheelView.classList.add('hidden');
  houseView.classList.remove('leaving');
  buildHouse();
  renderCrumbs();
}

function back() {
  guard(async () => {
    if (S.nav.level === 'entities') await leaveDevice();
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
  if (!document.body.classList.contains('sidebar-open')) return;
  document.body.classList.remove('sidebar-open');
  $('#sidebar').setAttribute('aria-hidden', 'true');
  S.nav.entityId = null;
  if (wheel.opts) { wheel.opts.selectedId = null; wheel.paintClasses(); }
  renderCrumbs();
}

function renderCrumbs() {
  const c = $('#crumbs');
  document.title = houseName();
  const parts = [[houseName(), () => guard(goHouse)]];
  const n = S.nav;
  if (n.areaId && M().areas[n.areaId]) {
    const fid = areaFloor(n.areaId);
    const f = allFloors().find((x) => x.id === fid);
    if (f && (isOutdoorFloor(f) || M().floors.length > 1)) parts.push([floorName(f), () => guard(goHouse)]);
    parts.push([areaName(n.areaId), n.level === 'entities' ? () => guard(leaveDevice) : null]);
  }
  if (n.nodeId && M().devices[n.nodeId]) parts.push([devName(n.nodeId), n.entityId ? closeSidebar : null]);
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
}

/** Re-render whatever view is active after model/layout changes. */
function rerenderAll() {
  const n = S.nav;
  if (n.level !== 'house' && (!M().areas[n.areaId] || !visibleNodes(n.areaId).length)) {
    goHouse();
    return;
  }
  if (n.level === 'entities' && (!M().devices[n.nodeId] || !visibleNodes(n.areaId).includes(n.nodeId) || !visibleEntities(n.nodeId).length)) {
    leaveDevice();
    return;
  }
  if (n.entityId && (!M().entities[n.entityId] || isHidden('entities', n.entityId))) closeSidebar();
  if (n.level === 'house') buildHouse();
  else if (n.level === 'devices') { wheel.opts = deviceWheelOpts(n.areaId, wheel.opts.selectedId); wheel.update(deviceItems(n.areaId)); }
  else { wheel.opts = entityWheelOpts(n.nodeId); wheel.update(entityItems(n.nodeId)); }
  if (n.entityId) renderSidebar();
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
      if (a.entity_picture) {
        const sep = a.entity_picture.includes('?') ? '&' : '?';
        out.push(h('img', { class: 'cam', src: `${a.entity_picture}${sep}_=${Date.now()}`, alt: 'Camera snapshot' }));
      }
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

function renderSidebar() {
  const eid = S.nav.entityId;
  const sb = $('#sidebar');
  if (!eid || !S.states[eid] || !M().entities[eid]) { closeSidebar(); return; }
  const scroll = $('.sb-body', sb)?.scrollTop || 0;
  const openDetails = [...sb.querySelectorAll('details[open] > summary')].map((x) => x.textContent);
  const node = M().entities[eid].node;
  sb.replaceChildren(
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
      sec('Dashboard', row(
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

function openEditor() {
  W = JSON.parse(JSON.stringify(S.layout));
  W.settings ||= {};
  const ed = $('#editor');
  const search = h('input', { class: 'txt', type: 'search', placeholder: 'Filter rooms, devices, entities…' });
  const tree = h('div', { class: 'tree' });
  const settings = settingsBlock();
  search.addEventListener('input', () => renderTree(tree, search.value.trim().toLowerCase()));
  search.addEventListener('keydown', (e) => e.stopPropagation());
  ed.replaceChildren(h('div', { class: 'modal-card', role: 'dialog', 'aria-label': 'Customize dashboard' },
    h('div', { class: 'modal-head' }, h('h2', {}, 'Customize'), search,
      h('button', { class: 'sb-close', onclick: closeEditor, title: 'Close' }, ico('mdi:close'))),
    h('div', { class: 'modal-body' }, settings,
      h('p', { class: 'muted', style: 'margin:4px 0 8px;font-size:13px' },
        'Use the eye to show or hide items. Type a name to rename; leave it empty to use the Home Assistant name. Mark a level as Outdoor to show its rooms in a garden outside the house, or move single rooms to the Outdoor level. All of this only affects this dashboard.'),
      tree),
    h('div', { class: 'modal-foot' },
      act('Reset everything', 'mdi:restore', () => {
        if (confirm('Remove all customizations?')) { W = { settings: {} }; openEditorRefresh(tree, search); }
      }, 'small danger'),
      h('span', { class: 'spacer' }),
      act('Cancel', null, closeEditor, 'small'),
      act('Save', 'mdi:content-save', async () => {
        S.layout = W;
        await saveLayout();
        closeEditor();
        rerenderAll();
        toast('Customization saved');
      }, 'small primary'))));
  ed.hidden = false;
  renderTree(tree, '');
  search.focus();
}
function openEditorRefresh(tree, search) {
  $('.settings', $('#editor')).replaceWith(settingsBlock());
  renderTree(tree, search.value.trim().toLowerCase());
}
function settingsBlock() {
  const name = h('input', { class: 'txt', type: 'text', maxlength: 60, placeholder: M().home_name || 'Home' });
  name.value = W.settings.houseName || '';
  name.addEventListener('input', () => {
    const v = name.value.trim();
    if (v) W.settings.houseName = v; else delete W.settings.houseName;
  });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div', { class: 'settings' },
    h('label', { class: 'house-name' }, h('span', {}, 'House name'), name),
    settingBox('hideEmptyRooms', 'Hide rooms without devices'),
    settingBox('skipSingleEntity', 'Skip entity wheel for single-entity devices'));
}
function settingBox(key, label) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!W.settings[key];
  cb.addEventListener('change', () => { W.settings[key] = cb.checked; if (!cb.checked) delete W.settings[key]; });
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
  const m = M();
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
      const devEls = [];
      for (const nid of a.devices) {
        const d = m.devices[nid];
        const dkey = d.device_id || nid;
        const entEls = d.entities.filter((eid) => match(m.entities[eid].full_name, eid, wget('entities', eid).name) || match(d.name, a.name))
          .map((eid) => h('div', { class: 'leaf' }, editRow({
            kind: 'entities', key: eid, label: domainOf(eid), fallback: m.entities[eid].name, icon: entityIcon(eid), orig: eid, summary: false,
          })));
        if (!entEls.length && !match(d.name, a.name)) continue;
        devEls.push(h('details', { open: !!q },
          h('summary', {}, editRow({
            kind: 'devices', key: dkey, label: 'Device', fallback: d.virtual ? `${a.name} extras` : d.name,
            icon: deviceIcon(nid), orig: [d.manufacturer, d.model].filter(Boolean).join(' ') || `${d.entities.length} entities`,
          })),
          entEls));
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

$('#btn-edit').addEventListener('click', () => { if (M()) openEditor(); });

// ===================================================================
// Keyboard
// ===================================================================
document.addEventListener('keydown', (e) => {
  if (!$('#editor').hidden) { if (e.key === 'Escape') closeEditor(); return; }
  if (e.target.matches('input, select, textarea')) return;
  const lvl = S.nav.level;
  if (lvl === 'house') {
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
      if (document.body.classList.contains('sidebar-open')) closeSidebar();
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
  }
  if (touchesSidebar && !S.interacting && !document.activeElement?.closest?.('#sidebar input')) renderSidebar();
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    const n = S.nav;
    if (n.level === 'house') paintHouse();
    else if (wheel.t === 1 && !busy.v) {
      if (n.level === 'devices') wheel.update(deviceItems(n.areaId));
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

/** Optional colour override from the add-on options; the theme's blue is used otherwise. */
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
  applyAccent(data.options?.accent_color);
  S.layout = { floors: {}, areas: {}, devices: {}, entities: {}, settings: {}, ...data.layout };
  setConn(data.connected);
  if (!data.model) return false;
  S.model = data.model;
  S.states = data.states;
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
  $('#empty-house p').textContent = 'No rooms found yet.';
  buildHouse();
  renderCrumbs();
}

let lastCols = 0;
new ResizeObserver(() => {
  if (S.nav.level !== 'house' || !S.model) return;
  const w = $('#stage').clientWidth;
  const cols = w < 560 ? 2 : w < 900 ? 3 : 5;
  if (cols !== lastCols) { lastCols = cols; buildHouse(); } else sizeHouse();
}).observe($('#stage'));
connectWS();
boot();
})();
