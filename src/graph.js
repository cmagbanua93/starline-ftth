/**
 * Network graph helpers.
 *
 * The physical plant is modelled as: devices (OLT / NAP / SPLITTER / JOINT) that
 * own numbered ports, and links that join exactly one port to exactly one other
 * port. Feed direction is derived, not stored: anything reachable from an OLT is
 * downstream of it.
 */

/**
 * Build adjacency between devices from the link list.
 * Returns Map<deviceId, Array<{ deviceId, linkId, viaPortId, peerPortId }>>
 */
function buildAdjacency(ports, links, { ignoreLinkIds = new Set(), ignoreDeviceIds = new Set() } = {}) {
  const portToDevice = new Map();
  for (const p of ports) portToDevice.set(p.id, p.device_id);

  const adj = new Map();
  const add = (a, edge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(edge);
  };

  for (const l of links) {
    if (ignoreLinkIds.has(l.id)) continue;
    if (l.status === 'cut') continue;
    const da = portToDevice.get(l.from_port_id);
    const db = portToDevice.get(l.to_port_id);
    if (!da || !db) continue;
    if (ignoreDeviceIds.has(da) || ignoreDeviceIds.has(db)) continue;
    add(da, { deviceId: db, linkId: l.id, viaPortId: l.from_port_id, peerPortId: l.to_port_id });
    add(db, { deviceId: da, linkId: l.id, viaPortId: l.to_port_id, peerPortId: l.from_port_id });
  }
  return adj;
}

/**
 * Every device reachable from any live OLT, given a set of failed elements.
 */
function reachableFromOlts(devices, ports, links, opts = {}) {
  const ignoreDeviceIds = opts.ignoreDeviceIds || new Set();
  const adj = buildAdjacency(ports, links, { ...opts, ignoreDeviceIds });

  const seen = new Set();
  const queue = [];
  for (const d of devices) {
    if (d.type !== 'OLT') continue;
    if (ignoreDeviceIds.has(d.id)) continue;
    if (d.status === 'offline' || d.status === 'planned') continue;
    seen.add(d.id);
    queue.push(d.id);
  }

  while (queue.length) {
    const cur = queue.shift();
    for (const edge of adj.get(cur) || []) {
      if (seen.has(edge.deviceId)) continue;
      seen.add(edge.deviceId);
      queue.push(edge.deviceId);
    }
  }
  return seen;
}

/**
 * Shortest device path from a given device back to an OLT.
 * Returns { hops: [{deviceId, linkId, viaPortId, peerPortId}], oltId } or null.
 */
function pathToOlt(deviceId, devices, ports, links, opts = {}) {
  const adj = buildAdjacency(ports, links, opts);
  const oltIds = new Set(devices.filter((d) => d.type === 'OLT').map((d) => d.id));
  if (oltIds.has(deviceId)) return { hops: [], oltId: deviceId };

  const prev = new Map();
  const seen = new Set([deviceId]);
  const queue = [deviceId];

  while (queue.length) {
    const cur = queue.shift();
    for (const edge of adj.get(cur) || []) {
      if (seen.has(edge.deviceId)) continue;
      seen.add(edge.deviceId);
      prev.set(edge.deviceId, { from: cur, edge });
      if (oltIds.has(edge.deviceId)) {
        const hops = [];
        let node = edge.deviceId;
        while (prev.has(node)) {
          const step = prev.get(node);
          hops.unshift({
            deviceId: node,
            linkId: step.edge.linkId,
            viaPortId: step.edge.viaPortId,
            peerPortId: step.edge.peerPortId,
          });
          node = step.from;
        }
        return { hops, oltId: edge.deviceId };
      }
      queue.push(edge.deviceId);
    }
  }
  return null;
}

/**
 * Impact analysis. Remove a link or a device from the graph and report which
 * devices and subscribers lose their path back to an OLT.
 */
function impactOf({ linkId, deviceId }, devices, ports, links, subscribers) {
  const before = reachableFromOlts(devices, ports, links);
  const opts = {
    ignoreLinkIds: linkId ? new Set([linkId]) : new Set(),
    ignoreDeviceIds: deviceId ? new Set([deviceId]) : new Set(),
  };
  const after = reachableFromOlts(devices, ports, links, opts);

  const lostDeviceIds = new Set();
  for (const id of before) if (!after.has(id)) lostDeviceIds.add(id);
  if (deviceId) lostDeviceIds.add(deviceId);

  const portToDevice = new Map(ports.map((p) => [p.id, p.device_id]));
  const affected = subscribers.filter(
    (s) => s.port_id && lostDeviceIds.has(portToDevice.get(s.port_id))
  );

  return {
    lostDeviceIds: [...lostDeviceIds],
    affectedSubscribers: affected,
    affectedCount: affected.length,
  };
}

/**
 * Per-device capacity: total / used / free ports, and how many subscribers sit
 * on this device plus everything downstream of it.
 */
function capacityByDevice(devices, ports, links, subscribers) {
  const byDevice = new Map();
  for (const d of devices) {
    byDevice.set(d.id, { total: 0, used: 0, free: 0, reserved: 0, faulty: 0, subscribers: 0 });
  }
  for (const p of ports) {
    const c = byDevice.get(p.device_id);
    if (!c) continue;
    // Feeder-in ports are not sellable capacity, so they stay out of the counts.
    if (p.port_kind === 'in') continue;
    c.total += 1;
    if (p.status === 'used') c.used += 1;
    else if (p.status === 'reserved') c.reserved += 1;
    else if (p.status === 'faulty') c.faulty += 1;
    else c.free += 1;
  }
  const portToDevice = new Map(ports.map((p) => [p.id, p.device_id]));
  for (const s of subscribers) {
    if (!s.port_id) continue;
    const d = portToDevice.get(s.port_id);
    const c = byDevice.get(d);
    if (c) c.subscribers += 1;
  }
  return Object.fromEntries(byDevice);
}

module.exports = { buildAdjacency, reachableFromOlts, pathToOlt, impactOf, capacityByDevice };
