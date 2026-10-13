/* ---------------------------- user accounts ----------------------------
 * Two roles:
 *   admin   — everything: place / edit / delete equipment, manage accounts, export
 *   viewer  — technicians: can look at the whole map, trace and check impact,
 *             but cannot change anything (every write is refused here, on the
 *             server — hiding buttons in the browser is only a convenience).
 *
 * Passwords are stored as scrypt hashes. A sign-in is a signed cookie that
 * carries the user id, an expiry and the user's token version; changing a
 * password, disabling an account or deleting it bumps the version, which signs
 * that person out everywhere at once.
 *
 * The very first admin is created on the sign-in page ("first-time setup"),
 * which only appears while there are no accounts at all. When APP_PASSWORD is
 * set (the old shared map password), the setup form asks for it, so only
 * someone who already had access can claim the admin account.
 */
const crypto = require('crypto');
const express = require('express');
const { query } = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE = 'ftth_user';
const SESSION_DAYS = 30;
const ROLES = ['admin', 'viewer'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  name          text,
  pass_hash     text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  active        boolean NOT NULL DEFAULT true,
  token_version integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_key ON app_users (lower(username));
`;
async function init() { await query(SCHEMA); }

/* ---- passwords ---- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(got, want);
}
function passwordProblem(pw) {
  if (String(pw || '').length < 8) return 'Password must be at least 8 characters.';
  return null;
}
const cleanUsername = (u) => String(u || '').trim().toLowerCase();
function usernameProblem(u) {
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) return 'Username: 3–32 letters, numbers, dot, dash or underscore (no spaces).';
  return null;
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---- sessions ---- */
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
}
function makeCookie(user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${user.id}.${exp}.${user.token_version}`;
  return `${payload}.${sign(payload)}`;
}
function setSession(res, user) {
  res.cookie(COOKIE, makeCookie(user), {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 864e5,
  });
}
async function userFromRequest(req) {
  const raw = req.cookies && req.cookies[COOKIE];
  if (!raw) return null;
  const parts = String(raw).split('.');
  if (parts.length !== 4) return null;
  const [id, exp, ver, mac] = parts;
  if (!safeEqual(mac, sign(`${id}.${exp}.${ver}`))) return null;
  if (Number(exp) < Date.now()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await query('SELECT id, username, name, role, active, token_version FROM app_users WHERE id = $1', [id]);
  const u = r.rows[0];
  if (!u || !u.active || String(u.token_version) !== ver) return null;
  return u;
}
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name || u.username, role: u.role });

/* ---- sign-in throttle: 10 wrong passwords per address per 15 minutes ---- */
const failures = new Map();
function throttled(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

async function userCount() {
  return Number((await query('SELECT count(*)::int AS n FROM app_users')).rows[0].n);
}
async function activeAdminCount(exceptId) {
  const r = await query(
    `SELECT count(*)::int AS n FROM app_users WHERE role = 'admin' AND active AND id <> COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')`,
    [exceptId || null]);
  return Number(r.rows[0].n);
}

/* ---------------------------- public routes ---------------------------- */
const pub = express.Router();

pub.get('/api/session', async (req, res, next) => {
  try {
    const u = await userFromRequest(req);
    const needsSetup = !u && (await userCount()) === 0;
    res.json({ authed: !!u, user: publicUser(u), needsSetup, setupKeyRequired: needsSetup && !!APP_PASSWORD });
  } catch (e) { next(e); }
});

pub.post('/setup', async (req, res, next) => {
  try {
    const b = req.body || {};
    if ((await userCount()) > 0) return res.status(409).json({ error: 'Setup is already done. Sign in instead.' });
    if (APP_PASSWORD && !safeEqual(String(b.setupKey || ''), APP_PASSWORD)) {
      noteFailure(req.ip);
      return res.status(401).json({ error: 'The current map password is not right.' });
    }
    const username = cleanUsername(b.username);
    const bad = usernameProblem(username) || passwordProblem(b.password);
    if (bad) return res.status(400).json({ error: bad });
    const r = await query(
      `INSERT INTO app_users (username, name, pass_hash, role) VALUES ($1,$2,$3,'admin') RETURNING *`,
      [username, String(b.name || '').trim() || null, hashPassword(b.password)]);
    console.log(`[auth] first admin account created: ${username}`);
    setSession(res, r.rows[0]);
    res.json({ ok: true, user: publicUser(r.rows[0]) });
  } catch (e) { next(e); }
});

pub.post('/login', async (req, res, next) => {
  try {
    if (throttled(req.ip)) return res.status(429).json({ error: 'Too many wrong passwords. Wait 15 minutes and try again.' });
    const b = req.body || {};
    const r = await query('SELECT * FROM app_users WHERE lower(username) = $1', [cleanUsername(b.username)]);
    const u = r.rows[0];
    const ok = u && checkPassword(b.password, u.pass_hash);
    if (!ok) { noteFailure(req.ip); return res.status(401).json({ error: 'Wrong username or password.' }); }
    if (!u.active) return res.status(403).json({ error: 'This account is disabled. Ask the administrator.' });
    failures.delete(req.ip);
    await query('UPDATE app_users SET last_login = now() WHERE id = $1', [u.id]);
    setSession(res, u);
    res.json({ ok: true, user: publicUser(u) });
  } catch (e) { next(e); }
});

pub.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

/* ---------------------------- gate ---------------------------- */
/* Runs on every /api call. A service key (the ticketing system) has full
   access; a signed-in admin has full access; a viewer may only read, and not
   the whole-network export or the backups. */
const VIEWER_BLOCKED_READS = [/^\/export\b/, /^\/backups\b/, /^\/users\b/];
function gate(serviceKeyOk) {
  return async (req, res, next) => {
    try {
      if (serviceKeyOk(req)) { req.service = true; return next(); }
      const u = await userFromRequest(req);
      if (!u) return res.status(401).json({ error: 'Not signed in' });
      req.user = u;
      if (u.role === 'admin') return next();
      if (req.path === '/me/password' && req.method === 'POST') return next();
      if (req.method === 'GET' && !VIEWER_BLOCKED_READS.some((re) => re.test(req.path))) return next();
      return res.status(403).json({ error: 'Your account can view the map only. Ask the administrator to make changes.' });
    } catch (e) { next(e); }
  };
}

/* ---------------------------- account routes (under /api) ---------------------------- */
const api = express.Router();

api.post('/me/password', async (req, res, next) => {
  try {
    if (!req.user) return res.status(400).json({ error: 'Only a signed-in person has a password.' });
    const b = req.body || {};
    const r = await query('SELECT * FROM app_users WHERE id = $1', [req.user.id]);
    if (!checkPassword(b.current, r.rows[0].pass_hash)) return res.status(400).json({ error: 'Your current password is not right.' });
    const bad = passwordProblem(b.password);
    if (bad) return res.status(400).json({ error: bad });
    const up = await query('UPDATE app_users SET pass_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING *',
      [req.user.id, hashPassword(b.password)]);
    setSession(res, up.rows[0]);   // keep this browser signed in; every other one is signed out
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Administrator only.' });
}

api.get('/users', adminOnly, async (req, res, next) => {
  try {
    const r = await query('SELECT id, username, name, role, active, created_at, last_login FROM app_users ORDER BY role, lower(username)');
    res.json({ users: r.rows, me: req.user.id });
  } catch (e) { next(e); }
});

api.post('/users', adminOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const username = cleanUsername(b.username);
    const role = ROLES.includes(b.role) ? b.role : 'viewer';
    const bad = usernameProblem(username) || passwordProblem(b.password);
    if (bad) return res.status(400).json({ error: bad });
    const dup = await query('SELECT 1 FROM app_users WHERE lower(username) = $1', [username]);
    if (dup.rowCount) return res.status(409).json({ error: `The username "${username}" is already taken.` });
    const r = await query(
      'INSERT INTO app_users (username, name, pass_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role, active',
      [username, String(b.name || '').trim() || null, hashPassword(b.password), role]);
    console.log(`[auth] ${req.user.username} created ${role} account ${username}`);
    res.status(201).json({ user: r.rows[0] });
  } catch (e) { next(e); }
});

api.patch('/users/:id', adminOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const r0 = await query('SELECT * FROM app_users WHERE id = $1', [req.params.id]);
    const u = r0.rows[0];
    if (!u) return res.status(404).json({ error: 'Account not found' });
    const role = b.role !== undefined ? (ROLES.includes(b.role) ? b.role : null) : u.role;
    if (!role) return res.status(400).json({ error: 'Role must be admin or viewer.' });
    const active = b.active !== undefined ? !!b.active : u.active;
    /* never lock everyone out */
    if (u.role === 'admin' && (role !== 'admin' || !active) && (await activeAdminCount(u.id)) === 0) {
      return res.status(400).json({ error: 'This is the only administrator. Make another admin first.' });
    }
    let passHash = u.pass_hash, bump = false;
    if (b.password !== undefined && b.password !== '') {
      const bad = passwordProblem(b.password);
      if (bad) return res.status(400).json({ error: bad });
      passHash = hashPassword(b.password); bump = true;
    }
    if (!active && u.active) bump = true;
    if (role !== u.role) bump = true;
    const name = b.name !== undefined ? (String(b.name).trim() || null) : u.name;
    const r = await query(
      `UPDATE app_users SET name = $2, role = $3, active = $4, pass_hash = $5,
         token_version = token_version + $6 WHERE id = $1 RETURNING id, username, name, role, active`,
      [u.id, name, role, active, passHash, bump ? 1 : 0]);
    res.json({ user: r.rows[0] });
  } catch (e) { next(e); }
});

api.delete('/users/:id', adminOnly, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    const r0 = await query('SELECT role, active FROM app_users WHERE id = $1', [req.params.id]);
    if (!r0.rowCount) return res.status(404).json({ error: 'Account not found' });
    if (r0.rows[0].role === 'admin' && (await activeAdminCount(req.params.id)) === 0) {
      return res.status(400).json({ error: 'This is the only administrator.' });
    }
    await query('DELETE FROM app_users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = { init, pub, api, gate, publicUser };
