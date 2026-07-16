'use strict';

// =============================================================================
// MidBid — Business portal
// -----------------------------------------------------------------------------
// Everything for the business side lives here: its own columns, routes and bulk
// actions. Mounted by server.js with two lines; touches nothing in db.js.
//
// It REUSES the existing engine rather than rebuilding it: the same `cases`
// table, the same three anchors (claim_ideal / claim_fair / claim_value), the
// same invite tokens, Stripe fee, mailer and settlement agreement.
//
// ---- The workspace rule (this is the important bit) -------------------------
// Every case is tagged with the workspace that RAISED it (`cases.portal`).
// The tag belongs to the claimant's workspace, not to the case globally:
//
//   Business dashboard  -> cases I raised in the business portal
//   Individual dashboard -> cases I raised as myself
//                           PLUS every case I was invited into
//
// The second half matters: when a business invites someone, that person is an
// individual. Their copy of the case must appear on their individual dashboard
// or the invite link leads nowhere. So we never filter by portal for the
// respondent side.
//
// File parsing (xlsx/csv) happens in the BROWSER via SheetJS and arrives here
// as JSON. That keeps the import to zero new npm dependencies.
// =============================================================================

const crypto = require('node:crypto');
const express = require('express');
const { pool, db } = require('./db');
const mailer = require('./mailer');

const router = express.Router();
// Imports can carry a few hundred rows of JSON; the default 100kb is too small.
router.use(express.json({ limit: '4mb' }));

// Asking for access must sit ABOVE the gate below, or the gate blocks the very
// request it tells people to make. Express matches in order.
router.post('/request', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  if (me.account_type === 'business') return res.redirect('/business');
  const company = (req.body.company || '').trim();
  await db.requestBusiness(me.id, company);

  // Recorded whether or not the email lands. If mail is misconfigured you still see
  // the request in Admin > Users - the database is the record, not your inbox.
  let n = null;
  try {
    const r = await pool.query('SELECT count(*)::int AS n FROM cases WHERE claimant_id=$1', [me.id]);
    n = r.rows[0].n;
  } catch (e) { /* count is a nicety, not a reason to fail the request */ }
  mailer.notifyBusinessRequest(me, company || me.company_name, n).catch(() => {});
  res.redirect('/dashboard');
}));

// The business portal is not self-serve. An individual chasing one debt has no use
// for a 25-row ledger, and the switch was clutter for them; more importantly, this
// stops anyone simply typing /business to get in.
router.use((req, res, next) => {
  const me = res.locals.me;
  if (!me) return next();                                  // requireLogin handles this
  if (me.account_type === 'business') return next();
  if (res.locals.isAdmin) return next();                   // you can always look
  const asked = !!me.business_requested;
  return res.status(403).render('message', {
    title: asked ? 'Your business portal request is with us' : 'The business portal',
    body: (asked ? 'Thanks for asking — we will be in touch to set up a demo and switch it on. ' : '')
      + 'It is built for ledgers of 25 disputes or more: spreadsheet import, one bid bar across '
      + 'the lot, and bulk invites. Because it changes how a whole book of debt gets handled, we '
      + 'switch it on by hand after a demo.',
    html: asked
      ? '<p style="color:#586079;font-size:.92rem">Nothing to do &mdash; your disputes carry on as normal in the meantime.</p>'
      : '<form method="POST" action="/business/request" style="margin:0">'
        + '<button class="btn btn-primary" type="submit">Ask for a demo</button></form>',
  });
;
});

// ---- Stage model -------------------------------------------------------------
//   draft      -> created, not yet invited        ('draft' | 'pending_payment')
//   awaiting   -> invited, other side not joined  ('awaiting_other')
//   progress   -> both joined, still apart        ('active')
//   converging -> both bid and within reach       ('active' + close)
//   settled    -> agreed                          ('settled')
// Off-pipeline: declined, closed.
const STAGES = ['draft', 'awaiting', 'bidding', 'settled'];

// There is deliberately no "converging" stage any more. It appeared exactly when
// the two figures came within 10% of each other — which told the claimant, for
// free and without committing anything, roughly where the respondent was. That is
// the same probing oracle as the live gauge, just wearing a badge. Under sealed
// bidding the only states that can honestly exist are: not invited, invited,
// bidding, settled. Nothing in between is knowable without leaking.
function stageOf(c) {
  if (c.status === 'settled') return 'settled';
  if (c.status === 'declined') return 'declined';
  if (c.status === 'closed') return 'closed';
  if (c.status === 'draft' || c.status === 'pending_payment') return 'draft';
  if (c.status === 'awaiting_other') return 'awaiting';
  return 'bidding';                                                // 'active' — rounds in play
}
const isOpen = (c) => !['settled', 'declined', 'closed'].includes(c.status);
const daysSince = (ts) => Math.floor((Date.now() - new Date(ts)) / 86400000);
const isStalled = (c) => c.status === 'awaiting_other' && daysSince(c.created_at) >= 14;
// Attention can only be driven by things that don't leak: they declined, or they
// have gone quiet. Never by how close the figures are.
const needsAttention = (c) => c.status === 'declined' || isStalled(c);

// The two bids that leave the building. The three anchors stay private; only the
// live position of each side is ever exported or shown in a list.
//   highest = what the claimant is holding out for  (claim_value)
//   lowest  = what the respondent has put up        (resp_value)
// Your own committed figure — yours to see.
const highestBid = (c) => c.claim_value;
// The respondent's figure is NEVER shown to the claimant. Printing it here made
// the blind bid decorative: the whole mechanic assumes neither side can see the
// other's number until it settles. Once settled, the agreed figure is public to
// both parties — that, and only that, is what comes back.
const lowestBid = (c) => (c.status === 'settled' ? c.settled_value : null);

function decorate(c) {
  return Object.assign({}, c, {
    stage: stageOf(c),
    stalled: isStalled(c),
    attention: needsAttention(c),
    age: daysSince(c.created_at),
    hasBar: c.claim_ideal != null && c.claim_fair != null && c.claim_value != null,
    highest: highestBid(c),
    lowest: lowestBid(c),
  });
}

// ---- Migrations --------------------------------------------------------------
// Self-contained so db.js is never edited. Safe to run on every boot.
async function initBusiness() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'individual';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_ideal_pct  INTEGER NOT NULL DEFAULT 95;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_target_pct INTEGER NOT NULL DEFAULT 80;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_walk_pct   INTEGER NOT NULL DEFAULT 65;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_enabled BOOLEAN NOT NULL DEFAULT true;`);

  // The workspace tag. Everything that already exists was raised by a person,
  // so 'individual' is the correct default and the correct backfill.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS portal TEXT NOT NULL DEFAULT 'individual';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cases_portal_idx ON cases(claimant_id, portal);`);

  // Fields carried in from a business spreadsheet.
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS our_ref TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS secondary_ref TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS category TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS source_status TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS issue_date DATE;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS due_date DATE;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS notes TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bid_presets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      ideal_pct  INTEGER NOT NULL,
      target_pct INTEGER NOT NULL,
      walk_pct   INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bid_presets_user_idx ON bid_presets(user_id);`);
  console.log('[business] portal tables ready');
}

// ---- Queries -----------------------------------------------------------------
const bz = {
  // Business: only what the business portal raised.
  async casesForBusiness(userId) {
    const r = await pool.query(
      "SELECT * FROM cases WHERE claimant_id=$1 AND portal='business' ORDER BY created_at DESC", [userId]);
    return r.rows;
  },
  // Individual: what I raised as myself, plus anything I was invited into.
  async casesForIndividual(userId) {
    const r = await pool.query(
      "SELECT * FROM cases WHERE (claimant_id=$1 AND portal='individual') OR respondent_id=$1 ORDER BY created_at DESC",
      [userId]);
    return r.rows;
  },
  async setAccountType(userId, type, companyName) {
    await pool.query('UPDATE users SET account_type=$1, company_name=coalesce($2, company_name) WHERE id=$3',
      [type, companyName || null, userId]);
  },
  async setBar(userId, i, t, w) {
    await pool.query('UPDATE users SET bar_ideal_pct=$1, bar_target_pct=$2, bar_walk_pct=$3 WHERE id=$4', [i, t, w, userId]);
  },
  async setNudge(userId, on) { await pool.query('UPDATE users SET nudge_enabled=$1 WHERE id=$2', [on, userId]); },
  async presets(userId) {
    const r = await pool.query('SELECT * FROM bid_presets WHERE user_id=$1 ORDER BY created_at', [userId]);
    return r.rows;
  },
  async addPreset(userId, name, i, t, w) {
    await pool.query('INSERT INTO bid_presets (user_id, name, ideal_pct, target_pct, walk_pct) VALUES ($1,$2,$3,$4,$5)',
      [userId, name.slice(0, 80), i, t, w]);
  },
  async deletePreset(userId, id) { await pool.query('DELETE FROM bid_presets WHERE id=$1 AND user_id=$2', [id, userId]); },
  async setEmail(id, userId, email) {
    await pool.query('UPDATE cases SET other_email=$1 WHERE id=$2 AND claimant_id=$3', [email, id, userId]);
  },
  async markNudged(id) { await pool.query('UPDATE cases SET last_nudge_at=now() WHERE id=$1', [id]); },
  async setMeta(id, m) {
    await pool.query(
      `UPDATE cases SET our_ref=$1, secondary_ref=$2, category=$3, source_status=$4,
       issue_date=$5, due_date=$6, notes=$7 WHERE id=$8`,
      [m.our_ref, m.secondary_ref, m.category, m.source_status, m.issue_date, m.due_date, m.notes, id]);
  },
  // The move. Live cases change workspace; they are never duplicated, so no new
  // token is minted and the other side is never re-invited.
  async moveToBusiness(userId, caseIds) {
    const r = await pool.query(
      `UPDATE cases SET portal='business'
       WHERE claimant_id=$1 AND portal='individual' AND id = ANY($2::int[])
         AND status NOT IN ('settled','closed')
       RETURNING id`,
      [userId, caseIds]);
    return r.rowCount;
  },
};

// ---- Helpers -----------------------------------------------------------------
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const baseUrl = (req) => req.protocol + '://' + req.get('host');
const ids = (body) => {
  const raw = body.ids;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.map(Number).filter(Boolean);
};
const pct = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 100 ? n : d; };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max || 200)) || null;
const asDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// Returns { ok, error }. The invite email IS the product — if it doesn't land,
// the respondent never joins. So we wait for the result and report it honestly
// rather than firing and forgetting.
async function inviteOne(req, c, meEmail) {
  const inviteUrl = baseUrl(req) + '/join/' + c.invite_token;
  const payload = { id: c.id, title: c.title, amount: c.amount, currency: c.currency, other_email: c.other_email };

  let res = { ok: false, error: 'Unknown mail error.' };
  try {
    res = (await mailer.notifyCaseInvite(payload, { creatorEmail: meEmail, recipientPosition: 'owe', inviteUrl })) || { ok: true };
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  if (!res.ok) {
    // Leave the case as a draft. It is still invitable once mail is fixed, and
    // the list keeps telling the truth about what has actually gone out.
    await db.addEvent(c.id, 'error', 'Invite to ' + c.other_email + ' FAILED — ' + res.error);
    return res;
  }

  await db.setStatus('awaiting_other', c.id);
  await db.addEvent(c.id, 'invited', 'Invited ' + c.other_email);
  mailer.notifyNewCase(payload, meEmail, c.other_email).catch(() => {});   // admin copy; not critical
  return { ok: true };
}

// =============================================================================
// Routes
// =============================================================================

// Kept so an old cached page or a bookmark does something sensible instead of
// 404ing. It no longer touches account_type — access is granted in Admin > Users,
// and a nav control has no business rewriting your permissions.
router.post('/switch', requireLogin, (req, res) => {
  res.redirect(req.body.type === 'business' ? '/business' : '/dashboard');
});

// ---- Dashboard ---------------------------------------------------------------
router.get('/', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  // Deliberately NOT promoting anyone here any more. Visiting a URL used to rewrite
  // your account type without asking, which meant the business portal let itself in.
  // Access is granted by an admin, in Admin > Users.

  const cases = (await bz.casesForBusiness(me.id)).map(decorate);
  const open = cases.filter(isOpen);
  const at = (s) => cases.filter((c) => c.stage === s);
  const sum = (arr, k) => arr.reduce((a, c) => a + (c[k] || 0), 0);

  const invited = cases.filter((c) => c.stage !== 'draft');
  const joined = cases.filter((c) => ['bidding', 'settled'].includes(c.stage) || c.status === 'declined');
  const joinRate = invited.length ? Math.round((joined.length / invited.length) * 100) : 0;

  const counts = { all: open.length, attn: cases.filter((c) => c.attention).length,
                   nobar: open.filter((c) => !c.hasBar).length,
                   noemail: cases.filter((c) => !c.other_email).length,
                   declined: cases.filter((c) => c.status === 'declined').length };
  STAGES.forEach((s) => { counts[s] = at(s).length; });

  // Cases still sitting in the individual workspace, offered for the move.
  const individualOpen = (await bz.casesForIndividual(me.id))
    .filter((c) => c.claimant_id === me.id && isOpen(c));

  res.render('business', {
    cases, counts,
    kpis: {
      totalInDispute: sum(open, 'amount'),
      joinRate,
      inBand: at('bidding').length,          // rounds in play — not how close anyone is
      settledValue: sum(cases.filter((c) => c.status === 'settled'), 'settled_value'),
      currency: cases[0] ? cases[0].currency : 'GBP',
    },
    stages: STAGES,
    presets: await bz.presets(me.id),
    bar: { i: me.bar_ideal_pct, t: me.bar_target_pct, w: me.bar_walk_pct },
    nudgeOn: me.nudge_enabled,
    filter: req.query.filter || 'all',
    q: req.query.q || '',
    flash: req.query.msg || null,
    movable: individualOpen.length,
  });
}));

// ---- Editable counterparty email --------------------------------------------
// The spreadsheet may not carry one. It is always editable here, and nothing can
// be invited until it exists.
router.post('/cases/:id/email', requireLogin, wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) {
    return res.redirect('/business?msg=' + encodeURIComponent('That does not look like an email address.'));
  }
  await bz.setEmail(Number(req.params.id), req.session.userId, email || null);
  await db.addEvent(Number(req.params.id), 'updated', 'Counterparty email set to ' + (email || '(cleared)'));
  res.redirect('/business?msg=' + encodeURIComponent(email ? 'Email saved. You can invite this one now.' : 'Email cleared.'));
}));

// ---- Save a field from the detail panel --------------------------------------
// Notes and email, saved without a page reload. Form-encoded so it uses the same
// body parser as every other form here; returns JSON so the panel can show
// whether it actually worked rather than assuming it did.
router.post('/cases/:id/patch', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c || c.claimant_id !== req.session.userId || c.portal !== 'business') {
    return res.status(403).json({ ok: false, error: 'Not your case' });
  }

  if (typeof req.body.notes === 'string') {
    await pool.query('UPDATE cases SET notes=$1 WHERE id=$2', [req.body.notes.slice(0, 4000) || null, id]);
    return res.json({ ok: true });
  }

  if (typeof req.body.email === 'string') {
    if (['settled', 'closed', 'declined'].includes(c.status)) {
      return res.status(400).json({ ok: false, error: 'Case is closed' });
    }
    const e = req.body.email.trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      return res.status(400).json({ ok: false, error: 'Not an email' });
    }
    await pool.query('UPDATE cases SET other_email=$1 WHERE id=$2', [e || null, id]);
    return res.json({ ok: true });
  }

  res.status(400).json({ ok: false, error: 'Nothing to save' });
}));

// ---- One case's own bid bar --------------------------------------------------
// The group bar is the fast way to set a sensible default across a whole ledger.
// This is the override for the cases that deserve individual attention. Stored as
// money on the case (like every other case in the system), but set as a
// percentage so it reads the same way as the group bar.
router.post('/cases/:id/anchors', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c || c.claimant_id !== req.session.userId || c.portal !== 'business') {
    return res.redirect('/business?msg=' + encodeURIComponent('That case is not yours to change.'));
  }
  if (['settled', 'closed'].includes(c.status)) {
    return res.redirect('/business?msg=' + encodeURIComponent('That case is finished — its figures are locked.'));
  }
  const i = pct(req.body.ideal, 95), t = pct(req.body.target, 80), w = pct(req.body.walk, 65);
  if (!(i >= t && t >= w)) {
    return res.redirect('/business?msg=' + encodeURIComponent('Ideal must be at or above Target, and Target at or above Walk-away.'));
  }
  const vi = Math.round(c.amount * i / 100), vt = Math.round(c.amount * t / 100), vw = Math.round(c.amount * w / 100);
  await db.setClaimAnchors(vi, vt, vw, id);
  await db.addEvent(id, 'updated', 'Bid bar set for this case alone: ' + i + '/' + t + '/' + w + '%');
  res.redirect('/business?msg=' + encodeURIComponent(
    c.title + ' set on its own — walk-away ' + res.locals.money(vw, c.currency) + ' (' + w + '%). Other cases untouched.'));
}));

// ---- Create one dispute ------------------------------------------------------
router.post('/new', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const title = (req.body.title || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const other = (req.body.other_email || '').trim().toLowerCase();
  const currency = (req.body.currency || 'GBP').toUpperCase();
  if (!title || !(amount > 0)) return res.redirect('/business?msg=' + encodeURIComponent('A name and a valid amount are required.'));
  if (other && !EMAIL_RE.test(other)) return res.redirect('/business?msg=' + encodeURIComponent('That does not look like an email address.'));

  const token = crypto.randomBytes(16).toString('hex');
  const id = await db.createCase(title, amount, token, me.id, null, other || null, currency);
  await db.setStatus('draft', id);
  await pool.query("UPDATE cases SET portal='business' WHERE id=$1", [id]);
  await bz.setMeta(id, {
    our_ref: clean(req.body.our_ref, 80), secondary_ref: clean(req.body.secondary_ref, 80),
    category: clean(req.body.category, 80), source_status: clean(req.body.source_status, 60),
    issue_date: asDate(req.body.issue_date), due_date: asDate(req.body.due_date),
    notes: clean(req.body.notes, 1000),
  });
  await db.addEvent(id, 'created', 'Created in the business portal by ' + me.email);
  if (req.body.apply_bar) {
    await db.setClaimAnchors(
      Math.round(amount * me.bar_ideal_pct / 100),
      Math.round(amount * me.bar_target_pct / 100),
      Math.round(amount * me.bar_walk_pct / 100), id);
  }
  res.redirect('/business?msg=' + encodeURIComponent('Dispute added as a draft.' + (other ? ' Invite when ready.' : ' Add an email before inviting.')));
}));

// ---- Import ------------------------------------------------------------------
// The browser parses the .xlsx/.csv with SheetJS and posts mapped rows as JSON.
router.post('/import', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 500) : [];
  const applyBar = !!req.body.apply_bar;
  let made = 0, skipped = 0, noEmail = 0;

  for (const r of rows) {
    const title = clean(r.title, 160);
    const amount = parseInt(String(r.amount == null ? '' : r.amount).replace(/[^0-9]/g, ''), 10);
    if (!title || !(amount > 0)) { skipped++; continue; }
    const email = (r.email || '').trim().toLowerCase();
    const validEmail = email && EMAIL_RE.test(email) ? email : null;
    if (!validEmail) noEmail++;
    const currency = (clean(r.currency, 3) || 'GBP').toUpperCase().replace(/[^A-Z]/g, '') || 'GBP';

    const token = crypto.randomBytes(16).toString('hex');
    const id = await db.createCase(title, amount, token, me.id, null, validEmail, currency);
    await db.setStatus('draft', id);
    await pool.query("UPDATE cases SET portal='business' WHERE id=$1", [id]);
    await bz.setMeta(id, {
      our_ref: clean(r.our_ref, 80), secondary_ref: clean(r.secondary_ref, 80),
      category: clean(r.category, 80), source_status: clean(r.source_status, 60),
      issue_date: asDate(r.issue_date), due_date: asDate(r.due_date), notes: clean(r.notes, 1000),
    });
    await db.addEvent(id, 'created', 'Imported into the business portal by ' + me.email);
    if (applyBar) {
      await db.setClaimAnchors(
        Math.round(amount * me.bar_ideal_pct / 100),
        Math.round(amount * me.bar_target_pct / 100),
        Math.round(amount * me.bar_walk_pct / 100), id);
    }
    made++;
  }

  let msg = made ? made + ' dispute' + (made === 1 ? '' : 's') + ' imported as drafts' : 'Nothing imported';
  if (applyBar && made) msg += ', bid bar applied';
  if (noEmail) msg += '. ' + noEmail + ' ha' + (noEmail === 1 ? 's' : 've') + ' no email yet — add one before inviting';
  if (skipped) msg += '. ' + skipped + ' row(s) skipped (no name or amount)';
  res.json({ ok: true, made, noEmail, skipped, msg: msg + '.' });
}));

// ---- Move from the individual workspace --------------------------------------
router.post('/move-in', requireLogin, wrap(async (req, res) => {
  const caseIds = Array.isArray(req.body.caseIds) ? req.body.caseIds.map(Number).filter(Boolean) : [];
  if (!caseIds.length) return res.json({ ok: false, msg: 'No MidBid case IDs found in that file.' });
  const n = await bz.moveToBusiness(req.session.userId, caseIds);
  for (const id of caseIds) await db.addEvent(id, 'updated', 'Moved into the business workspace').catch(() => {});
  res.json({ ok: true, moved: n, msg: n
    ? n + ' case' + (n === 1 ? '' : 's') + ' moved across. Same history, same bids, no re-invites sent.'
    : 'Nothing moved — those cases are already in business, or are settled/closed.' });
}));

// ---- Bid bar -----------------------------------------------------------------
router.post('/bidbar', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const i = pct(req.body.ideal, 95), t = pct(req.body.target, 80), w = pct(req.body.walk, 65);
  if (!(i >= t && t >= w)) return res.redirect('/business?msg=' + encodeURIComponent('Ideal must be at or above Target, and Target at or above Walk-away.'));
  await bz.setBar(me.id, i, t, w);

  const scope = req.body.scope || 'open';
  const picked = ids(req.body);
  let n = 0;
  for (const c of await bz.casesForBusiness(me.id)) {
    if (!isOpen(c)) continue;
    const hasBar = c.claim_ideal != null && c.claim_fair != null && c.claim_value != null;
    const inScope = scope === 'selected' ? picked.includes(c.id) : scope === 'nobar' ? !hasBar : true;
    if (!inScope) continue;
    await db.setClaimAnchors(
      Math.round(c.amount * i / 100), Math.round(c.amount * t / 100), Math.round(c.amount * w / 100), c.id);
    n++;
  }
  res.redirect('/business?msg=' + encodeURIComponent(n
    ? 'Bid bar applied to ' + n + ' case' + (n === 1 ? '' : 's') + ', each worked out from its own amount.'
    : 'No cases matched that scope.'));
}));

// ---- Presets -----------------------------------------------------------------
router.post('/presets', requireLogin, wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/business?msg=' + encodeURIComponent('Give the preset a name first.'));
  await bz.addPreset(req.session.userId, name, pct(req.body.ideal, 95), pct(req.body.target, 80), pct(req.body.walk, 65));
  res.redirect('/business?msg=' + encodeURIComponent('Preset "' + name + '" saved.'));
}));
router.post('/presets/:id/delete', requireLogin, wrap(async (req, res) => {
  await bz.deletePreset(req.session.userId, Number(req.params.id));
  res.redirect('/business?msg=' + encodeURIComponent('Preset removed.'));
}));

// ---- Auto-nudge --------------------------------------------------------------
router.post('/nudge', requireLogin, wrap(async (req, res) => {
  const on = req.body.on === '1';
  await bz.setNudge(req.session.userId, on);
  res.redirect('/business?msg=' + encodeURIComponent(on
    ? 'Auto-nudge on — non-responders are reminded on day 3, 7 and 14.'
    : 'Auto-nudge off — reminders are manual.'));
}));

// ---- Bulk --------------------------------------------------------------------
router.post('/bulk', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const action = req.body.action;
  const picked = ids(req.body);
  if (!picked.length) return res.redirect('/business?msg=' + encodeURIComponent('Nothing selected.'));

  const mine = (await bz.casesForBusiness(me.id)).filter((c) => picked.includes(c.id));
  let n = 0, msg = '', blocked = 0;

  if (action === 'invite') {
    let failed = 0, firstErr = '';
    for (const c of mine) {
      if (stageOf(c) !== 'draft') continue;
      if (!c.other_email) { blocked++; continue; }        // cannot invite without an address
      const r = await inviteOne(req, c, me.email);
      if (r.ok) { n++; } else { failed++; if (!firstErr) firstErr = r.error; }
    }
    msg = n ? 'Invited ' + n + ' counterpart' + (n === 1 ? 'y' : 'ies') + '.' : '';
    if (blocked) msg += ' ' + blocked + ' skipped — no email address yet.';
    if (failed) msg += ' ' + failed + ' could NOT be sent: ' + firstErr;
    if (!msg) msg = 'Nothing invited.';

  } else if (action === 'remind') {
    for (const c of mine) {
      if (c.status !== 'awaiting_other' || !c.other_email) continue;
      mailer.notifyCaseInvite(
        { id: c.id, title: c.title, amount: c.amount, currency: c.currency, other_email: c.other_email },
        { creatorEmail: me.email, recipientPosition: 'owe', inviteUrl: baseUrl(req) + '/join/' + c.invite_token }
      ).catch(() => {});
      await bz.markNudged(c.id);
      await db.addEvent(c.id, 'reminder', 'Reminder sent to ' + c.other_email);
      n++;
    }
    msg = n ? 'Reminder sent to ' + n + ' counterpart' + (n === 1 ? 'y' : 'ies') + '.' : 'Nothing to remind.';

  } else if (action === 'approve') {
    // Retired. Under sealed bidding your submitted figure is the commitment, so a
    // round that overlaps settles on its own — there is nothing left to approve.
    msg = 'Settlement is automatic now — if two ranges meet, the round settles itself.';
  } else if (action === 'close') {
    for (const c of mine) {
      if (!isOpen(c)) continue;
      await db.setStatus('closed', c.id);
      await db.addEvent(c.id, 'closed', 'Closed from the business portal');
      n++;
    }
    msg = n ? 'Closed ' + n + ' dispute' + (n === 1 ? '' : 's') + '.' : 'Nothing to close.';

  } else {
    msg = 'Unknown action.';
  }
  res.redirect('/business?msg=' + encodeURIComponent(msg));
}));

// ---- CSV fallback ------------------------------------------------------------
// The main export builds an .xlsx in the browser; this stays for anyone who
// wants a plain file straight from a URL.
router.get('/export.csv', requireLogin, wrap(async (req, res) => {
  const rows = await bz.casesForBusiness(req.session.userId);
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = 'midbid_case_id,case_id,debtor,email,category,reference,amount,currency,issue_date,due_date,source_status,midbid_status,highest_bid,lowest_bid,settled_amount,notes\n';
  const body = rows.map((c) => [
    c.id, esc(c.our_ref), esc(c.title), esc(c.other_email), esc(c.category), esc(c.secondary_ref),
    c.amount, c.currency, esc(c.issue_date), esc(c.due_date), esc(c.source_status),
    stageOf(c), highestBid(c) || '', lowestBid(c) || '', c.settled_value || '', esc(c.notes)
  ].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="midbid-disputes.csv"');
  res.send(head + body);
}));

module.exports = {
  router, initBusiness, stageOf, STAGES, decorate,
  casesForIndividual: (userId) => bz.casesForIndividual(userId),
};
