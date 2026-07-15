'use strict';

// Postgres data layer. The connection string comes from DATABASE_URL,
// which the host (e.g. Render) provides automatically for its managed database.
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgres://localhost:5432/accord';

// Hosted databases require SSL; a local one does not.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

// Create the tables once on start-up if they don't already exist.
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
}

const db = {
  async createUser(email, name, hash) {
    const r = await pool.query(
      'INSERT INTO users (email, name, pw_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, name, hash]
    );
    return r.rows[0].id;
  },
  async userByEmail(email) {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0] || null;
  },
  async userById(id) {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] || null;
  },

  async createCase(title, amount, token, claimantId, respondentId, otherEmail) {
    const r = await pool.query(
      `INSERT INTO cases (title, amount, invite_token, claimant_id, respondent_id, other_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, amount, token, claimantId, respondentId, otherEmail]
    );
    return r.rows[0].id;
  },
  async caseById(id) {
    const r = await pool.query('SELECT * FROM cases WHERE id = $1', [id]);
    return r.rows[0] || null;
  },
  async caseByToken(token) {
    const r = await pool.query('SELECT * FROM cases WHERE invite_token = $1', [token]);
    return r.rows[0] || null;
  },
  async casesForUser(userId) {
    const r = await pool.query(
      'SELECT * FROM cases WHERE claimant_id = $1 OR respondent_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return r.rows;
  },
  async setClaimant(userId, status, id) {
    await pool.query('UPDATE cases SET claimant_id = $1, status = $2 WHERE id = $3', [userId, status, id]);
  },
  async setRespondent(userId, status, id) {
    await pool.query('UPDATE cases SET respondent_id = $1, status = $2 WHERE id = $3', [userId, status, id]);
  },
  async setClaimValue(value, id) {
    await pool.query('UPDATE cases SET claim_value = $1 WHERE id = $2', [value, id]);
  },
  async setRespValue(value, id) {
    await pool.query('UPDATE cases SET resp_value = $1 WHERE id = $2', [value, id]);
  },
  async settle(status, value, id) {
    await pool.query('UPDATE cases SET status = $1, settled_value = $2 WHERE id = $3', [status, value, id]);
  }
};

module.exports = { pool, db, init };
