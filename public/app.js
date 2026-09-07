/* ==========================================================================
   FTTH Network Manager — StarLine Internet, Minglanilla, Cebu
   ========================================================================== */

const MINGLANILLA = [10.2449, 123.7961];

const state = {
  net: { devices: [], ports: [], links: [], subscribers: [], capacity: {}, reachable: [] },
  byDevice: new Map(),
  byPort: new Map(),
  portsOf: new Map(),
  linkByPort: new Map(),
  subByPort: new Map(),
  reachable: new Set(),
  selection: null,            // { kind: 'device'|'port'|'link'|'subscriber', id }
  mode: null,                 // { kind: 'place', type } | { kind: 'connect', fromPortId }
  showCapacity: false,
  showSubs: true,
  showLabels: true,
  showIsolated: false,
  simulated: null,            // { kind:'link'|'device', id } currently being trace-simulated
};

let map;
const layers = {};
const markers = new Map();     // deviceId -> marker
const subMarkers = new Map();  // subscriberId -> marker
const linkLines = new Map();   // linkId -> polyline
const dropLines = new Map();   // subscriberId -> polyline

const TYPE_META = {
  OLT: { label: 'OLT', color: '#ff7a45', short: 'O', defaultPorts: 8, defaultIn: 0, hint: 'PON ports' },
  NAP: { label: 'NAP box', color: '#3ba9ff', short: 'N', defaultPorts: 8, defaultIn: 1, hint: 'output ports' },
  SPLITTER: { label: 'Splitter', color: '#a97bff', short: 'S', defaultPorts: 8, defaultIn: 1, hint: 'output ports' },
  JOINT: { label: 'Joint / closure', color: '#7c8aa0', short: 'J', defaultPorts: 4, defaultIn: 1, hint: 'fiber cores' },
};

/**
 * TIA-598-C pigtail colours, in the order they appear in a NAP or splitter.
 * `ink` is the text colour that stays readable on top of `hex`.
 */
const FIBER_COLORS = [
  { name: 'Blue',   short: 'BL', hex: '#0057b8', ink: '#ffffff' },
  { name: 'Orange', short: 'OR', hex: '#ff7a00', ink: '#241100' },
  { name: 'Green',  short: 'GN', hex: '#00a651', ink: '#00190c' },
  { name: 'Brown',  short: 'BN', hex: '#7b4b28', ink: '#ffffff' },
  { name: 'Slate',  short: 'SL', hex: '#8c8c8c', ink: '#141414' },
  { name: 'White',  short: 'WH', hex: '#f2f2f2', ink: '#141414' },
  { name: 'Red',    short: 'RD', hex: '#e02020', ink: '#ffffff' },
  { name: 'Black',  short: 'BK', hex: '#1a1a1a', ink: '#ffffff' },
  { name: 'Yellow', short: 'YL', hex: '#ffd500', ink: '#211c00' },
  { name: 'Violet', short: 'VI', hex: '#7b2fbe', ink: '#ffffff' },
  { name: 'Rose',   short: 'RS', hex: '#ff8fb1', ink: '#2a0a15' },
  { name: 'Aqua',   short: 'AQ', hex: '#35d0d0', ink: '#03211f' },
];
const colorMeta = (name) =>
  FIBER_COLORS.find((c) => c.name.toLowerCase() === String(name || '').toLowerCase()) || null;

/* ------------------------------- helpers -------------------------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('Not signed in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function metersBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/* --------------------------------- map ---------------------------------- */

function initMap() {
  map = L.map('map', { zoomControl: true, center: MINGLANILLA, zoom: 14 });

  layers.street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  });
  layers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }
  );
  layers.labels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, opacity: 0.9 }
  );
  layers.hybrid = L.layerGroup([layers.satellite, layers.labels]);

  layers.street.addTo(map);
  L.control
    .layers(
      { 'Street map': layers.street, Satellite: layers.satellite, 'Satellite + labels': layers.hybrid },
      {},
      { position: 'topright' }
    )
    .addTo(map);

  map.on('click', (e) => {
    if (state.mode && state.mode.kind === 'place') {
      openNewDeviceModal(state.mode.type, e.latlng);
    }
  });

  // device names only make sense once you are zoomed in far enough
  map.on('zoomend', () => {
    const wanted = map.getZoom() >= 14 && $('#toggle-labels').checked;
    if (wanted !== state.showLabels) { state.showLabels = wanted; renderMap(); }
  });
}

function fitToNetwork() {
  const pts = state.net.devices.map((d) => [d.lat, d.lng]);
  for (const s of state.net.subscribers) if (s.lat != null) pts.push([s.lat, s.lng]);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17 });
  else if (pts.length === 1) map.setView(pts[0], 16);
}

function pinIcon(device) {
  const meta = TYPE_META[device.type] || TYPE_META.JOINT;
  let color = meta.color;

  if (state.showCapacity && device.type !== 'JOINT') {
    const cap = state.net.capacity[device.id];
    if (cap && cap.total > 0) {
      const freeRatio = cap.free / cap.total;
      color = freeRatio === 0 ? '#ff5c6c' : freeRatio <= 0.25 ? '#ffc44d' : '#3ddc97';
    }
  }
  if (device.status === 'fault') color = '#ff5c6c';
  if (device.status === 'planned') color = '#667389';
  if (state.simulated?.lostDeviceIds?.includes(device.id)) color = '#ff5c6c';

  const selected = state.selection?.kind === 'device' && state.selection.id === device.id;
  const isolated = state.showIsolated && !state.reachable.has(device.id) && device.type !== 'OLT';
  const simulatedOut = state.simulated?.lostDeviceIds?.includes(device.id);

  const classes = [
    'dev-pin',
    device.type.toLowerCase(),
    selected ? 'selected' : '',
    isolated ? 'isolated' : '',
    simulatedOut ? 'faulted isolated' : '',
  ].filter(Boolean).join(' ');

  const label = state.showLabels
    ? `<div class="dev-label">${esc(device.name)}</div>`
    : '';

  return L.divIcon({
    className: 'dev-marker',
    html: `<div class="${classes}" style="background:${color}"><span>${TYPE_META[device.type]?.short || '?'}</span></div>${label}`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function subIcon(sub) {
  const color =
    sub.status === 'active' ? '#3ddc97'
    : sub.status === 'suspended' ? '#ffc44d'
    : sub.status === 'pending' ? '#3ba9ff'
    : '#ff5c6c';
  const out = state.simulated?.affectedIds?.has(sub.id);
  return L.divIcon({
    className: 'dev-marker',
    html: `<div class="dev-pin sub ${out ? 'faulted isolated' : ''}" style="background:${out ? '#ff5c6c' : color}"
             title="${esc(sub.name)}"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

function linkLatLngs(link) {
  const pa = state.byPort.get(link.from_port_id);
  const pb = state.byPort.get(link.to_port_id);
  if (!pa || !pb) return null;
  const da = state.byDevice.get(pa.device_id);
  const db = state.byDevice.get(pb.device_id);
  if (!da || !db) return null;
  const mid = Array.isArray(link.path) ? link.path : [];
  return [[da.lat, da.lng], ...mid.map((p) => [p[0], p[1]]), [db.lat, db.lng]];
}

function renderMap() {
  // devices
  const seen = new Set();
  for (const d of state.net.devices) {
    seen.add(d.id);
    let m = markers.get(d.id);
    if (!m) {
      m = L.marker([d.lat, d.lng], { icon: pinIcon(d), draggable: true, zIndexOffset: 400 });
      m.on('click', () => onDeviceClick(d.id));
      m.on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng();
        try {
          await api(`/devices/${d.id}`, { method: 'PATCH', body: { lat, lng } });
          await refresh({ keepSelection: true });
          toast('Position updated', 'ok');
        } catch (err) { toast(err.message, 'error'); await refresh(); }
      });
      m.addTo(map);
      markers.set(d.id, m);
    } else {
      m.setLatLng([d.lat, d.lng]);
      m.setIcon(pinIcon(d));
    }
  }
  for (const [id, m] of markers) if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }

  // links
  const seenLinks = new Set();
  for (const l of state.net.links) {
    seenLinks.add(l.id);
    const pts = linkLatLngs(l);
    if (!pts) continue;
    const down = state.simulated?.lostLinkIds?.has(l.id);
    const style = {
      color: l.status === 'cut' || down ? '#ff5c6c' : l.status === 'planned' ? '#667389' : '#4fb0ff',
      weight: state.selection?.kind === 'link' && state.selection.id === l.id ? 6 : 3.5,
      opacity: 0.95,
      dashArray: l.status === 'planned' ? '7,7' : l.status === 'cut' ? '3,6' : null,
    };
    let line = linkLines.get(l.id);
    if (!line) {
      line = L.polyline(pts, style);
      line.on('click', (e) => { L.DomEvent.stop(e); openLink(l.id); });
      line.addTo(map);
      linkLines.set(l.id, line);
    } else {
      line.setLatLngs(pts);
      line.setStyle(style);
    }
  }
  for (const [id, line] of linkLines) if (!seenLinks.has(id)) { map.removeLayer(line); linkLines.delete(id); }

  // subscribers
  const seenSubs = new Set();
  for (const s of state.net.subscribers) {
    if (!state.showSubs || s.lat == null || s.lng == null) continue;
    seenSubs.add(s.id);
    let m = subMarkers.get(s.id);
    if (!m) {
      m = L.marker([s.lat, s.lng], { icon: subIcon(s), draggable: true, zIndexOffset: 200 });
      m.on('click', () => openSubscriber(s.id));
      m.on('dragend', async (e) => {
        const { lat, lng } = e.target.getLatLng();
        try {
          await api(`/subscribers/${s.id}`, { method: 'PATCH', body: { lat, lng } });
          await refresh({ keepSelection: true });
        } catch (err) { toast(err.message, 'error'); await refresh(); }
      });
      m.addTo(map);
      subMarkers.set(s.id, m);
    } else {
      m.setLatLng([s.lat, s.lng]);
      m.setIcon(subIcon(s));
    }

    // drop cable line from NAP port to house
    const port = state.byPort.get(s.port_id);
    const dev = port ? state.byDevice.get(port.device_id) : null;
    let dl = dropLines.get(s.id);
    if (dev) {
      const pts = [[dev.lat, dev.lng], [s.lat, s.lng]];
      const st = { color: '#3ddc97', weight: 1.4, opacity: 0.55, dashArray: '3,5' };
      if (!dl) { dl = L.polyline(pts, st); dl.addTo(map); dropLines.set(s.id, dl); }
      else { dl.setLatLngs(pts); dl.setStyle(st); }
    } else if (dl) { map.removeLayer(dl); dropLines.delete(s.id); }
  }
  for (const [id, m] of subMarkers) if (!seenSubs.has(id)) { map.removeLayer(m); subMarkers.delete(id); }
  for (const [id, l] of dropLines) if (!seenSubs.has(id)) { map.removeLayer(l); dropLines.delete(id); }
}

/* -------------------------------- data ---------------------------------- */

function reindex() {
  state.byDevice = new Map(state.net.devices.map((d) => [d.id, d]));
  state.byPort = new Map(state.net.ports.map((p) => [p.id, p]));
  state.portsOf = new Map();
  for (const p of state.net.ports) {
    if (!state.portsOf.has(p.device_id)) state.portsOf.set(p.device_id, []);
    state.portsOf.get(p.device_id).push(p);
  }
  for (const arr of state.portsOf.values()) arr.sort((a, b) => a.port_no - b.port_no);
  state.linkByPort = new Map();
  for (const l of state.net.links) {
    state.linkByPort.set(l.from_port_id, l);
    state.linkByPort.set(l.to_port_id, l);
  }
  state.subByPort = new Map();
  for (const s of state.net.subscribers) if (s.port_id) state.subByPort.set(s.port_id, s);
  state.reachable = new Set(state.net.reachable || []);
}

async function refresh({ keepSelection = true } = {}) {
  state.net = await api('/network');
  reindex();
  renderMap();
  renderStats();
  if (keepSelection && state.selection) reopenSelection();
}

function reopenSelection() {
  const s = state.selection;
  if (!s) return;
  if (s.kind === 'device' && state.byDevice.has(s.id)) return openDevice(s.id, { silent: true });
  if (s.kind === 'link' && state.net.links.some((l) => l.id === s.id)) return openLink(s.id, { silent: true });
  if (s.kind === 'subscriber' && state.net.subscribers.some((x) => x.id === s.id))
    return openSubscriber(s.id, { silent: true });
  closeDrawer();
}

function renderStats() {
  const d = state.net.devices;
  const counts = { OLT: 0, NAP: 0, SPLITTER: 0, JOINT: 0 };
  for (const x of d) counts[x.type] = (counts[x.type] || 0) + 1;

  let totalPorts = 0, freePorts = 0;
  for (const p of state.net.ports) { totalPorts++; if (p.status === 'free') freePorts++; }
  const activeSubs = state.net.subscribers.filter((s) => s.status === 'active').length;
  const faults =
    state.net.links.filter((l) => l.status === 'cut').length +
    d.filter((x) => x.status === 'fault').length;

  $('#stats').innerHTML = `
    <div class="stat"><b>${counts.OLT}</b><span>OLT</span></div>
    <div class="stat"><b>${counts.NAP}</b><span>NAP boxes</span></div>
    <div class="stat"><b>${state.net.subscribers.length}</b><span>Subscribers</span></div>
    <div class="stat"><b>${activeSubs}</b><span>Active</span></div>
    <div class="stat"><b>${freePorts}/${totalPorts}</b><span>Free ports</span></div>
    <div class="stat"><b style="color:${faults ? 'var(--danger)' : 'inherit'}">${faults}</b><span>Faults</span></div>
  `;
}

/* -------------------------------- drawer -------------------------------- */

function openDrawer(kicker, title, html) {
  $('#drawer-kicker').textContent = kicker;
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  state.selection = null;
  state.simulated = null;
  renderMap();
}

function onDeviceClick(deviceId) {
  if (state.mode && state.mode.kind === 'connect') {
    openDevice(deviceId, { pickTarget: true });
    return;
  }
  openDevice(deviceId);
}

function statusPill(v) {
  return `<span class="pill ${esc(v)}">${esc(v)}</span>`;
}

/** Human name for a port: "Feeder in", "port 3", or "port 3 (Green)". */
function portName(p) {
  if (!p) return 'port ?';
  if (p.port_kind === 'in') {
    const dev = state.byDevice.get(p.device_id);
    return dev && dev.input_count > 1 ? `feeder in ${p.port_no}` : 'feeder in';
  }
  const dev = state.byDevice.get(p.device_id);
  const cm = colorMeta(p.fiber_color);
  return cm && dev?.port_labeling && dev.port_labeling !== 'number'
    ? `port ${p.port_no} (${cm.name})`
    : `port ${p.port_no}`;
}

function portClass(p) {
  if (state.subByPort.has(p.id)) return 'sub';
  if (p.status === 'used') return 'used';
  return p.status;
}

function portCellHtml(p, labeling) {
  const link = state.linkByPort.get(p.id);
  const sub = state.subByPort.get(p.id);
  const tag = sub ? '👤' : link ? '⇄' : '';
  const selected = state.selection?.kind === 'port' && state.selection.id === p.id;
  const cm = colorMeta(p.fiber_color);
  const showColor = p.port_kind === 'out' && cm && labeling !== 'number';

  // In pure colour mode the pigtail colour is the port's identity, so it fills
  // the cell; status still shows through the border and the corner tag.
  const style = showColor && labeling === 'color'
    ? `background:${cm.hex};color:${cm.ink}`
    : '';
  const face = p.port_kind === 'in'
    ? 'IN'
    : labeling === 'color' ? cm?.short ?? p.port_no
    : labeling === 'both' ? `${p.port_no}` : `${p.port_no}`;

  const stripe = showColor && labeling === 'both'
    ? `<span class="stripe" style="background:${cm.hex}"></span>` : '';

  const what = sub ? sub.name : link ? 'fiber link' : p.label || 'free';
  const title = p.port_kind === 'in'
    ? `Feeder in ${p.port_no} — ${what}`
    : `Port ${p.port_no}${cm ? ' · ' + cm.name : ''} — ${what}`;

  const colored = showColor && labeling === 'color';
  return `<div class="port ${portClass(p)} ${p.port_kind === 'in' ? 'feeder' : ''}
              ${colored ? 'colored' : ''} ${selected ? 'selected' : ''}"
            data-port="${p.id}" style="${style}" title="${esc(title)}">
            ${stripe}${esc(face)}<span class="tag">${tag}</span>
          </div>`;
}

function portGridHtml(device, { pickTarget = false } = {}) {
  const ports = state.portsOf.get(device.id) || [];
  if (!ports.length) return '<div class="empty">No ports configured. Set a port count below.</div>';
  const labeling = device.port_labeling || 'number';
  const ins = ports.filter((p) => p.port_kind === 'in');
  const outs = ports.filter((p) => p.port_kind !== 'in');
  const meta = TYPE_META[device.type] || TYPE_META.JOINT;

  const inBlock = ins.length
    ? `<div class="port-sub">Feeder in — the cable arriving from upstream</div>
       <div class="port-grid feeder-grid">${ins.map((p) => portCellHtml(p, labeling)).join('')}</div>`
    : '';

  const ringKey = labeling === 'color'
    ? `<div class="ring-key">
         <span><i class="ring free"></i>free</span>
         <span><i class="ring used"></i>fiber link</span>
         <span><i class="ring sub"></i>subscriber</span>
         <span><i class="ring faulty"></i>faulty</span>
       </div>`
    : '';

  const outBlock = outs.length
    ? `<div class="port-sub">${esc(meta.hint)}${labeling !== 'number' ? ' — pigtail colour' : ''}</div>
       <div class="port-grid">${outs.map((p) => portCellHtml(p, labeling)).join('')}</div>
       ${ringKey}`
    : '';

  return `
    ${pickTarget ? '<p class="hint">Pick the destination port for the fiber link.</p>' : ''}
    ${inBlock}${outBlock}`;
}

function openDevice(deviceId, opts = {}) {
  const d = state.byDevice.get(deviceId);
  if (!d) return;
  state.selection = { kind: 'device', id: deviceId };
  const meta = TYPE_META[d.type] || TYPE_META.JOINT;
  const cap = state.net.capacity[d.id] || { total: 0, free: 0, used: 0, subscribers: 0 };
  const isolated = d.type !== 'OLT' && !state.reachable.has(d.id);

  const html = `
    <ul class="info-list">
      <li><span class="k">Type</span><span class="v">${esc(meta.label)}</span></li>
      <li><span class="k">Status</span><span class="v">${statusPill(d.status)}</span></li>
      ${d.model ? `<li><span class="k">Model</span><span class="v">${esc(d.model)}</span></li>` : ''}
      ${d.splitter_ratio ? `<li><span class="k">Split ratio</span><span class="v">${esc(d.splitter_ratio)}</span></li>` : ''}
      ${d.area ? `<li><span class="k">Area</span><span class="v">${esc(d.area)}</span></li>` : ''}
      ${d.address ? `<li><span class="k">Address</span><span class="v">${esc(d.address)}</span></li>` : ''}
      <li><span class="k">Output ports</span><span class="v">${cap.used} used · ${cap.free} free · ${cap.total} total</span></li>
      ${d.input_count ? `<li><span class="k">Feeder in</span><span class="v">${d.input_count} port${d.input_count > 1 ? 's' : ''}</span></li>` : ''}
      <li><span class="k">Subscribers</span><span class="v">${cap.subscribers}</span></li>
      <li><span class="k">Coordinates</span><span class="v">${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}</span></li>
      ${d.notes ? `<li><span class="k">Notes</span><span class="v">${esc(d.notes)}</span></li>` : ''}
      ${isolated ? `<li><span class="k">Feed</span><span class="v" style="color:var(--danger)">No path to an OLT</span></li>` : ''}
    </ul>

    <div class="section-title"><span>Ports</span></div>
    ${portGridHtml(d, opts)}

    <div class="btn-row">
      <button class="btn" data-act="edit-device">Edit</button>
      <button class="btn" data-act="trace">Trace to OLT</button>
      <button class="btn" data-act="impact">Impact if down</button>
      <button class="btn danger" data-act="delete-device">Delete</button>
    </div>
    <div id="drawer-extra"></div>
  `;
  openDrawer(meta.label, d.name, html);

  $('#drawer-body').querySelectorAll('.port').forEach((el) => {
    el.addEventListener('click', () => {
      const portId = el.dataset.port;
      if (state.mode && state.mode.kind === 'connect') return completeConnect(portId);
      openPort(portId);
    });
  });
  $('#drawer-body').querySelector('[data-act="edit-device"]').onclick = () => openEditDeviceModal(d);
  $('#drawer-body').querySelector('[data-act="trace"]').onclick = () => traceDevice(d.id);
  $('#drawer-body').querySelector('[data-act="impact"]').onclick = () => showImpact({ deviceId: d.id }, d.name);
  $('#drawer-body').querySelector('[data-act="delete-device"]').onclick = () => deleteDevice(d);

  if (!opts.silent) map.panTo([d.lat, d.lng]);
  renderMap();
}

function openPort(portId) {
  const p = state.byPort.get(portId);
  if (!p) return;
  const dev = state.byDevice.get(p.device_id);
  state.selection = { kind: 'port', id: portId };

  const link = state.linkByPort.get(p.id);
  const sub = state.subByPort.get(p.id);

  let connected = '<div class="empty">Nothing connected to this port yet.</div>';
  if (link) {
    const otherPortId = link.from_port_id === p.id ? link.to_port_id : link.from_port_id;
    const op = state.byPort.get(otherPortId);
    const od = op ? state.byDevice.get(op.device_id) : null;
    connected = `
      <div class="mini-card clickable" data-open-link="${link.id}">
        <div class="title">⇄ ${esc(od?.name || 'unknown')} · ${esc(portName(op))}</div>
        <div class="meta">
          ${statusPill(link.status)}
          ${link.cable_length_m ? ' · ' + esc(link.cable_length_m) + ' m' : ''}
          ${link.fiber_core ? ' · core ' + esc(link.fiber_core) : ''}
          ${link.cable_type ? ' · ' + esc(link.cable_type) : ''}
        </div>
      </div>`;
  } else if (sub) {
    connected = `
      <div class="mini-card clickable" data-open-sub="${sub.id}">
        <div class="title">👤 ${esc(sub.name)}</div>
        <div class="meta">${statusPill(sub.status)}${sub.plan ? ' · ' + esc(sub.plan) : ''}${sub.pppoe_username ? ' · ' + esc(sub.pppoe_username) : ''}</div>
      </div>`;
  }

  const cm = colorMeta(p.fiber_color);
  const html = `
    <ul class="info-list">
      <li><span class="k">Device</span><span class="v">${esc(dev?.name || '')}</span></li>
      <li><span class="k">Role</span><span class="v">${p.port_kind === 'in' ? 'Feeder in (from upstream)' : 'Output / drop'}</span></li>
      ${cm ? `<li><span class="k">Pigtail colour</span><span class="v">
        <span class="swatch" style="background:${cm.hex}"></span>${esc(cm.name)}</span></li>` : ''}
      <li><span class="k">Port status</span><span class="v">${statusPill(p.status)}</span></li>
      ${p.label ? `<li><span class="k">Label</span><span class="v">${esc(p.label)}</span></li>` : ''}
      ${p.notes ? `<li><span class="k">Notes</span><span class="v">${esc(p.notes)}</span></li>` : ''}
    </ul>

    <div class="section-title"><span>Connected to</span></div>
    ${connected}

    <div class="btn-row">
      ${!link && !sub ? '<button class="btn primary" data-act="connect">Connect fiber →</button>' : ''}
      ${!link && !sub ? '<button class="btn" data-act="add-sub">Assign subscriber</button>' : ''}
      <button class="btn" data-act="edit-port">Edit port</button>
      ${link ? '<button class="btn danger" data-act="del-link">Remove fiber link</button>' : ''}
      <button class="btn ghost" data-act="back">← Back to device</button>
    </div>
  `;
  const heading = p.port_kind === 'in'
    ? (dev?.input_count > 1 ? `Feeder in ${p.port_no}` : 'Feeder in')
    : `Port ${p.port_no}${cm && dev?.port_labeling !== 'number' ? ' · ' + cm.name : ''}`;
  openDrawer(`${dev?.name || 'Device'} · ${heading}`, heading, html);

  const body = $('#drawer-body');
  body.querySelector('[data-act="back"]').onclick = () => openDevice(p.device_id, { silent: true });
  body.querySelector('[data-act="edit-port"]').onclick = () => openEditPortModal(p);
  body.querySelector('[data-act="connect"]')?.addEventListener('click', () => startConnect(p.id));
  body.querySelector('[data-act="add-sub"]')?.addEventListener('click', () => openSubscriberModal(null, p.id));
  body.querySelector('[data-act="del-link"]')?.addEventListener('click', () => deleteLink(link.id));
  body.querySelector('[data-open-link]')?.addEventListener('click', (e) => openLink(e.currentTarget.dataset.openLink));
  body.querySelector('[data-open-sub]')?.addEventListener('click', (e) => openSubscriber(e.currentTarget.dataset.openSub));
}

function openLink(linkId, opts = {}) {
  const l = state.net.links.find((x) => x.id === linkId);
  if (!l) return;
  state.selection = { kind: 'link', id: linkId };
  const pa = state.byPort.get(l.from_port_id);
  const pb = state.byPort.get(l.to_port_id);
  const da = pa ? state.byDevice.get(pa.device_id) : null;
  const db = pb ? state.byDevice.get(pb.device_id) : null;
  const straight = da && db ? metersBetween([da.lat, da.lng], [db.lat, db.lng]) : null;

  const html = `
    <ul class="info-list">
      <li><span class="k">From</span><span class="v">${esc(da?.name || '?')} · ${esc(portName(pa))}</span></li>
      <li><span class="k">To</span><span class="v">${esc(db?.name || '?')} · ${esc(portName(pb))}</span></li>
      <li><span class="k">Status</span><span class="v">${statusPill(l.status)}</span></li>
      <li><span class="k">Cable length</span><span class="v">${l.cable_length_m ? esc(l.cable_length_m) + ' m' : '—'}</span></li>
      ${straight ? `<li><span class="k">Straight line</span><span class="v">${straight} m</span></li>` : ''}
      <li><span class="k">Fiber core</span><span class="v">${l.fiber_core ? esc(l.fiber_core) : '—'}</span></li>
      <li><span class="k">Cable type</span><span class="v">${l.cable_type ? esc(l.cable_type) : '—'}</span></li>
      ${l.notes ? `<li><span class="k">Notes</span><span class="v">${esc(l.notes)}</span></li>` : ''}
    </ul>

    <div class="btn-row">
      <button class="btn" data-act="edit">Edit link</button>
      ${l.status === 'cut'
        ? '<button class="btn" data-act="repair">Mark repaired</button>'
        : '<button class="btn danger" data-act="cut">Mark as cut</button>'}
      <button class="btn" data-act="impact">Who goes down?</button>
      <button class="btn danger" data-act="delete">Delete link</button>
    </div>
    <div id="drawer-extra"></div>
  `;
  openDrawer('Fiber link', `${da?.name || '?'} → ${db?.name || '?'}`, html);

  const body = $('#drawer-body');
  body.querySelector('[data-act="edit"]').onclick = () => openEditLinkModal(l);
  body.querySelector('[data-act="impact"]').onclick = () =>
    showImpact({ linkId: l.id }, `${da?.name || '?'} → ${db?.name || '?'}`);
  body.querySelector('[data-act="delete"]').onclick = () => deleteLink(l.id);
  body.querySelector('[data-act="cut"]')?.addEventListener('click', async () => {
    await api(`/links/${l.id}`, { method: 'PATCH', body: { status: 'cut' } });
    await refresh();
    toast('Marked as cut', 'ok');
    showImpact({ linkId: l.id }, `${da?.name || '?'} → ${db?.name || '?'}`);
  });
  body.querySelector('[data-act="repair"]')?.addEventListener('click', async () => {
    await api(`/links/${l.id}`, { method: 'PATCH', body: { status: 'active' } });
    await refresh();
    toast('Link restored', 'ok');
  });

  if (!opts.silent && da && db) {
    map.fitBounds(L.latLngBounds([[da.lat, da.lng], [db.lat, db.lng]]), { padding: [80, 80], maxZoom: 18 });
  }
  renderMap();
}

function openSubscriber(subId, opts = {}) {
  const s = state.net.subscribers.find((x) => x.id === subId);
  if (!s) return;
  state.selection = { kind: 'subscriber', id: subId };
  const port = state.byPort.get(s.port_id);
  const dev = port ? state.byDevice.get(port.device_id) : null;

  const html = `
    <ul class="info-list">
      <li><span class="k">Status</span><span class="v">${statusPill(s.status)}</span></li>
      ${s.plan ? `<li><span class="k">Plan</span><span class="v">${esc(s.plan)}</span></li>` : ''}
      ${s.pppoe_username ? `<li><span class="k">PPPoE</span><span class="v">${esc(s.pppoe_username)}</span></li>` : ''}
      ${s.onu_serial ? `<li><span class="k">ONU serial</span><span class="v">${esc(s.onu_serial)}</span></li>` : ''}
      ${s.phone ? `<li><span class="k">Phone</span><span class="v">${esc(s.phone)}</span></li>` : ''}
      ${s.address ? `<li><span class="k">Address</span><span class="v">${esc(s.address)}</span></li>` : ''}
      <li><span class="k">Fed from</span><span class="v">${dev ? esc(dev.name) + ' · ' + esc(portName(port)) : 'not assigned'}</span></li>
      ${s.drop_length_m ? `<li><span class="k">Drop cable</span><span class="v">${esc(s.drop_length_m)} m</span></li>` : ''}
      ${s.installed_on ? `<li><span class="k">Installed</span><span class="v">${esc(String(s.installed_on).slice(0, 10))}</span></li>` : ''}
      ${s.notes ? `<li><span class="k">Notes</span><span class="v">${esc(s.notes)}</span></li>` : ''}
    </ul>

    <div class="btn-row">
      <button class="btn" data-act="edit">Edit</button>
      ${dev ? '<button class="btn" data-act="goto-nap">Go to NAP</button>' : ''}
      ${dev ? '<button class="btn" data-act="trace">Trace to OLT</button>' : ''}
      <button class="btn danger" data-act="delete">Delete</button>
    </div>
    <div id="drawer-extra"></div>
  `;
  openDrawer('Subscriber', s.name, html);

  const body = $('#drawer-body');
  body.querySelector('[data-act="edit"]').onclick = () => openSubscriberModal(s, s.port_id);
  body.querySelector('[data-act="goto-nap"]')?.addEventListener('click', () => openDevice(dev.id));
  body.querySelector('[data-act="trace"]')?.addEventListener('click', () => traceDevice(dev.id));
  body.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm(`Delete subscriber "${s.name}"? Their port will be freed.`)) return;
    await api(`/subscribers/${s.id}`, { method: 'DELETE' });
    closeDrawer();
    await refresh({ keepSelection: false });
    toast('Subscriber deleted', 'ok');
  };

  if (!opts.silent && s.lat != null) map.panTo([s.lat, s.lng]);
  renderMap();
}

/* ------------------------------ tracing --------------------------------- */

async function traceDevice(deviceId) {
  const res = await api(`/trace/${deviceId}`);
  const extra = $('#drawer-extra');
  if (!extra) return;
  if (!res.connected) {
    extra.innerHTML = `<div class="section-title"><span>Path to OLT</span></div>
      <div class="empty">This device has no live path back to an OLT.</div>`;
    return;
  }
  const start = state.byDevice.get(deviceId);
  const items = [
    `<li><strong>${esc(start?.name || '')}</strong><div class="meta">start</div></li>`,
    ...res.hops.map(
      (h) => `<li><strong>${esc(h.device?.name || '')}</strong>
        <div class="meta">via ${esc(portName(h.viaPort))} → ${esc(portName(h.peerPort))}</div></li>`
    ),
  ];
  extra.innerHTML = `<div class="section-title"><span>Path to OLT (${res.hops.length} hop${res.hops.length === 1 ? '' : 's'})</span></div>
    <ul class="trace-path">${items.join('')}</ul>`;
}

async function showImpact(params, label) {
  const qs = new URLSearchParams(params).toString();
  const res = await api('/impact?' + qs);
  state.simulated = {
    lostDeviceIds: res.lostDeviceIds,
    lostLinkIds: new Set(params.linkId ? [params.linkId] : []),
    affectedIds: new Set(res.affectedSubscribers.map((s) => s.id)),
  };
  renderMap();

  const extra = $('#drawer-extra');
  if (!extra) return;
  const subs = res.affectedSubscribers;
  const list = subs.length
    ? subs
        .map(
          (s) => `<div class="mini-card clickable" data-sub="${s.id}">
            <div class="title">${esc(s.name)}</div>
            <div class="meta">${esc(s.device_name || '')} · port ${s.port_no ?? '?'}${s.pppoe_username ? ' · ' + esc(s.pppoe_username) : ''}</div>
          </div>`
        )
        .join('')
    : '<div class="empty">No subscribers lose service from this.</div>';

  extra.innerHTML = `
    <div class="section-title">
      <span>Impact — ${esc(label)}</span>
      <button class="btn tiny ghost" id="clear-sim">Clear</button>
    </div>
    <p class="hint">${subs.length} subscriber${subs.length === 1 ? '' : 's'} and
      ${res.lostDevices.length} device${res.lostDevices.length === 1 ? '' : 's'} would go dark.</p>
    ${list}`;

  extra.querySelectorAll('[data-sub]').forEach((el) =>
    el.addEventListener('click', () => openSubscriber(el.dataset.sub))
  );
  extra.querySelector('#clear-sim').onclick = () => {
    state.simulated = null;
    renderMap();
    extra.innerHTML = '';
  };
}

/* -------------------------------- modes --------------------------------- */

function setMode(mode, text) {
  state.mode = mode;
  const banner = $('#mode-banner');
  if (mode) {
    $('#mode-text').textContent = text;
    banner.hidden = false;
    map.getContainer().style.cursor = 'crosshair';
  } else {
    banner.hidden = true;
    map.getContainer().style.cursor = '';
  }
  document.querySelectorAll('.place-btn').forEach((b) =>
    b.classList.toggle('active', mode?.kind === 'place' && b.dataset.place === mode.type)
  );
}

function startConnect(fromPortId) {
  const p = state.byPort.get(fromPortId);
  const d = state.byDevice.get(p.device_id);
  setMode(
    { kind: 'connect', fromPortId },
    `Connecting from ${d.name} ${portName(p)} — click the destination device, then its port`
  );
  toast('Now click the device you want to feed', 'ok');
}

async function completeConnect(toPortId) {
  const fromPortId = state.mode.fromPortId;
  if (fromPortId === toPortId) return toast('Pick a different port', 'error');
  const fp = state.byPort.get(fromPortId);
  const tp = state.byPort.get(toPortId);
  if (fp.device_id === tp.device_id) return toast('Both ports are on the same device', 'error');
  if (state.linkByPort.has(toPortId)) return toast('That port already has a fiber link', 'error');
  if (state.subByPort.has(toPortId)) return toast('That port is taken by a subscriber', 'error');
  if (fp.port_kind === 'in' && tp.port_kind === 'in') {
    return toast('Both ends are feeder-ins — one end has to be an output port', 'error');
  }

  const da = state.byDevice.get(fp.device_id);
  const db = state.byDevice.get(tp.device_id);
  const guess = metersBetween([da.lat, da.lng], [db.lat, db.lng]);

  openModal({
    title: 'New fiber link',
    body: `
      <p class="hint">${esc(da.name)} ${esc(portName(fp))} → ${esc(db.name)} ${esc(portName(tp))}</p>
      <div class="field-row">
        <div class="field"><label>Cable length (m)</label><input id="f-len" type="number" min="0" value="${guess}" /></div>
        <div class="field"><label>Fiber core</label><input id="f-core" placeholder="e.g. Blue 1" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Cable type</label><input id="f-type" placeholder="e.g. 12-core ADSS" /></div>
        <div class="field"><label>Status</label>
          <select id="f-status">
            <option value="active">Active</option>
            <option value="planned">Planned</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Notes</label><textarea id="f-notes" placeholder="Pole route, slack loop location…"></textarea></div>
    `,
    confirm: 'Create link',
    onConfirm: async () => {
      await api('/links', {
        method: 'POST',
        body: {
          from_port_id: fromPortId,
          to_port_id: toPortId,
          cable_length_m: $('#f-len').value,
          fiber_core: $('#f-core').value,
          cable_type: $('#f-type').value,
          status: $('#f-status').value,
          notes: $('#f-notes').value,
        },
      });
      setMode(null);
      await refresh({ keepSelection: false });
      state.selection = null;
      openDevice(db.id, { silent: true });
      toast('Fiber link created', 'ok');
    },
  });
}

/* -------------------------------- modals -------------------------------- */

let modalConfirm = null;

function openModal({ title, body, confirm: confirmLabel = 'Save', onConfirm, afterOpen }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-foot').innerHTML = `
    <button class="btn ghost" id="modal-cancel">Cancel</button>
    <button class="btn primary" id="modal-ok">${esc(confirmLabel)}</button>`;
  $('#modal-backdrop').hidden = false;
  modalConfirm = onConfirm;
  $('#modal-cancel').onclick = closeModal;
  $('#modal-ok').onclick = async () => {
    try {
      await modalConfirm?.();
      closeModal();
    } catch (e) { toast(e.message, 'error'); }
  };
  afterOpen?.();
  setTimeout(() => $('#modal-body input, #modal-body select, #modal-body textarea')?.focus(), 30);
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  $('#modal-body').innerHTML = '';
  modalConfirm = null;
}

function deviceFormHtml(d, type) {
  const t = d?.type || type;
  const meta = TYPE_META[t];
  return `
    <div class="field"><label>Name</label>
      <input id="d-name" value="${esc(d?.name || '')}" placeholder="${t === 'OLT' ? 'e.g. OLT-Poblacion' : t === 'NAP' ? 'e.g. NAP-Tunghaan-03' : 'e.g. SPL-Calajoan-01'}" /></div>
    <div class="field-row">
      <div class="field"><label>Type</label>
        <select id="d-type">
          ${Object.entries(TYPE_META).map(([k, v]) => `<option value="${k}" ${k === t ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></div>
      <div class="field"><label>Status</label>
        <select id="d-status">
          ${['active', 'planned', 'fault', 'offline'].map((s) => `<option ${d?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Output ports (${esc(meta.hint)})</label>
        <input id="d-ports" type="number" min="0" max="256" value="${d?.port_count ?? meta.defaultPorts}" /></div>
      <div class="field"><label>Feeder-in ports</label>
        <input id="d-inputs" type="number" min="0" max="8" value="${d?.input_count ?? meta.defaultIn}" /></div>
    </div>
    <p class="hint">A 1:8 NAP is 1 feeder in + 8 out. Use 2 feeder-ins for a loop-through
      closure fed from both directions.</p>
    <div class="field-row">
      <div class="field"><label>Split ratio</label>
        <input id="d-ratio" value="${esc(d?.splitter_ratio || '')}" placeholder="1:8, 1:16…" /></div>
      <div class="field"><label>Label ports by</label>
        <select id="d-labeling">
          <option value="number" ${(d?.port_labeling || 'number') === 'number' ? 'selected' : ''}>Port number</option>
          <option value="color"  ${d?.port_labeling === 'color' ? 'selected' : ''}>Pigtail colour</option>
          <option value="both"   ${d?.port_labeling === 'both' ? 'selected' : ''}>Number + colour</option>
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Model</label><input id="d-model" value="${esc(d?.model || '')}" placeholder="e.g. Huawei MA5608T" /></div>
      <div class="field"><label>Area / barangay</label><input id="d-area" value="${esc(d?.area || '')}" placeholder="e.g. Tunghaan" /></div>
    </div>
    <div class="field"><label>Address / landmark</label>
      <input id="d-address" value="${esc(d?.address || '')}" placeholder="Pole number, house reference…" /></div>
    <div class="field"><label>Notes</label><textarea id="d-notes">${esc(d?.notes || '')}</textarea></div>
  `;
}

function readDeviceForm() {
  return {
    name: $('#d-name').value,
    type: $('#d-type').value,
    status: $('#d-status').value,
    port_count: $('#d-ports').value,
    input_count: $('#d-inputs').value,
    port_labeling: $('#d-labeling').value,
    splitter_ratio: $('#d-ratio').value,
    model: $('#d-model').value,
    area: $('#d-area').value,
    address: $('#d-address').value,
    notes: $('#d-notes').value,
  };
}

function openNewDeviceModal(type, latlng) {
  openModal({
    title: `New ${TYPE_META[type].label}`,
    body: `<p class="hint">Dropping at ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)} — you can drag the pin later.</p>
           ${deviceFormHtml(null, type)}`,
    confirm: 'Place device',
    afterOpen: () => {
      // Switching type in the form should move the port defaults with it.
      $('#d-type').addEventListener('change', (e) => {
        const m = TYPE_META[e.target.value];
        if (!m) return;
        $('#d-ports').value = m.defaultPorts;
        $('#d-inputs').value = m.defaultIn;
      });
    },
    onConfirm: async () => {
      const body = { ...readDeviceForm(), lat: latlng.lat, lng: latlng.lng };
      if (!body.name.trim()) throw new Error('Give the device a name');
      const res = await api('/devices', { method: 'POST', body });
      setMode(null);
      await refresh({ keepSelection: false });
      openDevice(res.device.id, { silent: true });
      toast(`${TYPE_META[body.type].label} placed`, 'ok');
    },
  });
}

function openEditDeviceModal(d) {
  openModal({
    title: `Edit ${d.name}`,
    body: deviceFormHtml(d),
    onConfirm: async () => {
      const body = readDeviceForm();
      if (!body.name.trim()) throw new Error('Give the device a name');
      await api(`/devices/${d.id}`, { method: 'PATCH', body });
      await refresh();
      toast('Saved', 'ok');
    },
  });
}

function openEditPortModal(p) {
  const colorOptions = ['<option value="">— none —</option>']
    .concat(
      FIBER_COLORS.map(
        (c) => `<option value="${c.name}" ${
          (p.fiber_color || '').toLowerCase() === c.name.toLowerCase() ? 'selected' : ''
        }>${c.name}</option>`
      )
    )
    .join('');

  openModal({
    title: p.port_kind === 'in' ? `Feeder in ${p.port_no}` : `Port ${p.port_no}`,
    body: `
      <div class="field"><label>Label</label>
        <input id="p-label" value="${esc(p.label || '')}" placeholder="e.g. feeds NAP-03 / Purok 2" /></div>
      <div class="field-row">
        <div class="field"><label>Pigtail colour</label>
          <select id="p-color">${colorOptions}</select></div>
        <div class="field"><label>Status</label>
          <select id="p-status">
            ${['free', 'used', 'reserved', 'faulty'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="p-notes">${esc(p.notes || '')}</textarea></div>`,
    onConfirm: async () => {
      await api(`/ports/${p.id}`, {
        method: 'PATCH',
        body: {
          label: $('#p-label').value,
          status: $('#p-status').value,
          notes: $('#p-notes').value,
          fiber_color: $('#p-color').value,
        },
      });
      await refresh({ keepSelection: false });
      openPort(p.id);
      toast('Port updated', 'ok');
    },
  });
}

function openEditLinkModal(l) {
  openModal({
    title: 'Edit fiber link',
    body: `
      <div class="field-row">
        <div class="field"><label>Cable length (m)</label><input id="f-len" type="number" min="0" value="${esc(l.cable_length_m ?? '')}" /></div>
        <div class="field"><label>Fiber core</label><input id="f-core" value="${esc(l.fiber_core || '')}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Cable type</label><input id="f-type" value="${esc(l.cable_type || '')}" /></div>
        <div class="field"><label>Status</label>
          <select id="f-status">
            ${['active', 'planned', 'cut'].map((s) => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label>Notes</label><textarea id="f-notes">${esc(l.notes || '')}</textarea></div>`,
    onConfirm: async () => {
      await api(`/links/${l.id}`, {
        method: 'PATCH',
        body: {
          cable_length_m: $('#f-len').value,
          fiber_core: $('#f-core').value,
          cable_type: $('#f-type').value,
          status: $('#f-status').value,
          notes: $('#f-notes').value,
        },
      });
      await refresh();
      toast('Link updated', 'ok');
    },
  });
}

function openSubscriberModal(sub, portId) {
  const port = state.byPort.get(portId || sub?.port_id);
  const dev = port ? state.byDevice.get(port.device_id) : null;
  openModal({
    title: sub ? `Edit ${sub.name}` : 'New subscriber',
    body: `
      ${dev ? `<p class="hint">On ${esc(dev.name)} ${esc(portName(port))}</p>` : ''}
      <div class="field"><label>Name</label><input id="s-name" value="${esc(sub?.name || '')}" placeholder="Household / account name" /></div>
      <div class="field-row">
        <div class="field"><label>Plan</label><input id="s-plan" value="${esc(sub?.plan || '')}" placeholder="e.g. 25 Mbps" /></div>
        <div class="field"><label>Status</label>
          <select id="s-status">
            ${['active', 'pending', 'suspended', 'disconnected'].map((s) => `<option ${sub?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>PPPoE username</label><input id="s-pppoe" value="${esc(sub?.pppoe_username || '')}" /></div>
        <div class="field"><label>ONU serial</label><input id="s-onu" value="${esc(sub?.onu_serial || '')}" /></div>
      </div>
      <div class="field"><label>Address</label><input id="s-address" value="${esc(sub?.address || '')}" /></div>
      <div class="field-row">
        <div class="field"><label>Phone</label><input id="s-phone" value="${esc(sub?.phone || '')}" /></div>
        <div class="field"><label>Drop cable (m)</label><input id="s-drop" type="number" min="0" value="${esc(sub?.drop_length_m ?? '')}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Latitude</label><input id="s-lat" value="${esc(sub?.lat ?? '')}" placeholder="optional" /></div>
        <div class="field"><label>Longitude</label><input id="s-lng" value="${esc(sub?.lng ?? '')}" placeholder="optional" /></div>
      </div>
      <div class="field"><label>Installed on</label><input id="s-installed" type="date" value="${esc(sub?.installed_on ? String(sub.installed_on).slice(0, 10) : '')}" /></div>
      <div class="field"><label>Notes</label><textarea id="s-notes">${esc(sub?.notes || '')}</textarea></div>
      ${!sub && dev ? '<p class="hint">Leave lat/lng blank and the house pin sits on the NAP until you drag it.</p>' : ''}
    `,
    confirm: sub ? 'Save' : 'Add subscriber',
    onConfirm: async () => {
      const name = $('#s-name').value.trim();
      if (!name) throw new Error('Subscriber name is required');
      let lat = $('#s-lat').value;
      let lng = $('#s-lng').value;
      if ((!lat || !lng) && dev) {
        // drop the pin a few metres off the NAP so it is visible and draggable
        lat = dev.lat + 0.00018;
        lng = dev.lng + 0.00018;
      }
      const body = {
        name,
        plan: $('#s-plan').value,
        status: $('#s-status').value,
        pppoe_username: $('#s-pppoe').value,
        onu_serial: $('#s-onu').value,
        address: $('#s-address').value,
        phone: $('#s-phone').value,
        drop_length_m: $('#s-drop').value,
        lat, lng,
        installed_on: $('#s-installed').value,
        notes: $('#s-notes').value,
      };
      if (sub) {
        await api(`/subscribers/${sub.id}`, { method: 'PATCH', body });
      } else {
        body.port_id = portId;
        await api('/subscribers', { method: 'POST', body });
      }
      await refresh({ keepSelection: false });
      if (portId) openPort(portId); else if (sub) openSubscriber(sub.id);
      toast(sub ? 'Subscriber saved' : 'Subscriber added', 'ok');
    },
  });
}

async function deleteDevice(d) {
  const cap = state.net.capacity[d.id] || {};
  const warn = cap.subscribers
    ? `\n\n${cap.subscribers} subscriber(s) are on this device — they will be unassigned.`
    : '';
  if (!confirm(`Delete "${d.name}"? All its ports and fiber links go with it.${warn}`)) return;
  await api(`/devices/${d.id}`, { method: 'DELETE' });
  closeDrawer();
  await refresh({ keepSelection: false });
  toast('Device deleted', 'ok');
}

async function deleteLink(linkId) {
  if (!confirm('Remove this fiber link? Both ports become free.')) return;
  await api(`/links/${linkId}`, { method: 'DELETE' });
  closeDrawer();
  await refresh({ keepSelection: false });
  toast('Link removed', 'ok');
}

/* -------------------------------- search -------------------------------- */

function runSearch(q) {
  const box = $('#search-results');
  const term = q.trim().toLowerCase();
  if (term.length < 2) { box.hidden = true; return; }

  const hits = [];
  for (const d of state.net.devices) {
    if (
      d.name.toLowerCase().includes(term) ||
      (d.area || '').toLowerCase().includes(term) ||
      (d.model || '').toLowerCase().includes(term) ||
      (d.address || '').toLowerCase().includes(term)
    ) hits.push({ kind: 'device', id: d.id, label: d.name, sub: TYPE_META[d.type]?.label || d.type });
  }
  for (const s of state.net.subscribers) {
    if (
      s.name.toLowerCase().includes(term) ||
      (s.pppoe_username || '').toLowerCase().includes(term) ||
      (s.address || '').toLowerCase().includes(term) ||
      (s.onu_serial || '').toLowerCase().includes(term)
    ) hits.push({ kind: 'subscriber', id: s.id, label: s.name, sub: s.pppoe_username || 'subscriber' });
  }
  for (const p of state.net.ports) {
    if (p.label && p.label.toLowerCase().includes(term)) {
      const d = state.byDevice.get(p.device_id);
      hits.push({ kind: 'port', id: p.id, label: `${d?.name || ''} · port ${p.port_no}`, sub: p.label });
    }
  }

  if (!hits.length) {
    box.innerHTML = '<div class="result muted">No matches</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = hits.slice(0, 30).map((h) =>
    `<div class="result" data-kind="${h.kind}" data-id="${h.id}">
       <span>${esc(h.label)}</span><span class="sub">${esc(h.sub)}</span></div>`
  ).join('');
  box.hidden = false;
  box.querySelectorAll('.result[data-id]').forEach((el) =>
    el.addEventListener('click', () => {
      box.hidden = true;
      $('#search').value = '';
      if (el.dataset.kind === 'device') openDevice(el.dataset.id);
      else if (el.dataset.kind === 'subscriber') openSubscriber(el.dataset.id);
      else openPort(el.dataset.id);
    })
  );
}

/* --------------------------------- auth --------------------------------- */

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}

async function boot() {
  const s = await fetch('/api/session').then((r) => r.json());
  if (!s.authed) { showLogin(); return; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  initMap();
  await refresh({ keepSelection: false });
  fitToNetwork();
  setTimeout(() => map.invalidateSize(), 100);
}

/* ------------------------------- wiring --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    if (!res.ok) { $('#login-error').textContent = 'Wrong password'; return; }
    location.reload();
  });

  document.querySelectorAll('.place-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const type = b.dataset.place;
      if (state.mode?.kind === 'place' && state.mode.type === type) return setMode(null);
      setMode({ kind: 'place', type }, `Click the map to place a ${TYPE_META[type].label}`);
    })
  );

  $('#mode-cancel').addEventListener('click', () => setMode(null));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#modal-close').addEventListener('click', closeModal);

  $('#toggle-capacity').addEventListener('change', (e) => { state.showCapacity = e.target.checked; renderMap(); });
  $('#toggle-subs').addEventListener('change', (e) => { state.showSubs = e.target.checked; renderMap(); });
  $('#toggle-labels').addEventListener('change', (e) => { state.showLabels = e.target.checked; renderMap(); });
  $('#toggle-unreached').addEventListener('change', (e) => { state.showIsolated = e.target.checked; renderMap(); });

  $('#search').addEventListener('input', (e) => runSearch(e.target.value));
  $('#search').addEventListener('blur', () => setTimeout(() => { $('#search-results').hidden = true; }, 180));

  $('#btn-fit').addEventListener('click', fitToNetwork);
  $('#btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });
  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    location.reload();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-backdrop').hidden) return closeModal();
      if (state.mode) return setMode(null);
      if (!$('#drawer').hidden) return closeDrawer();
    }
  });

  boot().catch((e) => { console.error(e); showLogin(); });
});
