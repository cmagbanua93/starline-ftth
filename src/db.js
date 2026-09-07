const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  'postgres://postgres:postgres@localhost:5432/ftth';

// Railway's private network (*.railway.internal) speaks plain TCP and rejects
// SSL outright, so only turn SSL on when the connection string or PGSSLMODE
// actually asks for it.
const wantsSsl =
  /sslmode=require|sslmode=verify/i.test(connectionString) ||
  /^(require|verify-ca|verify-full)$/i.test(process.env.PGSSLMODE || '');
const isInternal = /\.railway\.internal|localhost|127\.0\.0\.1/i.test(connectionString);
const needsSsl = wantsSsl && !isInternal;

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('OLT','NAP','SPLITTER','JOINT')),
  name         text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  model        text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','planned','fault','offline')),
  port_count   integer NOT NULL DEFAULT 8,
  splitter_ratio text,
  area         text,
  address      text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  port_no    integer NOT NULL,
  label      text,
  status     text NOT NULL DEFAULT 'free' CHECK (status IN ('free','used','reserved','faulty')),
  notes      text,
  UNIQUE (device_id, port_no)
);
CREATE INDEX IF NOT EXISTS ports_device_idx ON ports(device_id);

/* --- migrations: feeder-in ports and fiber colour coding --- */

ALTER TABLE devices ADD COLUMN IF NOT EXISTS input_count integer NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS port_labeling text NOT NULL DEFAULT 'number';
ALTER TABLE ports   ADD COLUMN IF NOT EXISTS port_kind text NOT NULL DEFAULT 'out';
ALTER TABLE ports   ADD COLUMN IF NOT EXISTS fiber_color text;

DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_labeling_chk
    CHECK (port_labeling IN ('number','color','both'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ports ADD CONSTRAINT ports_kind_chk CHECK (port_kind IN ('in','out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ports DROP CONSTRAINT IF EXISTS ports_device_id_port_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS ports_device_kind_no_idx
  ON ports(device_id, port_kind, port_no);

CREATE TABLE IF NOT EXISTS links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_port_id  uuid NOT NULL UNIQUE REFERENCES ports(id) ON DELETE CASCADE,
  to_port_id    uuid NOT NULL UNIQUE REFERENCES ports(id) ON DELETE CASCADE,
  cable_length_m numeric,
  fiber_core    text,
  cable_type    text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','planned','cut')),
  path          jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_port_id <> to_port_id)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_id     uuid UNIQUE REFERENCES ports(id) ON DELETE SET NULL,
  name        text NOT NULL,
  address     text,
  phone       text,
  pppoe_username text,
  plan        text,
  onu_serial  text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending','disconnected')),
  lat         double precision,
  lng         double precision,
  drop_length_m numeric,
  installed_on date,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscribers_port_idx ON subscribers(port_id);
`;

/**
 * TIA-598-C fiber colour order. Position n in a NAP/splitter maps to colour n,
 * which is how pigtails are identified in the field.
 */
const FIBER_COLORS = [
  'Blue', 'Orange', 'Green', 'Brown', 'Slate', 'White',
  'Red', 'Black', 'Yellow', 'Violet', 'Rose', 'Aqua',
];

// Idempotent: brings pre-existing rows up to the current model. Each statement
// runs on its own — a parameterised query cannot carry multiple commands.
const BACKFILL = [
  // OLTs are all PON outputs; they have no feeder-in port.
  [`UPDATE devices SET input_count = 0 WHERE type = 'OLT' AND input_count <> 0`],

  // Every passive device needs at least one feeder-in port.
  [`INSERT INTO ports (device_id, port_no, port_kind, label)
    SELECT d.id, 1, 'in', 'Feeder in'
    FROM devices d
    WHERE d.type <> 'OLT'
      AND d.input_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM ports p WHERE p.device_id = d.id AND p.port_kind = 'in'
      )`],

  // Give existing output ports their standard pigtail colour.
  [`UPDATE ports SET fiber_color = c.name
    FROM (SELECT n, name FROM unnest($1::text[]) WITH ORDINALITY AS t(name, n)) c
    WHERE ports.fiber_color IS NULL
      AND ports.port_kind = 'out'
      AND c.n = ((ports.port_no - 1) % 12) + 1`, () => [FIBER_COLORS]],
];

async function init() {
  await pool.query(SCHEMA);
  for (const [sql, params] of BACKFILL) {
    await pool.query(sql, params ? params() : undefined);
  }
  console.log('[db] schema ready');
}

module.exports = { pool, query, withTx, init, FIBER_COLORS };
