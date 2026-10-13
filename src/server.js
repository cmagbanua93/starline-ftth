const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const backups = require('./backups');
const { router: api } = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;
/* Other StarLine services (the ticketing system) call this API with a shared
   key instead of a browser session. Unset means no service may call in. */
const API_TOKEN = process.env.API_TOKEN || '';

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* ---------------------------- auth ---------------------------- */
/* Everyone signs in with their own username and password (see auth.js).
   Admins can change the map; technician (viewer) accounts can only look. */
const auth = require('./auth');

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(auth.pub);                       // /api/session, /setup, /login, /logout

/* A service key is accepted alongside the browser session, compared in constant
   time so it cannot be probed byte by byte. */
function serviceKeyOk(req) {
  if (!API_TOKEN) return false;
  const supplied = Buffer.from(String(req.headers['x-api-key'] || ''));
  const expected = Buffer.from(API_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

app.use('/api', auth.gate(serviceKeyOk));
app.use('/api', auth.api);               // /api/me/password, /api/users (admin)

/* Map backgrounds. GOOGLE_MAPS_KEY is a browser key for Google's Map Tiles API —
   restrict it in Google Cloud to this site's address and to the Map Tiles API only.
   Without it the map keeps using OpenStreetMap / Esri. */
app.get('/api/map-config', (req, res) => res.json({ googleMapsKey: process.env.GOOGLE_MAPS_KEY || '' }));

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
      await require('./auth').init();
      ready = true;
    } catch (e) {
      console.error(`[db] init attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (!ready) console.error('[db] starting anyway; API calls will fail until the database is reachable');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`StarLine FTTH Network listening on ${PORT}`);
    if (ready) backups.start();
  });
}

start();
