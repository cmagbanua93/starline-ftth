const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { router: api } = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* ---------------------------- auth gate ---------------------------- */

function makeToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('ftth-session-v1').digest('hex');
}

function authed(req) {
  if (!APP_PASSWORD) return true;
  return req.cookies && req.cookies.ftth_session === makeToken();
}

app.post('/login', (req, res) => {
  const supplied = String((req.body && req.body.password) || '');
  if (!APP_PASSWORD) return res.json({ ok: true });
  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('ftth_session', makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  res.clearCookie('ftth_session');
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/session', (req, res) =>
  res.json({ authed: authed(req), passwordRequired: Boolean(APP_PASSWORD) })
);

app.use('/api', (req, res, next) => {
  if (authed(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
});

app.use('/api', api);

/* ---------------------------- static ------------------------------- */

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error('[api]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

async function start() {
  let ready = false;
  for (let attempt = 1; attempt <= 8 && !ready; attempt++) {
    try {
      await db.init();
      ready = true;
    } catch (e) {
      console.error(`[db] init attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!ready) console.error('[db] starting anyway; API calls will fail until the database is reachable');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FTTH Network Manager listening on ${PORT}`);
    if (!APP_PASSWORD) console.log('[auth] APP_PASSWORD not set — the app is open to anyone with the URL');
  });
}

start();
