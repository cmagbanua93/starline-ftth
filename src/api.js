const express = require('express');
const { query, withTx, FIBER_COLORS } = require('./db');
const graph = require('./graph');
const backups = require('./backups');

const router = express.Router();

const DEVICE_TYPES = ['OLT', 'NAP', 'SPLITTER', 'JOINT'];
const LABELING = ['number', 'color', 'both'];
const colorFor = (portNo) => FIBER_COLORS[(portNo - 1) % FIBER_COLORS.length];
const DEVICE_STATUS = ['active', 'planned', 'fault', 'offline'];
const PORT_STATUS = ['free', 'used', 'reserved', 'faulty'];
const LINK_STATUS = ['active', 'planned', 'cut'];
const SUB_STATUS = ['active', 'suspended', 'pending', 'disconnected'];

function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

function asNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* ------------------------------------------------------------------ */
/* whole-network snapshot                                              */
/* ------------------------------------------------------------------ */

async function loadNetwork() {
  const [devices, ports, links, subscribers] = await Promise.all([
    query('SELECT * FROM devices ORDER BY type, name').then((r) => r.rows),
    query('SELECT * FROM ports ORDER BY device_id, port_kind, port_no').then((r) => r.rows),
    query('SELECT * FROM links ORDER BY created_at').then((r) => r.rows),
    query('SELECT * FROM subscribers ORDER BY name').then((r) => r.rows),
  ]);
  return { devices, ports, links, subscribers };
}

router.get('/network', async (req, res, next) => {
  try {
    const net = await loadNetwork();
    const capacity = graph.capacityByDevice(net.devices, net.ports, net.links, net.subscribers);
    const reachable = [...graph.reachableFromOlts(net.devices, net.ports, net.links)];
    res.json({ ...net, capacity, reachable });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* devices                                                             */
/* ------------------------------------------------------------------ */

/**
 * Bring a device's ports in line with its configured counts.
 *
 * Devices have two kinds of port: `in` — the feeder coming from upstream — and
 * `out` — the distribution/drop ports. A 1:8 NAP is one `in` and eight `out`.
 * An OLT is all outputs (its PON ports) and has no feeder-in.
 *
 * Output ports are given their TIA-598-C pigtail colour by position, because
 * that is how they are identified in the field.
 */
async function syncPorts(client, deviceId, outCount, inCount, deviceType) {
  const existing = await client.query(
    'SELECT id, port_no, port_kind, status FROM ports WHERE device_id = $1 ORDER BY port_kind, port_no',
    [deviceId]
  );

  const isJoint = deviceType === 'JOINT';
  const wanted = { in: inCount, out: outCount };
  for (const kind of ['in', 'out']) {
    const have = new Set(existing.rows.filter((r) => r.port_kind === kind).map((r) => r.port_no));
    for (let n = 1; n <= wanted[kind]; n++) {
      if (have.has(n)) continue;
      // In a closure both sides of a splice carry the core's colour: white in,
      // white out. Elsewhere only the output ports are colour-coded pigtails.
      const color = isJoint || kind === 'out' ? colorFor(n) : null;
      const label = !isJoint && kind === 'in'
        ? (wanted.in > 1 ? `Feeder in ${n}` : 'Feeder in')
        : null;
      await client.query(
        `INSERT INTO ports (device_id, port_no, port_kind, fiber_color, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [deviceId, n, kind, color, label]
      );
    }

    // Trim extras, but never destroy a port carrying a link or a subscriber.
    const extras = existing.rows.filter((r) => r.port_kind === kind && r.port_no > wanted[kind]);
    for (const p of extras) {
      const linked = await client.query(
        'SELECT 1 FROM links WHERE from_port_id = $1 OR to_port_id = $1 LIMIT 1',
        [p.id]
      );
      const sub = await client.query('SELECT 1 FROM subscribers WHERE port_id = $1 LIMIT 1', [p.id]);
      if (linked.rowCount === 0 && sub.rowCount === 0) {
        await client.query('DELETE FROM ports WHERE id = $1', [p.id]);
      }
    }
  }
}

router.post('/devices', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!DEVICE_TYPES.includes(b.type)) return bad(res, 'invalid device type');
    const lat = asNum(b.lat);
    const lng = asNum(b.lng);
    if (lat === null || lng === null) return bad(res, 'lat/lng required');
    const name = clean(b.name);
    if (!name) return bad(res, 'name required');
    const portCount = Math.max(0, Math.min(256, parseInt(b.port_count, 10) || 8));
    // A closure is a set of splices: every core has an in side and an out side,
    // so its two counts always match.
    const defaultIn = b.type === 'OLT' ? 0 : 1;
    const inputCount = b.type === 'JOINT'
      ? portCount
      : Math.max(0, Math.min(8, b.input_count === undefined ? defaultIn : parseInt(b.input_count, 10) || 0));
    const status = DEVICE_STATUS.includes(b.status) ? b.status : 'active';
    const labeling = LABELING.includes(b.port_labeling) ? b.port_labeling : 'number';

    const device = await withTx(async (client) => {
      const r = await client.query(
        `INSERT INTO devices (type, name, lat, lng, model, status, port_count, input_count,
                              port_labeling, splitter_ratio, area, address, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          b.type, name, lat, lng, clean(b.model), status, portCount, inputCount, labeling,
          clean(b.splitter_ratio), clean(b.area), clean(b.address), clean(b.notes),
        ]
      );
      await syncPorts(client, r.rows[0].id, portCount, inputCount, b.type);
      return r.rows[0];
    });

    const ports = await query(
      'SELECT * FROM ports WHERE device_id = $1 ORDER BY port_kind, port_no',
      [device.id]
    );
    res.status(201).json({ device, ports: ports.rows });
  } catch (e) {
    next(e);
  }
});

router.patch('/devices/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    const set = (col, val) => {
      if (val === undefined) return;
      values.push(val);
      fields.push(`${col} = $${values.length}`);
    };

    if (b.type !== undefined) {
      if (!DEVICE_TYPES.includes(b.type)) return bad(res, 'invalid device type');
      set('type', b.type);
    }
    if (b.status !== undefined) {
      if (!DEVICE_STATUS.includes(b.status)) return bad(res, 'invalid status');
      set('status', b.status);
    }
    if (b.name !== undefined) {
      const n = clean(b.name);
      if (!n) return bad(res, 'name required');
      set('name', n);
    }
    if (b.lat !== undefined) set('lat', asNum(b.lat));
    if (b.lng !== undefined) set('lng', asNum(b.lng));
    for (const col of ['model', 'splitter_ratio', 'area', 'address', 'notes']) {
      if (b[col] !== undefined) set(col, clean(b[col]));
    }

    if (b.port_labeling !== undefined) {
      if (!LABELING.includes(b.port_labeling)) return bad(res, 'invalid port labeling');
      set('port_labeling', b.port_labeling);
    }

    let portCount;
    if (b.port_count !== undefined) {
      portCount = Math.max(0, Math.min(256, parseInt(b.port_count, 10) || 0));
      set('port_count', portCount);
    }
    let inputCount;
    if (b.input_count !== undefined) {
      inputCount = Math.max(0, Math.min(8, parseInt(b.input_count, 10) || 0));
      set('input_count', inputCount);
    }

    // Keep a closure's two sides matched: every core is in + out.
    const existing = await query('SELECT type, port_count, input_count FROM devices WHERE id = $1', [
      req.params.id,
    ]);
    if (!existing.rowCount) return res.status(404).json({ error: 'device not found' });
    const finalType = b.type !== undefined ? b.type : existing.rows[0].type;
    if (finalType === 'JOINT') {
      const cores = portCount !== undefined ? portCount : existing.rows[0].port_count;
      if (inputCount !== cores) { inputCount = cores; set('input_count', cores); }
    }

    if (!fields.length) return bad(res, 'nothing to update');
    set('updated_at', new Date());
    values.push(req.params.id);

    const result = await withTx(async (client) => {
      const r = await client.query(
        `UPDATE devices SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (!r.rowCount) return null;
      if (portCount !== undefined || inputCount !== undefined || b.type !== undefined) {
        await syncPorts(
          client,
          req.params.id,
          portCount !== undefined ? portCount : r.rows[0].port_count,
          inputCount !== undefined ? inputCount : r.rows[0].input_count,
          r.rows[0].type
        );
      }
      return r.rows[0];
    });
    if (!result) return res.status(404).json({ error: 'device not found' });

    const ports = await query(
      'SELECT * FROM ports WHERE device_id = $1 ORDER BY port_kind, port_no',
      [req.params.id]
    );
    res.json({ device: result, ports: ports.rows });
  } catch (e) {
    next(e);
  }
});

router.delete('/devices/:id', async (req, res, next) => {
  try {
    const r = await query('DELETE FROM devices WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'device not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* ports                                                               */
/* ------------------------------------------------------------------ */

router.patch('/ports/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    const set = (col, val) => {
      if (val === undefined) return;
      values.push(val);
      fields.push(`${col} = $${values.length}`);
    };
    if (b.status !== undefined) {
      if (!PORT_STATUS.includes(b.status)) return bad(res, 'invalid port status');
      set('status', b.status);
    }
    if (b.label !== undefined) set('label', clean(b.label));
    if (b.notes !== undefined) set('notes', clean(b.notes));
    if (b.fiber_color !== undefined) set('fiber_color', clean(b.fiber_color));
    if (!fields.length) return bad(res, 'nothing to update');
    values.push(req.params.id);

    const r = await query(
      `UPDATE ports SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ error: 'port not found' });
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* links                                                               */
/* ------------------------------------------------------------------ */

router.post('/links', async (req, res, next) => {
  try {
    const b = req.body || {};
    const fromId = clean(b.from_port_id);
    const toId = clean(b.to_port_id);
    if (!fromId || !toId) return bad(res, 'from_port_id and to_port_id required');
    if (fromId === toId) return bad(res, 'cannot link a port to itself');

    const ports = await query('SELECT * FROM ports WHERE id = ANY($1::uuid[])', [[fromId, toId]]);
    if (ports.rowCount !== 2) return bad(res, 'one or both ports not found');
    const [pa, pb] = ports.rows;
    if (pa.device_id === pb.device_id) return bad(res, 'both ports are on the same device');
    // Feeder-in vs output is a labelling convenience, not a physical law — a
    // splice closure joins cores in whatever direction the plant runs. The UI
    // warns about an unusual pairing; the API does not refuse it.

    const busy = await query(
      `SELECT from_port_id, to_port_id FROM links
       WHERE from_port_id = ANY($1::uuid[]) OR to_port_id = ANY($1::uuid[])`,
      [[fromId, toId]]
    );
    if (busy.rowCount) return bad(res, 'a port is already connected to something else');

    const status = LINK_STATUS.includes(b.status) ? b.status : 'active';
    const link = await withTx(async (client) => {
      const r = await client.query(
        `INSERT INTO links (from_port_id, to_port_id, cable_length_m, fiber_core, cable_type, status, path, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          fromId, toId, asNum(b.cable_length_m), clean(b.fiber_core), clean(b.cable_type),
          status, b.path ? JSON.stringify(b.path) : null, clean(b.notes),
        ]
      );
      await client.query(
        `UPDATE ports SET status = 'used' WHERE id = ANY($1::uuid[]) AND status <> 'faulty'`,
        [[fromId, toId]]
      );
      return r.rows[0];
    });
    res.status(201).json(link);
  } catch (e) {
    next(e);
  }
});

/**
 * Re-point one end of an existing link onto a different port, keeping the
 * link's route, length and notes. Frees the port it was on.
 */
router.post('/links/:id/move', async (req, res, next) => {
  try {
    const { end, port_id: newPortId } = req.body || {};
    if (!['from', 'to'].includes(end)) return bad(res, "end must be 'from' or 'to'");
    if (!clean(newPortId)) return bad(res, 'port_id required');

    const cur = await query('SELECT * FROM links WHERE id = $1', [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'link not found' });
    const link = cur.rows[0];

    const oldPortId = end === 'from' ? link.from_port_id : link.to_port_id;
    const otherPortId = end === 'from' ? link.to_port_id : link.from_port_id;
    if (newPortId === oldPortId) return res.json(link);
    if (newPortId === otherPortId) return bad(res, 'both ends would be the same port');

    const ports = await query('SELECT * FROM ports WHERE id = ANY($1::uuid[])', [
      [newPortId, otherPortId],
    ]);
    if (ports.rowCount !== 2) return bad(res, 'port not found');
    const np = ports.rows.find((p) => p.id === newPortId);
    const op = ports.rows.find((p) => p.id === otherPortId);
    if (np.device_id === op.device_id) return bad(res, 'both ends would be on the same device');

    const busy = await query(
      'SELECT 1 FROM links WHERE (from_port_id = $1 OR to_port_id = $1) AND id <> $2',
      [newPortId, req.params.id]
    );
    if (busy.rowCount) return bad(res, 'that port already has a fiber link');
    const sub = await query('SELECT 1 FROM subscribers WHERE port_id = $1', [newPortId]);
    if (sub.rowCount) return bad(res, 'that port is taken by a subscriber');

    const updated = await withTx(async (client) => {
      const col = end === 'from' ? 'from_port_id' : 'to_port_id';
      const r = await client.query(
        `UPDATE links SET ${col} = $1 WHERE id = $2 RETURNING *`,
        [newPortId, req.params.id]
      );
      await client.query(
        `UPDATE ports SET status = 'used' WHERE id = $1 AND status <> 'faulty'`,
        [newPortId]
      );
      const stillUsed = await client.query('SELECT 1 FROM subscribers WHERE port_id = $1', [oldPortId]);
      if (!stillUsed.rowCount) {
        await client.query(`UPDATE ports SET status = 'free' WHERE id = $1 AND status = 'used'`, [oldPortId]);
      }
      return r.rows[0];
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.patch('/links/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [];
    const values = [];
    const set = (col, val) => {
      if (val === undefined) return;
      values.push(val);
      fields.push(`${col} = $${values.length}`);
    };
    if (b.status !== undefined) {
      if (!LINK_STATUS.includes(b.status)) return bad(res, 'invalid link status');
      set('status', b.status);
    }
    if (b.cable_length_m !== undefined) set('cable_length_m', asNum(b.cable_length_m));
    for (const col of ['fiber_core', 'cable_type', 'notes']) {
      if (b[col] !== undefined) set(col, clean(b[col]));
    }
    if (b.path !== undefined) set('path', b.path ? JSON.stringify(b.path) : null);
    if (!fields.length) return bad(res, 'nothing to update');
    values.push(req.params.id);

    const r = await query(
      `UPDATE links SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ error: 'link not found' });
    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.delete('/links/:id', async (req, res, next) => {
  try {
    const result = await withTx(async (client) => {
      const r = await client.query('DELETE FROM links WHERE id = $1 RETURNING *', [req.params.id]);
      if (!r.rowCount) return null;
      const l = r.rows[0];
      for (const pid of [l.from_port_id, l.to_port_id]) {
        const sub = await client.query('SELECT 1 FROM subscribers WHERE port_id = $1 LIMIT 1', [pid]);
        if (sub.rowCount === 0) {
          await client.query(`UPDATE ports SET status = 'free' WHERE id = $1 AND status = 'used'`, [pid]);
        }
      }
      return l;
    });
    if (!result) return res.status(404).json({ error: 'link not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* subscribers                                                         */
/* ------------------------------------------------------------------ */

const SUB_TEXT_COLS = ['address', 'phone', 'pppoe_username', 'plan', 'onu_serial', 'notes'];

router.post('/subscribers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = clean(b.name);
    if (!name) return bad(res, 'name required');
    const portId = clean(b.port_id);
    const status = SUB_STATUS.includes(b.status) ? b.status : 'active';

    if (portId) {
      const taken = await query('SELECT 1 FROM subscribers WHERE port_id = $1', [portId]);
      if (taken.rowCount) return bad(res, 'that port already has a subscriber');
      const linked = await query(
        'SELECT 1 FROM links WHERE from_port_id = $1 OR to_port_id = $1',
        [portId]
      );
      if (linked.rowCount) return bad(res, 'that port is used by a fiber link');
      const kind = await query('SELECT port_kind FROM ports WHERE id = $1', [portId]);
      if (kind.rows[0]?.port_kind === 'in') {
        return bad(res, 'a subscriber cannot sit on a feeder-in port');
      }
    }

    const sub = await withTx(async (client) => {
      const r = await client.query(
        `INSERT INTO subscribers (port_id, name, address, phone, pppoe_username, plan, onu_serial,
                                  status, lat, lng, drop_length_m, installed_on, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          portId, name, clean(b.address), clean(b.phone), clean(b.pppoe_username), clean(b.plan),
          clean(b.onu_serial), status, asNum(b.lat), asNum(b.lng), asNum(b.drop_length_m),
          clean(b.installed_on), clean(b.notes),
        ]
      );
      if (portId) {
        await client.query(`UPDATE ports SET status = 'used' WHERE id = $1 AND status <> 'faulty'`, [portId]);
      }
      return r.rows[0];
    });
    res.status(201).json(sub);
  } catch (e) {
    next(e);
  }
});

router.patch('/subscribers/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const current = await query('SELECT * FROM subscribers WHERE id = $1', [req.params.id]);
    if (!current.rowCount) return res.status(404).json({ error: 'subscriber not found' });
    const prevPort = current.rows[0].port_id;

    const fields = [];
    const values = [];
    const set = (col, val) => {
      if (val === undefined) return;
      values.push(val);
      fields.push(`${col} = $${values.length}`);
    };

    if (b.name !== undefined) {
      const n = clean(b.name);
      if (!n) return bad(res, 'name required');
      set('name', n);
    }
    if (b.status !== undefined) {
      if (!SUB_STATUS.includes(b.status)) return bad(res, 'invalid subscriber status');
      set('status', b.status);
    }
    for (const col of SUB_TEXT_COLS) if (b[col] !== undefined) set(col, clean(b[col]));
    if (b.lat !== undefined) set('lat', asNum(b.lat));
    if (b.lng !== undefined) set('lng', asNum(b.lng));
    if (b.drop_length_m !== undefined) set('drop_length_m', asNum(b.drop_length_m));
    if (b.installed_on !== undefined) set('installed_on', clean(b.installed_on));

    let newPort;
    if (b.port_id !== undefined) {
      newPort = clean(b.port_id);
      if (newPort && newPort !== prevPort) {
        const taken = await query('SELECT 1 FROM subscribers WHERE port_id = $1', [newPort]);
        if (taken.rowCount) return bad(res, 'that port already has a subscriber');
        const linked = await query(
          'SELECT 1 FROM links WHERE from_port_id = $1 OR to_port_id = $1',
          [newPort]
        );
        if (linked.rowCount) return bad(res, 'that port is used by a fiber link');
      }
      set('port_id', newPort);
    }

    if (!fields.length) return bad(res, 'nothing to update');
    set('updated_at', new Date());
    values.push(req.params.id);

    const sub = await withTx(async (client) => {
      const r = await client.query(
        `UPDATE subscribers SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (newPort !== undefined && prevPort && prevPort !== newPort) {
        await client.query(`UPDATE ports SET status = 'free' WHERE id = $1 AND status = 'used'`, [prevPort]);
      }
      if (newPort) {
        await client.query(`UPDATE ports SET status = 'used' WHERE id = $1 AND status <> 'faulty'`, [newPort]);
      }
      return r.rows[0];
    });
    res.json(sub);
  } catch (e) {
    next(e);
  }
});

router.delete('/subscribers/:id', async (req, res, next) => {
  try {
    const result = await withTx(async (client) => {
      const r = await client.query('DELETE FROM subscribers WHERE id = $1 RETURNING *', [req.params.id]);
      if (!r.rowCount) return null;
      const pid = r.rows[0].port_id;
      if (pid) {
        await client.query(`UPDATE ports SET status = 'free' WHERE id = $1 AND status = 'used'`, [pid]);
      }
      return r.rows[0];
    });
    if (!result) return res.status(404).json({ error: 'subscriber not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* tracing                                                             */
/* ------------------------------------------------------------------ */

router.get('/impact', async (req, res, next) => {
  try {
    const { linkId, deviceId } = req.query;
    if (!linkId && !deviceId) return bad(res, 'linkId or deviceId required');
    const net = await loadNetwork();
    const result = graph.impactOf({ linkId, deviceId }, net.devices, net.ports, net.links, net.subscribers);
    const deviceById = new Map(net.devices.map((d) => [d.id, d]));
    const portById = new Map(net.ports.map((p) => [p.id, p]));
    res.json({
      ...result,
      lostDevices: result.lostDeviceIds.map((id) => deviceById.get(id)).filter(Boolean),
      affectedSubscribers: result.affectedSubscribers.map((s) => {
        const port = portById.get(s.port_id);
        const dev = port ? deviceById.get(port.device_id) : null;
        return { ...s, port_no: port?.port_no ?? null, device_name: dev?.name ?? null };
      }),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/trace/:deviceId', async (req, res, next) => {
  try {
    const net = await loadNetwork();
    const path = graph.pathToOlt(req.params.deviceId, net.devices, net.ports, net.links);
    if (!path) return res.json({ connected: false, hops: [] });
    const deviceById = new Map(net.devices.map((d) => [d.id, d]));
    const portById = new Map(net.ports.map((p) => [p.id, p]));
    res.json({
      connected: true,
      oltId: path.oltId,
      hops: path.hops.map((h) => ({
        ...h,
        device: deviceById.get(h.deviceId),
        viaPort: portById.get(h.viaPortId),
        peerPort: portById.get(h.peerPortId),
      })),
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* import / export                                                     */
/* ------------------------------------------------------------------ */

router.get('/export', async (req, res, next) => {
  try {
    const net = await loadNetwork();
    res.setHeader('Content-Disposition', 'attachment; filename="ftth-network.json"');
    res.json({ exportedAt: new Date().toISOString(), ...net });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* ticketing backups stored here (see src/backups.js)                  */
/* ------------------------------------------------------------------ */

router.get('/backups', async (req, res, next) => {
  try {
    res.json({ backups: await backups.list(req.query.limit) });
  } catch (e) {
    next(e);
  }
});

/* Download one stored copy as the db.json it came from, ready to drop back
   onto the ticketing volume. */
router.get('/backups/:id', async (req, res, next) => {
  try {
    const row = await backups.fetchOne(req.params.id);
    if (!row) return res.status(404).json({ error: 'backup not found' });
    const stamp = new Date(row.taken_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="db-${stamp}.json"`);
    res.send(row.payload);
  } catch (e) {
    next(e);
  }
});

/* Run a backup immediately instead of waiting for the daily timer. */
router.post('/backups/run', async (req, res, next) => {
  try {
    const result = await backups.runOnce();
    if (!result) return res.status(502).json({ error: 'backup failed — see server logs' });
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* installations driven from the ticketing system                      */
/* ------------------------------------------------------------------ */

function metresBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Boxes a technician could drop a new subscriber onto, with every output port
 * and its true state. "Free" means free in fact, not merely flagged free: a port
 * carrying a fiber link or already holding a subscriber is occupied whatever its
 * status column says.
 */
router.get('/nap-candidates', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const lat = asNum(req.query.lat);
    const lng = asNum(req.query.lng);

    const [devices, ports, links, subs] = await Promise.all([
      query(`SELECT id, name, type, area, lat, lng, status, port_labeling
             FROM devices WHERE type IN ('NAP','SPLITTER') ORDER BY name`).then((r) => r.rows),
      query(`SELECT id, device_id, port_no, label, status, fiber_color, reserved_for
             FROM ports WHERE port_kind = 'out' ORDER BY device_id, port_no`).then((r) => r.rows),
      query('SELECT from_port_id, to_port_id FROM links').then((r) => r.rows),
      query('SELECT port_id FROM subscribers WHERE port_id IS NOT NULL').then((r) => r.rows),
    ]);

    const taken = new Set();
    for (const l of links) { taken.add(l.from_port_id); taken.add(l.to_port_id); }
    for (const s of subs) taken.add(s.port_id);

    const byDevice = new Map();
    for (const p of ports) {
      let state = 'free';
      if (taken.has(p.id) || p.status === 'used') state = 'occupied';
      else if (p.status === 'faulty') state = 'faulty';
      else if (p.status === 'reserved') state = 'reserved';
      if (!byDevice.has(p.device_id)) byDevice.set(p.device_id, []);
      byDevice.get(p.device_id).push({
        id: p.id, port_no: p.port_no, label: p.label,
        fiber_color: p.fiber_color, state, reserved_for: p.reserved_for,
      });
    }

    let naps = devices.map((d) => {
      const ps = byDevice.get(d.id) || [];
      const count = (s) => ps.filter((p) => p.state === s).length;
      return {
        id: d.id, name: d.name, type: d.type, area: d.area,
        lat: d.lat, lng: d.lng, status: d.status, port_labeling: d.port_labeling,
        ports: ps,
        counts: { total: ps.length, free: count('free'), reserved: count('reserved'),
                  occupied: count('occupied'), faulty: count('faulty') },
        distance_m: (lat != null && lng != null && d.lat != null && d.lng != null)
          ? Math.round(metresBetween(lat, lng, d.lat, d.lng)) : null,
      };
    });

    if (q) {
      naps = naps.filter((d) =>
        String(d.name || '').toLowerCase().includes(q) ||
        String(d.area || '').toLowerCase().includes(q));
    }
    // Nearest first when we know where the technician is; otherwise the boxes
    // with the most room, so a full NAP never tops the list.
    naps.sort((a, b) => {
      if (a.distance_m != null && b.distance_m != null) return a.distance_m - b.distance_m;
      if (a.counts.free !== b.counts.free) return b.counts.free - a.counts.free;
      return String(a.name).localeCompare(String(b.name));
    });

    res.json({ naps });
  } catch (e) {
    next(e);
  }
});

/* Shared checks: is this port genuinely available to `ticketId`? */
async function portBlocker(client, port, ticketId) {
  if (port.port_kind === 'in') return { code: 400, error: 'a subscriber cannot sit on a feeder-in port' };
  const linked = await client.query('SELECT 1 FROM links WHERE from_port_id = $1 OR to_port_id = $1', [port.id]);
  if (linked.rowCount) return { code: 409, error: 'that port carries a fiber link' };
  const held = await client.query('SELECT 1 FROM subscribers WHERE port_id = $1', [port.id]);
  if (held.rowCount) return { code: 409, error: 'that port already has a subscriber' };
  if (port.status === 'faulty') return { code: 409, error: 'that port is marked faulty' };
  if (port.status === 'used') return { code: 409, error: 'that port is already in use' };
  if (port.status === 'reserved' && port.reserved_for && port.reserved_for !== ticketId) {
    return { code: 409, error: 'that port is already held for another job' };
  }
  return null;
}

/* Hold a port for a job on its way, so two technicians cannot claim it. */
router.post('/ports/:id/reserve', async (req, res, next) => {
  try {
    const ticketId = clean((req.body || {}).ticketId);
    if (!ticketId) return bad(res, 'ticketId required');

    const out = await withTx(async (client) => {
      const r = await client.query('SELECT * FROM ports WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!r.rowCount) return { code: 404, error: 'port not found' };
      const port = r.rows[0];
      const blocked = await portBlocker(client, port, ticketId);
      if (blocked) return blocked;
      const u = await client.query(
        `UPDATE ports SET status = 'reserved', reserved_for = $2, reserved_at = now()
         WHERE id = $1 RETURNING *`, [port.id, ticketId]);
      const d = await client.query('SELECT name, area FROM devices WHERE id = $1', [port.device_id]);
      return { port: u.rows[0], device: d.rows[0] || null };
    });

    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

/* Let a held port go — the job was cancelled, or the technician chose another. */
router.post('/ports/:id/release', async (req, res, next) => {
  try {
    const ticketId = clean((req.body || {}).ticketId);
    const r = await query(
      `UPDATE ports SET status = 'free', reserved_for = NULL, reserved_at = NULL
       WHERE id = $1 AND status = 'reserved'
         AND ($2::text IS NULL OR reserved_for IS NULL OR reserved_for = $2)
       RETURNING *`, [req.params.id, ticketId]);
    if (!r.rowCount) return res.status(409).json({ error: 'that port is not held for this job' });
    res.json({ port: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

/**
 * A completed installation: put the subscriber on the port and mark it used, in
 * one transaction. Idempotent by ticket id, so the ticketing system can retry a
 * failed call for as long as it takes without risking a duplicate.
 */
router.post('/installations', async (req, res, next) => {
  const b = req.body || {};
  const ticketId = clean(b.ticketId);
  const portId = clean(b.portId);
  const s = b.subscriber || {};
  if (!ticketId) return bad(res, 'ticketId required');
  if (!portId) return bad(res, 'portId required');
  if (!clean(s.name)) return bad(res, 'subscriber name required');

  try {
    const out = await withTx(async (client) => {
      const seen = await client.query('SELECT * FROM subscribers WHERE installed_by_ticket = $1', [ticketId]);
      if (seen.rowCount) return { already: true, subscriber: seen.rows[0] };

      const pr = await client.query('SELECT * FROM ports WHERE id = $1 FOR UPDATE', [portId]);
      if (!pr.rowCount) return { code: 404, error: 'port not found' };
      const port = pr.rows[0];
      const blocked = await portBlocker(client, port, ticketId);
      if (blocked) return blocked;

      const ins = await client.query(
        `INSERT INTO subscribers
           (port_id, name, address, phone, pppoe_username, plan, onu_serial, status,
            lat, lng, drop_length_m, installed_on, notes, installed_by_ticket, account_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [portId, clean(s.name), clean(s.address), clean(s.phone), clean(s.pppoe_username),
         clean(s.plan), clean(s.onu_serial), asNum(s.lat), asNum(s.lng), asNum(s.drop_length_m),
         clean(s.installed_on), clean(s.notes), ticketId, clean(s.account_no)]
      );
      await client.query(
        `UPDATE ports SET status = 'used', reserved_for = NULL, reserved_at = NULL WHERE id = $1`,
        [portId]);
      return { subscriber: ins.rows[0] };
    });

    if (out.error) return res.status(out.code).json({ error: out.error });
    res.status(out.already ? 200 : 201).json(out);
  } catch (e) {
    // Losing a race, or a PPPoE username already on the map, should read as a
    // plain conflict rather than a 500.
    if (e && e.code === '23505') {
      const again = await query('SELECT * FROM subscribers WHERE installed_by_ticket = $1', [ticketId]);
      if (again.rowCount) return res.json({ already: true, subscriber: again.rows[0] });
      return res.status(409).json({ error: 'that PPPoE username is already on the map' });
    }
    next(e);
  }
});

module.exports = { router, loadNetwork };
