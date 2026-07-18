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
  // Three-anchor bidding. The existing claim_value / resp_value keep their meaning
  // (claimant's floor = least they'll accept; respondent's ceiling = most they'll pay)
  // and now act as the "walk-away" anchor. These two add the softer anchors per side:
  //   *_ideal = the best realistic outcome for that party
  //   *_fair  = the figure they would genuinely consider (their middle / target)
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_ideal INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_fair  INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_ideal  INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_fair   INTEGER;`);
  // Monetisation: case activation fee, settlement success fee, human-mediator escalation.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS start_fee_paid    BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS success_fee_paid  BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS success_fee_amount INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS mediator_requested BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS mediator_party    TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'GBP';`);

  // Party details, captured after settlement so the agreement can name the parties properly.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_full_name TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_company TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_address TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_full_name TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_company  TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_address  TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS agreement_sent BOOLEAN NOT NULL DEFAULT false;`);

  // Supporting documents attached to a case. Stored in the database because
  // Render's filesystem is wiped on every deploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS case_documents (
      id          SERIAL PRIMARY KEY,
      case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      filename    TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      data        BYTEA NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS case_documents_case_idx ON case_documents(case_id);`);

  // ---- Fee model v2 -------------------------------------------------------
  // Money below is stored in MINOR units (pence/cents), because a 50/50 split of
  // an odd amount is not a whole pound. Everything else in this app is in major
  // units; do not mix them.
  //
  //   success_fee_gross_minor  the published success fee, before any credit
  //   activation_credit_minor  the activation fee already paid by the creator
  //   fee_due_minor            gross - credit. What is outstanding at settlement.
  //   claim/resp_fee_paid_minor  what each side has actually paid toward it
  //   *_fee_choice             'split' | 'full' | null
  //
  // Release rule: the agreement unlocks when
  //   claim_fee_paid_minor + resp_fee_paid_minor >= fee_due_minor
  // regardless of who paid it. That is ICC Art. 37-style substitution.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS success_fee_gross_minor INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS activation_credit_minor INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS fee_due_minor INTEGER;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_fee_paid_minor INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_fee_paid_minor  INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_fee_choice TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_fee_choice  TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS agreement_released_at TIMESTAMPTZ;`);

  // Saved cards. Captured with setup_future_usage on the activation Checkout for
  // the creator, and on-session at the moment the other party first chooses to pay.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_customer_id TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_pm_id TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_customer_id TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_pm_id TEXT;`);

  // Evidence that the payment mandate was shown and accepted. This is the
  // chargeback defence and the Consumer Rights Act transparency record.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS mandate_version TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS claim_mandate_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS resp_mandate_at  TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS settle_reason TEXT;`);   // 'overlap' | 'band'
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
  async createCase(title, amount, token, claimantId, respondentId, otherEmail, currency) {
    const r = await pool.query(
      `INSERT INTO cases (title, amount, invite_token, claimant_id, respondent_id, other_email, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [title, amount, token, claimantId, respondentId, otherEmail, currency || 'GBP']);
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
  // Save all three claimant anchors at once. floor -> claim_value (the binding walk-away).
  async setClaimAnchors(ideal, fair, floor, id) {
    await pool.query('UPDATE cases SET claim_ideal=$1, claim_fair=$2, claim_value=$3 WHERE id=$4', [ideal, fair, floor, id]);
  },
  // Save all three respondent anchors at once. ceil -> resp_value (the binding walk-away).
  async setRespAnchors(ideal, fair, ceil, id) {
    await pool.query('UPDATE cases SET resp_ideal=$1, resp_fair=$2, resp_value=$3 WHERE id=$4', [ideal, fair, ceil, id]);
  },
  async settle(status, value, id) { await pool.query('UPDATE cases SET status=$1, settled_value=$2, settled_at=now() WHERE id=$3', [status, value, id]); },
  async setApproval(role, id) {
    const col = role === 'claim' ? 'claim_approved' : 'resp_approved';
    await pool.query('UPDATE cases SET ' + col + '=true WHERE id=$1', [id]);
  },
  async resetApprovals(id) { await pool.query('UPDATE cases SET claim_approved=false, resp_approved=false WHERE id=$1', [id]); },
  async setStatus(status, id) { await pool.query('UPDATE cases SET status=$1 WHERE id=$2', [status, id]); },
  async markStartFeePaid(id) { await pool.query('UPDATE cases SET start_fee_paid=true WHERE id=$1', [id]); },
  async markSuccessFeePaid(id, amount) { await pool.query('UPDATE cases SET success_fee_paid=true, success_fee_amount=$1 WHERE id=$2', [amount, id]); },
  async setMediatorRequested(id, party) { await pool.query('UPDATE cases SET mediator_requested=true, mediator_party=$1 WHERE id=$2', [party, id]); },

  // Party details for the settlement agreement.
  async setPartyDetails(role, d, id) {
    const p = role === 'claim' ? 'claim' : 'resp';
    await pool.query(
      'UPDATE cases SET ' + p + '_full_name=$1, ' + p + '_company=$2, ' + p + '_address=$3 WHERE id=$4',
      [d.fullName, d.company, d.address, id]
    );
  },
  async markAgreementSent(id) { await pool.query('UPDATE cases SET agreement_sent=true WHERE id=$1', [id]); },

  // ---- fee model v2 ----
  async setFeeLedger(id, grossMinor, creditMinor, dueMinor) {
    await pool.query(
      'UPDATE cases SET success_fee_gross_minor=$1, activation_credit_minor=$2, fee_due_minor=$3 WHERE id=$4',
      [grossMinor, creditMinor, dueMinor, id]);
  },
  async setFeeChoice(role, choice, id) {
    const col = role === 'claim' ? 'claim_fee_choice' : 'resp_fee_choice';
    await pool.query('UPDATE cases SET ' + col + '=$1 WHERE id=$2', [choice, id]);
  },
  // Additive, so a party can pay half now and top up the balance later.
  async addFeePayment(role, amountMinor, id) {
    const col = role === 'claim' ? 'claim_fee_paid_minor' : 'resp_fee_paid_minor';
    await pool.query('UPDATE cases SET ' + col + ' = ' + col + ' + $1 WHERE id=$2', [amountMinor, id]);
  },
  async saveCard(role, customerId, pmId, id) {
    const p = role === 'claim' ? 'claim' : 'resp';
    await pool.query(
      'UPDATE cases SET ' + p + '_customer_id=$1, ' + p + '_pm_id=$2 WHERE id=$3',
      [customerId, pmId, id]);
  },
  async recordMandate(role, version, id) {
    const col = role === 'claim' ? 'claim_mandate_at' : 'resp_mandate_at';
    await pool.query(
      'UPDATE cases SET ' + col + '=now(), mandate_version=$1 WHERE id=$2', [version, id]);
  },
  async releaseAgreement(id) {
    await pool.query(
      'UPDATE cases SET agreement_released_at=now(), success_fee_paid=true WHERE id=$1 AND agreement_released_at IS NULL',
      [id]);
  },

  // Supporting documents.
  async addDocument(caseId, uploaderId, filename, mime, size, data) {
    const r = await pool.query(
      'INSERT INTO case_documents (case_id, uploader_id, filename, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [caseId, uploaderId, filename, mime, size, data]
    );
    return r.rows[0].id;
  },
  async documentsForCase(caseId) {
    const r = await pool.query(
      `SELECT d.id, d.filename, d.mime, d.size, d.uploader_id, d.created_at, u.email AS uploader_email
       FROM case_documents d LEFT JOIN users u ON u.id = d.uploader_id
       WHERE d.case_id=$1 ORDER BY d.created_at`, [caseId]);
    return r.rows;
  },
  async documentById(docId, caseId) {
    const r = await pool.query('SELECT * FROM case_documents WHERE id=$1 AND case_id=$2', [docId, caseId]);
    return r.rows[0];
  },

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
