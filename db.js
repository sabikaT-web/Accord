'use strict';

// Postgres data layer. DATABASE_URL is provided by the host (Render) automatically.
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/midbid';
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

// Create / migrate tables on start-up. Safe to run every time.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      pw_hash    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      amount        INTEGER NOT NULL,
      invite_token  TEXT UNIQUE NOT NULL,
      claimant_id   INTEGER REFERENCES users(id),
      respondent_id INTEGER REFERENCES users(id),
      other_email   TEXT NOT NULL,
      claim_value   INTEGER,
      resp_value    INTEGER,
      status        TEXT NOT NULL DEFAULT 'awaiting_other',
      settled_value INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_events (
      id         SERIAL PRIMARY KEY,
      case_id    INTEGER REFERENCES cases(id),
      kind       TEXT NOT NULL,
      detail     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Migrations for existing databases (safe if already present)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_approved BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_approved BOOLEAN NOT NULL DEFAULT false;`);
}

const one = (r) => r.rows[0] || null;

const db = {
  // ---- users ----
  async createUser(email, name, hash) {
    const r = await pool.query(
      'INSERT INTO users (email, name, pw_hash) VALUES ($1,$2,$3) RETURNING id', [email, name, hash]);
    return r.rows[0].id;
  },
  async userByEmail(email) { return one(await pool.query('SELECT * FROM users WHERE email=$1', [email])); },
  async userById(id) { return one(await pool.query('SELECT * FROM users WHERE id=$1', [id])); },
  async updateLastLogin(id) { await pool.query('UPDATE users SET last_login=now() WHERE id=$1', [id]); },
  async setSuspended(id, val) { await pool.query('UPDATE users SET suspended=$1 WHERE id=$2', [val, id]); },
  async setPassword(id, hash) { await pool.query('UPDATE users SET pw_hash=$1 WHERE id=$2', [hash, id]); },
  async deleteUserCascade(id) {
    await pool.query('DELETE FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE claimant_id=$1 OR respondent_id=$1)', [id]);
    await pool.query('DELETE FROM cases WHERE claimant_id=$1 OR respondent_id=$1', [id]);
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
  },
  async listUsers(search) {
    const s = '%' + (search || '') + '%';
    const r = await pool.query(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.suspended,
             count(c.id) AS case_count
      FROM users u
      LEFT JOIN cases c ON (c.claimant_id = u.id OR c.respondent_id = u.id)
      WHERE ($1='%%' OR u.email ILIKE $1 OR u.name ILIKE $1)
      GROUP BY u.id, u.email, u.name, u.created_at, u.last_login, u.suspended
      ORDER BY u.created_at DESC`, [s]);
    return r.rows;
  },

  // ---- cases ----
  async createCase(title, amount, token, claimantId, respondentId, otherEmail) {
    const r = await pool.query(
      `INSERT INTO cases (title, amount, invite_token, claimant_id, respondent_id, other_email)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [title, amount, token, claimantId, respondentId, otherEmail]);
    return r.rows[0].id;
  },
  async caseById(id) { return one(await pool.query('SELECT * FROM cases WHERE id=$1', [id])); },
  async caseByToken(token) { return one(await pool.query('SELECT * FROM cases WHERE invite_token=$1', [token])); },
  async casesForUser(userId) {
    const r = await pool.query(
      'SELECT * FROM cases WHERE claimant_id=$1 OR respondent_id=$1 ORDER BY created_at DESC', [userId]);
    return r.rows;
  },
  async setClaimant(userId, status, id) { await pool.query('UPDATE cases SET claimant_id=$1, status=$2 WHERE id=$3', [userId, status, id]); },
  async setRespondent(userId, status, id) { await pool.query('UPDATE cases SET respondent_id=$1, status=$2 WHERE id=$3', [userId, status, id]); },
  async setClaimValue(value, id) { await pool.query('UPDATE cases SET claim_value=$1 WHERE id=$2', [value, id]); },
  async setRespValue(value, id) { await pool.query('UPDATE cases SET resp_value=$1 WHERE id=$2', [value, id]); },
  async settle(status, value, id) { await pool.query('UPDATE cases SET status=$1, settled_value=$2, settled_at=now() WHERE id=$3', [status, value, id]); },
  async setApproval(role, id) {
    const col = role === 'claim' ? 'claim_approved' : 'resp_approved';
    await pool.query('UPDATE cases SET ' + col + '=true WHERE id=$1', [id]);
  },
  async resetApprovals(id) { await pool.query('UPDATE cases SET claim_approved=false, resp_approved=false WHERE id=$1', [id]); },
  async setStatus(status, id) { await pool.query('UPDATE cases SET status=$1 WHERE id=$2', [status, id]); },

  async allCases(search) {
    const s = '%' + (search || '') + '%';
    const r = await pool.query(`
      SELECT c.*, uc.email AS claimant_acc_email, ur.email AS respondent_acc_email
      FROM cases c
      LEFT JOIN users uc ON uc.id = c.claimant_id
      LEFT JOIN users ur ON ur.id = c.respondent_id
      WHERE ($1='%%' OR c.title ILIKE $1 OR c.other_email ILIKE $1
             OR uc.email ILIKE $1 OR ur.email ILIKE $1 OR CAST(c.id AS TEXT) ILIKE $1)
      ORDER BY c.created_at DESC`, [s]);
    return r.rows;
  },
  async caseDetail(id) {
    return one(await pool.query(`
      SELECT c.*, uc.email AS claimant_acc_email, uc.name AS claimant_name,
                  ur.email AS respondent_acc_email, ur.name AS respondent_name
      FROM cases c
      LEFT JOIN users uc ON uc.id=c.claimant_id
      LEFT JOIN users ur ON ur.id=c.respondent_id
      WHERE c.id=$1`, [id]));
  },

  // ---- events / timeline ----
  async addEvent(caseId, kind, detail) {
    await pool.query('INSERT INTO case_events (case_id, kind, detail) VALUES ($1,$2,$3)', [caseId, kind, detail || null]);
  },
  async eventsForCase(caseId) {
    const r = await pool.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY created_at ASC, id ASC', [caseId]);
    return r.rows;
  },
  async recentActivity(limit) {
    const r = await pool.query(`
      SELECT e.*, c.title FROM case_events e
      LEFT JOIN cases c ON c.id=e.case_id
      ORDER BY e.created_at DESC, e.id DESC LIMIT $1`, [limit || 12]);
    return r.rows;
  },

  // ---- stats ----
  async counts() {
    const r = await pool.query(`
      SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM cases) AS cases,
        (SELECT count(*) FROM cases WHERE status NOT IN ('settled','closed','declined')) AS waiting,
        (SELECT count(*) FROM cases WHERE status='settled') AS settled`);
    return r.rows[0];
  },
  async avgSettleSeconds() {
    const r = await pool.query(
      `SELECT coalesce(avg(EXTRACT(EPOCH FROM (settled_at - created_at))),0) AS s
       FROM cases WHERE settled_at IS NOT NULL`);
    return Number(r.rows[0].s) || 0;
  },
  async perDay(table, days) {
    const tbl = table === 'cases' ? 'cases' : 'users';
    const r = await pool.query(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS d, count(*)::int AS n
      FROM ${tbl}
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [String(days || 14)]);
    return r.rows;
  }
};

module.exports = { pool, db, init };
