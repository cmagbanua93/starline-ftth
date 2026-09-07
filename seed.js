/* Seed a small realistic Minglanilla network for testing / demo. */
const BASE = process.env.BASE || 'http://localhost:3000';

async function call(path, method = 'GET', body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const AREAS = [
  { name: 'Poblacion Ward II', lat: 10.2449, lng: 123.7961 },
  { name: 'Tunghaan', lat: 10.2521, lng: 123.7899 },
  { name: 'Tulay', lat: 10.2385, lng: 123.7942 },
  { name: 'Calajo-an', lat: 10.2604, lng: 123.7855 },
];

async function main() {
  console.log('seeding against', BASE);

  const olt = await call('/devices', 'POST', {
    type: 'OLT', name: 'OLT-Poblacion', lat: 10.2449, lng: 123.7961,
    model: 'Huawei MA5608T', port_count: 8, area: 'Poblacion Ward II',
    address: 'StarLine head-end', notes: 'Main head-end, 8 PON ports',
  });
  console.log('OLT', olt.device.id);

  const naps = [];
  for (let i = 0; i < 4; i++) {
    const a = AREAS[i];
    const d = await call('/devices', 'POST', {
      type: 'NAP', name: `NAP-${a.name.split(' ')[0]}-0${i + 1}`,
      lat: a.lat + 0.0011 + (i * 0.0007), lng: a.lng + 0.0013 + (i * 0.0009),
      port_count: 8, input_count: 1, area: a.name, model: 'FTTH 1x8 NAP',
      address: `Pole ${100 + i}`, splitter_ratio: '1:8',
      port_labeling: i % 2 === 0 ? 'color' : 'number',
    });
    naps.push(d);
  }

  const splitter = await call('/devices', 'POST', {
    type: 'SPLITTER', name: 'SPL-Tulay-01', lat: 10.2400, lng: 123.7930,
    port_count: 4, splitter_ratio: '1:4', area: 'Tulay', notes: 'Feeder split',
  });

  const portOf = (dev, n, kind = 'out') =>
    dev.ports.find((p) => p.port_no === n && p.port_kind === kind).id;
  const feedOf = (dev) => portOf(dev, 1, 'in');

  // OLT PON1 -> NAP1 feeder in; NAP1 out 8 -> NAP2 feeder in (daisy chain)
  await call('/links', 'POST', {
    from_port_id: portOf(olt, 1), to_port_id: feedOf(naps[0]),
    cable_length_m: 640, fiber_core: 'Blue 1', cable_type: '12-core ADSS', status: 'active',
  });
  await call('/links', 'POST', {
    from_port_id: portOf(naps[0], 8), to_port_id: feedOf(naps[1]),
    cable_length_m: 410, fiber_core: 'Orange 2', cable_type: '12-core ADSS', status: 'active',
  });
  // OLT PON2 -> splitter feeder in, splitter -> NAP3 and NAP4
  await call('/links', 'POST', {
    from_port_id: portOf(olt, 2), to_port_id: feedOf(splitter),
    cable_length_m: 820, fiber_core: 'Green 1', status: 'active',
  });
  await call('/links', 'POST', {
    from_port_id: portOf(splitter, 1), to_port_id: feedOf(naps[2]),
    cable_length_m: 300, status: 'active',
  });
  await call('/links', 'POST', {
    from_port_id: portOf(splitter, 2), to_port_id: feedOf(naps[3]),
    cable_length_m: 950, status: 'planned',
  });

  // subscribers on NAP1 & NAP2
  const names = ['Dela Cruz Residence', 'Yap Store', 'Abella Household', 'Sanchez Residence',
                 'Lim Sari-sari', 'Ompad Household', 'Rosales Residence'];
  let n = 0;
  for (const nap of [naps[0], naps[1], naps[2]]) {
    for (let port = 1; port <= 3; port++) {
      if (n >= names.length) break;
      const dev = nap.device;
      await call('/subscribers', 'POST', {
        port_id: portOf(nap, port), name: names[n],
        plan: ['15 Mbps', '25 Mbps', '50 Mbps'][n % 3],
        pppoe_username: `starline${1000 + n}`,
        onu_serial: `HWTC${(10000000 + n * 137).toString(16).toUpperCase()}`,
        address: `${dev.area}, purok ${1 + (n % 4)}`,
        status: n === 5 ? 'suspended' : 'active',
        lat: dev.lat + 0.0004 * ((n % 3) - 1),
        lng: dev.lng + 0.0004 * ((n % 2) - 0.5),
        drop_length_m: 40 + n * 12,
      });
      n++;
    }
  }

  const net = await call('/network');
  console.log('devices', net.devices.length, 'ports', net.ports.length,
              'links', net.links.length, 'subs', net.subscribers.length);

  const impact = await call(`/impact?linkId=${net.links[0].id}`);
  console.log('impact of cutting feeder link: devices lost', impact.lostDevices.length,
              'subscribers affected', impact.affectedCount);

  const trace = await call(`/trace/${naps[1].device.id}`);
  console.log('trace NAP2 -> OLT: connected', trace.connected, 'hops', trace.hops.length);
}

main().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
