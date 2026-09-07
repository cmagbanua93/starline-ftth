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

async function init() {
  await pool.query(SCHEMA);
  console.log('[db] schema ready');
}

module.exports = { pool, query, withTx, init };
