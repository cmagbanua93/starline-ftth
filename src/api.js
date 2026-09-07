const express = require('express');
const { query, withTx, FIBER_COLORS } = require('./db');
const graph = require('./graph');

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
async function syncPorts(client, deviceId, outCount, inCount) {
  const existing = await client.query(
    'SELECT id, port_no, port_kind, status FROM ports WHERE device_id = $1 ORDER BY port_kind, port_no',
    [deviceId]
  );

  const wanted = { in: inCount, out: outCount };
  for (const kind of ['in', 'out']) {
    const have = new Set(existing.rows.filter((r) => r.port_kind === kind).map((r) => r.port_no));
    for (let n = 1; n <= wanted[kind]; n++) {
      if (have.has(n)) continue;
      await client.query(
        `INSERT INTO ports (device_id, port_no, port_kind, fiber_color, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          deviceId, n, kind,
          kind === 'out' ? colorFor(n) : null,
          kind === 'in' ? (wanted.in > 1 ? `Feeder in ${n}` : 'Feeder in') : null,
        ]
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
    const defaultIn = b.type === 'OLT' ? 0 : 1;
    const inputCount = Math.max(
      0,
      Math.min(8, b.input_count === undefined ? defaultIn : parseInt(b.input_count, 10) || 0)
    );
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
      await syncPorts(client, r.rows[0].id, portCount, inputCount);
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
    if (!fields.length) return bad(res, 'nothing to update');
    set('updated_at', new Date());
    values.push(req.params.id);

    const result = await withTx(async (client) => {
      const r = await client.query(
        `UPDATE devices SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (!r.rowCount) return null;
      if (portCount !== undefined || inputCount !== undefined) {
        await syncPorts(
          client,
          req.params.id,
          portCount !== undefined ? portCount : r.rows[0].port_count,
          inputCount !== undefined ? inputCount : r.rows[0].input_count
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

module.exports = { router, loadNetwork };
