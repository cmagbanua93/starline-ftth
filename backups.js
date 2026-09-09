/**
 * Off-volume backups of the ticketing system.
 *
 * Field Ops keeps everything in a single db.json on a single Railway volume.
 * This job pulls a copy over the private network on a schedule and stores it in
 * Postgres, which is snapshotted independently — so losing that volume costs at
 * most a day of tickets rather than all of them.
 *
 * Photos are not copied here: they are content-addressed blobs and belong in
 * object storage, not a database column. Their filenames are recorded so a
 * restore can tell exactly which images are missing.
 */
const { query } = require('./db');

const SOURCE_URL = process.env.TICKETING_BACKUP_URL || '';
const SOURCE_TOKEN = process.env.TICKETING_BACKUP_TOKEN || '';
const RETAIN_DAYS = parseInt(process.env.BACKUP_RETAIN_DAYS || '30', 10) || 30;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000; // let the app finish starting first

async function runOnce() {
  if (!SOURCE_URL || !SOURCE_TOKEN) {
    console.log('[backup] skipped — TICKETING_BACKUP_URL / TICKETING_BACKUP_TOKEN not set');
    return null;
  }

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let res;
    try {
      res = await fetch(SOURCE_URL, {
        headers: { 'x-api-key': SOURCE_TOKEN },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error('source returned HTTP ' + res.status);

    const text = await res.text();
    const parsed = JSON.parse(text); // a copy that will not parse is not a backup
    if (!parsed.db || !Array.isArray(parsed.db.tickets)) {
      throw new Error('response did not contain a ticket database');
    }

    const payload = JSON.stringify(parsed.db);
    const counts = parsed.counts || {};

    await query(
      `INSERT INTO ops_backups (source, counts, bytes, payload) VALUES ($1, $2, $3, $4)`,
      ['ticketing', JSON.stringify({ ...counts, photoNames: (parsed.photos || []).length }), payload.length, payload]
    );

    const pruned = await query(
      `DELETE FROM ops_backups WHERE taken_at < now() - ($1 || ' days')::interval RETURNING id`,
      [String(RETAIN_DAYS)]
    );

    console.log(
      `[backup] stored ${payload.length} bytes — tickets=${counts.tickets ?? '?'} ` +
      `users=${counts.users ?? '?'} photos=${counts.photos ?? '?'} ` +
      `(${Date.now() - started}ms, pruned ${pruned.rowCount} old)`
    );
    return { bytes: payload.length, counts };
  } catch (e) {
    // A failed backup must never take the app down with it.
    console.error('[backup] FAILED: ' + e.message);
    return null;
  }
}

function start() {
  if (!SOURCE_URL || !SOURCE_TOKEN) {
    console.log('[backup] disabled — set TICKETING_BACKUP_URL and TICKETING_BACKUP_TOKEN to enable');
    return;
  }
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(`[backup] enabled — every 24h from ${SOURCE_URL}, keeping ${RETAIN_DAYS} days`);
}

async function list(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const r = await query(
    `SELECT id, taken_at, source, counts, bytes FROM ops_backups ORDER BY taken_at DESC LIMIT $1`,
    [n]
  );
  return r.rows;
}

async function fetchOne(id) {
  const r = await query(`SELECT id, taken_at, source, counts, bytes, payload FROM ops_backups WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

module.exports = { start, runOnce, list, fetchOne };
