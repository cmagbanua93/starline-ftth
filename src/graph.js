/**
 * Network graph helpers.
 *
 * The plant is modelled at PORT level, not device level, because a joint
 * closure is a splice point rather than a box that everything flows through.
 *
 * Inside a device:
 *   - JOINT (closure): core n is a fusion splice. Its `in` side and its `out`
 *     side of the SAME number are joined, and nothing else. White in, white out.
 *     Two unrelated cables passing through one closure stay independent.
 *   - NAP / SPLITTER: one box. Every feeder-in feeds every output port.
 *   - OLT: PON ports are independent sources; nothing is joined internally.
 *
 * Between devices: a link joins exactly one port to exactly one other port.
 *
 * Feed direction is never stored. Anything reachable from a live OLT PON port
 * through live splices and links is downstream of it.
 */

function indexPorts(devices, ports) {
  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const portById = new Map(ports.map((p) => [p.id, p]));
  const portsOf = new Map();
  for (const p of ports) {
    if (!portsOf.has(p.device_id)) portsOf.set(p.device_id, []);
    portsOf.get(p.device_id).push(p);
  }
  return { deviceById, portById, portsOf };
}

/**
 * Ports joined to each other inside a single device.
 * Returns Map<portId, Array<portId>>.
 */
function internalEdges(devices, ports) {
  const { portsOf } = indexPorts(devices, ports);
  const adj = new Map();
  const join = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  };

  for (const device of devices) {
    const own = portsOf.get(device.id) || [];
    if (device.type === 'OLT') continue; // PON ports are independent sources

    if (device.type === 'JOINT') {
      // A closure joins core n to core n — one fusion splice, nothing else.
      const ins = new Map(own.filter((p) => p.port_kind === 'in').map((p) => [p.port_no, p]));
      for (const out of own) {
        if (out.port_kind !== 'out') continue;
        const mate = ins.get(out.port_no);
        if (mate) join(mate.id, out.id);
      }
      continue;
    }

    // A NAP or splitter is one enclosure: the feeder reaches every output.
    const ins = own.filter((p) => p.port_kind === 'in');
    const outs = own.filter((p) => p.port_kind === 'out');
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) join(ins[i].id, ins[j].id);
      for (const out of outs) join(ins[i].id, out.id);
    }
  }
  return adj;
}

/**
 * Full port-level adjacency: internal splices plus the fiber links between
 * devices. Link edges carry the link id so callers can name the hop.
 */
function buildPortGraph(devices, ports, links, opts = {}) {
  const ignoreLinkIds = opts.ignoreLinkIds || new Set();
  const ignoreDeviceIds = opts.ignoreDeviceIds || new Set();
  const { portById } = indexPorts(devices, ports);

  const adj = new Map();
  const add = (a, edge) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(edge);
  };

  const alive = (portId) => {
    const p = portById.get(portId);
    return p && !ignoreDeviceIds.has(p.device_id);
  };

  for (const [portId, mates] of internalEdges(devices, ports)) {
    if (!alive(portId)) continue;
    for (const mate of mates) {
      if (!alive(mate)) continue;
      add(portId, { portId: mate, linkId: null });
    }
  }

  for (const l of links) {
    if (ignoreLinkIds.has(l.id)) continue;
    if (l.status === 'cut') continue;
    if (!alive(l.from_port_id) || !alive(l.to_port_id)) continue;
    add(l.from_port_id, { portId: l.to_port_id, linkId: l.id });
    add(l.to_port_id, { portId: l.from_port_id, linkId: l.id });
  }
  return adj;
}

/** OLT PON ports are where signal originates. */
function sourcePorts(devices, ports, ignoreDeviceIds = new Set()) {
  const live = new Set(
    devices
      .filter((d) => d.type === 'OLT' && d.status !== 'offline' && d.status !== 'planned')
      .filter((d) => !ignoreDeviceIds.has(d.id))
      .map((d) => d.id)
  );
  return ports.filter((p) => live.has(p.device_id)).map((p) => p.id);
}

/** Every port reachable from a live OLT, given a set of failed elements. */
function reachablePorts(devices, ports, links, opts = {}) {
  const ignoreDeviceIds = opts.ignoreDeviceIds || new Set();
  const adj = buildPortGraph(devices, ports, links, opts);
  const seen = new Set();
  const queue = sourcePorts(devices, ports, ignoreDeviceIds);
  for (const id of queue) seen.add(id);

  while (queue.length) {
    const cur = queue.shift();
    for (const edge of adj.get(cur) || []) {
      if (seen.has(edge.portId)) continue;
      seen.add(edge.portId);
      queue.push(edge.portId);
    }
  }
  return seen;
}

/** A device counts as reached if any of its ports is. */
function reachableFromOlts(devices, ports, links, opts = {}) {
  const reached = reachablePorts(devices, ports, links, opts);
  const { portById } = indexPorts(devices, ports);
  const devs = new Set();
  for (const portId of reached) {
    const p = portById.get(portId);
    if (p) devs.add(p.device_id);
  }
  return devs;
}

/**
 * Shortest path from a device back to an OLT, as device hops.
 * Returns { hops: [{deviceId, linkId, viaPortId, peerPortId}], oltId } or null.
 */
function pathToOlt(deviceId, devices, ports, links, opts = {}) {
  const { deviceById, portById, portsOf } = indexPorts(devices, ports);
  const start = deviceById.get(deviceId);
  if (!start) return null;
  if (start.type === 'OLT') return { hops: [], oltId: deviceId };

  const adj = buildPortGraph(devices, ports, links, opts);
  const oltIds = new Set(devices.filter((d) => d.type === 'OLT').map((d) => d.id));

  const prev = new Map();
  const seen = new Set();
  const queue = [];
  for (const p of portsOf.get(deviceId) || []) { seen.add(p.id); queue.push(p.id); }

  while (queue.length) {
    const cur = queue.shift();
    const curPort = portById.get(cur);
    if (curPort && oltIds.has(curPort.device_id)) {
      // Walk back, recording a hop each time the path crossed a fiber link.
      const hops = [];
      let node = cur;
      while (prev.has(node)) {
        const step = prev.get(node);
        if (step.linkId) {
          hops.unshift({
            deviceId: portById.get(node).device_id,
            linkId: step.linkId,
            viaPortId: step.from,
            peerPortId: node,
          });
        }
        node = step.from;
      }
      return { hops, oltId: curPort.device_id };
    }
    for (const edge of adj.get(cur) || []) {
      if (seen.has(edge.portId)) continue;
      seen.add(edge.portId);
      prev.set(edge.portId, { from: cur, linkId: edge.linkId });
      queue.push(edge.portId);
    }
  }
  return null;
}

/**
 * Impact analysis. Remove a link or a device and report which devices and
 * subscribers lose their path back to an OLT.
 */
function impactOf({ linkId, deviceId }, devices, ports, links, subscribers) {
  const beforePorts = reachablePorts(devices, ports, links);
  const opts = {
    ignoreLinkIds: linkId ? new Set([linkId]) : new Set(),
    ignoreDeviceIds: deviceId ? new Set([deviceId]) : new Set(),
  };
  const afterPorts = reachablePorts(devices, ports, links, opts);

  const { portById } = indexPorts(devices, ports);
  const devicesBefore = new Set();
  const devicesAfter = new Set();
  for (const id of beforePorts) devicesBefore.add(portById.get(id)?.device_id);
  for (const id of afterPorts) devicesAfter.add(portById.get(id)?.device_id);

  const lostDeviceIds = new Set();
  for (const id of devicesBefore) if (id && !devicesAfter.has(id)) lostDeviceIds.add(id);
  if (deviceId) lostDeviceIds.add(deviceId);

  // A subscriber is affected when the port feeding them stops being reachable.
  const affected = subscribers.filter(
    (s) => s.port_id && beforePorts.has(s.port_id) && !afterPorts.has(s.port_id)
  );
  // Plus anyone hanging off a device that is being removed outright.
  if (deviceId) {
    for (const s of subscribers) {
      if (!s.port_id || affected.includes(s)) continue;
      if (portById.get(s.port_id)?.device_id === deviceId) affected.push(s);
    }
  }

  return {
    lostDeviceIds: [...lostDeviceIds],
    affectedSubscribers: affected,
    affectedCount: affected.length,
  };
}

/**
 * Per-device capacity: total / used / free output ports, and how many
 * subscribers sit on this device.
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
    const c = byDevice.get(portToDevice.get(s.port_id));
    if (c) c.subscribers += 1;
  }
  return Object.fromEntries(byDevice);
}

module.exports = {
  internalEdges,
  buildPortGraph,
  reachablePorts,
  reachableFromOlts,
  pathToOlt,
  impactOf,
  capacityByDevice,
};
