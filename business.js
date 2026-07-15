'use strict';

// =============================================================================
// MidBid — Business portal
// -----------------------------------------------------------------------------
// Everything for the business side lives in this one file: its own database
// columns, its own routes, its own bulk actions. It is mounted by server.js with
// two lines and touches nothing in the individual flow.
//
// It deliberately REUSES the existing engine rather than rebuilding it:
//   - the same `cases` table and the same three-anchor columns
//     (claim_ideal / claim_fair / claim_value)
//   - the same invite tokens, so an invited person lands in the existing
//     individual app at /join/:token and bids there exactly as they do today
//   - the same Stripe activation fee, mailer and settlement agreement
//
// "Business" is therefore a different FRONT DOOR over one shared engine, not a
// second product. A business case is simply a case whose claimant is a user
// with account_type = 'business'.
// =============================================================================

const crypto = require('node:crypto');
const express = require('express');
const { pool, db } = require('./db');
const mailer = require('./mailer');
const multer = require('multer');
const XLSX = require('xlsx');

const router = express.Router();
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- Stage model -------------------------------------------------------------
// The engine's real statuses are mapped onto the five pipeline stages shown in
// the Path. Keep this as the single source of truth for the business view.
//
//   draft        -> created, not yet invited        (status 'draft' | 'pending_payment')
//   awaiting     -> invited, other side not joined  (status 'awaiting_other')
//   progress     -> both joined, still apart        (status 'active')
//   converging   -> both bid and within reach       (status 'active' + close)
//   settled      -> agreed                          (status 'settled')
// Off-pipeline: declined, closed.
const STAGES = ['draft', 'awaiting', 'progress', 'converging', 'settled'];
const CLOSE_THRESHOLD = 0.10;   // must match server.js

// Both walk-aways in, and either overlapping or within 10% of the amount.
function isClose(c) {
  if (c.claim_value == null || c.resp_value == null) return false;
  if (c.resp_value >= c.claim_value) return true;                  // overlap
  return (c.claim_value - c.resp_value) <= CLOSE_THRESHOLD * c.amount;
}

function stageOf(c) {
  if (c.status === 'settled') return 'settled';
  if (c.status === 'declined') return 'declined';
  if (c.status === 'closed') return 'closed';
  if (c.status === 'draft' || c.status === 'pending_payment') return 'draft';
  if (c.status === 'awaiting_other') return 'awaiting';
  return isClose(c) ? 'converging' : 'progress';                   // 'active'
}

const isOpen = (c) => !['settled', 'declined', 'closed'].includes(c.status);
const daysSince = (ts) => Math.floor((Date.now() - new Date(ts)) / 86400000);
const isStalled = (c) => c.status === 'awaiting_other' && daysSince(c.created_at) >= 14;
const needsAttention = (c) => stageOf(c) === 'converging' || c.status === 'declined' || isStalled(c);

// ---- Migrations --------------------------------------------------------------
// Self-contained so db.js never has to be edited. Safe to run on every boot.
async function initBusiness() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'individual';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name TEXT;`);
  // The saved bid bar, held as percentages so it scales across disputes of any size.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_ideal_pct  INTEGER NOT NULL DEFAULT 95;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_target_pct INTEGER NOT NULL DEFAULT 80;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_walk_pct   INTEGER NOT NULL DEFAULT 65;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_enabled BOOLEAN NOT NULL DEFAULT true;`);
  // Imported case metadata. Email is intentionally nullable: a draft can be
  // created first and the counterparty email added/edited later.
  await pool.query(`ALTER TABLE cases ALTER COLUMN other_email DROP NOT NULL;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS our_ref TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS category TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS source_status TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS issue_date DATE;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS due_date DATE;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS notes TEXT;`);
  await pool.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS creditor TEXT;`);
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

// ---- Small data helpers ------------------------------------------------------
const bz = {
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
  // Only cases this business raised. The business is always the claimant.
  async casesForBusiness(userId) {
    const r = await pool.query('SELECT * FROM cases WHERE claimant_id=$1 ORDER BY created_at DESC', [userId]);
    return r.rows;
  },
  async markNudged(id) { await pool.query('UPDATE cases SET last_nudge_at=now() WHERE id=$1', [id]); },
  async setOurRef(id, ref) { await pool.query('UPDATE cases SET our_ref=$1 WHERE id=$2', [ref, id]); },
  async setEmail(id, userId, email) {
    await pool.query('UPDATE cases SET other_email=$1 WHERE id=$2 AND claimant_id=$3', [email || null, id, userId]);
  },
  async setMetadata(id, userId, m) {
    await pool.query(`UPDATE cases SET category=$1, source_status=$2, issue_date=$3, due_date=$4, notes=$5, creditor=$6, our_ref=$7 WHERE id=$8 AND claimant_id=$9`,
      [m.category || null, m.source_status || null, m.issue_date || null, m.due_date || null, m.notes || null, m.creditor || null, m.our_ref || null, id, userId]);
  },
};

// ---- Guards ------------------------------------------------------------------
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
const pct = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : d;
};

// Send the invitation for one case. Mirrors activateCaseAndInvite in server.js,
// but for the business direction only (business = claimant, other side = respondent).
async function inviteOne(req, c, meEmail) {
  await db.setStatus('awaiting_other', c.id);
  await db.addEvent(c.id, 'invited', 'Invited ' + c.other_email);
  const inviteUrl = baseUrl(req) + '/join/' + c.invite_token;
  const payload = { id: c.id, title: c.title, amount: c.amount, currency: c.currency, other_email: c.other_email };
  mailer.notifyNewCase(payload, meEmail, c.other_email).catch(() => {});
  mailer.notifyCaseInvite(payload, { creatorEmail: meEmail, recipientPosition: 'owe', inviteUrl }).catch(() => {});
}

// =============================================================================
// Routes
// =============================================================================

// Switch the account between portals. Used by the gate and the nav switch.
router.post('/switch', requireLogin, wrap(async (req, res) => {
  const type = req.body.type === 'business' ? 'business' : 'individual';
  await bz.setAccountType(req.session.userId, type, req.body.company_name);
  res.redirect(type === 'business' ? '/business' : '/dashboard');
}));

// ---- The dashboard -----------------------------------------------------------
router.get('/', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  if (me.account_type !== 'business') await bz.setAccountType(me.id, 'business');

  const rows = await bz.casesForBusiness(me.id);
  const cases = rows.map((c) => ({
    ...c,
    stage: stageOf(c),
    stalled: isStalled(c),
    attention: needsAttention(c),
    age: daysSince(c.created_at),
    hasBar: c.claim_ideal != null && c.claim_fair != null && c.claim_value != null,
  }));

  const open = cases.filter(isOpen);
  const at = (s) => cases.filter((c) => c.stage === s);
  const sum = (arr, k) => arr.reduce((a, c) => a + (c[k] || 0), 0);

  // Respondent join rate — the leading metric. Of everyone invited, how many
  // actually turned up and engaged.
  const invited = cases.filter((c) => c.stage !== 'draft');
  const joined = cases.filter((c) => ['progress', 'converging', 'settled'].includes(c.stage) || c.status === 'declined');
  const joinRate = invited.length ? Math.round((joined.length / invited.length) * 100) : 0;

  const kpis = {
    totalInDispute: sum(open, 'amount'),
    joinRate,
    inBand: at('converging').length,
    settledValue: sum(cases.filter((c) => c.status === 'settled'), 'settled_value'),
    currency: cases[0] ? cases[0].currency : 'GBP',
  };
  const counts = {};
  STAGES.forEach((s) => { counts[s] = at(s).length; });
  counts.declined = cases.filter((c) => c.status === 'declined').length;
  counts.closed = cases.filter((c) => c.status === 'closed').length;
  counts.all = open.length;
  counts.attn = cases.filter((c) => c.attention).length;
  counts.nobar = open.filter((c) => !c.hasBar).length;

  res.render('business', {
    cases,
    counts,
    kpis,
    stages: STAGES,
    presets: await bz.presets(me.id),
    bar: { i: me.bar_ideal_pct, t: me.bar_target_pct, w: me.bar_walk_pct },
    nudgeOn: me.nudge_enabled,
    filter: req.query.filter || 'all',
    q: req.query.q || '',
    flash: req.query.msg || null,
  });
}));

// ---- Create one dispute (draft — invited later, in a batch) -------------------
router.post('/new', requireLogin, wrap(async (req, res) => {
  const title = (req.body.title || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const other = (req.body.other_email || '').trim().toLowerCase();
  const currency = (req.body.currency || 'GBP').toUpperCase();
  if (!title || !(amount > 0) || !other) return res.redirect('/business?msg=' + encodeURIComponent('Fill in every field with valid values.'));
  const token = crypto.randomBytes(16).toString('hex');
  const id = await db.createCase(title, amount, token, req.session.userId, null, other, currency);
  await db.setStatus('draft', id);
  if (req.body.our_ref) await bz.setOurRef(id, String(req.body.our_ref).slice(0, 80));
  await db.addEvent(id, 'created', 'Created in the business portal by ' + res.locals.me.email);
  if (req.body.apply_bar) {
    const me = res.locals.me;
    await db.setClaimAnchors(
      Math.round(amount * me.bar_ideal_pct / 100),
      Math.round(amount * me.bar_target_pct / 100),
      Math.round(amount * me.bar_walk_pct / 100), id);
  }
  res.redirect('/business?msg=' + encodeURIComponent('Dispute added as a draft. Invite when you are ready.'));
}));

// ---- Bulk import from Excel or CSV ------------------------------------------
const norm = (v) => String(v == null ? '' : v).trim();
const keyOf = (v) => norm(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
const aliases = {
  title: ['debtorcompany','counterparty','debtor','company','title','case'],
  email: ['debtoremail','counterpartyemail','email','otheremail'],
  creditor: ['creditor','claimant','yourcompany'],
  category: ['category','duescategory','type'],
  our_ref: ['referenceno','reference','ourref','caseref','caseid'],
  amount: ['amountowed','amount','claimamount','amountindispute'],
  currency: ['currency','ccy'],
  issue_date: ['issuedate','invoiceissuedate'],
  due_date: ['duedate','paymentduedate'],
  source_status: ['status','sourcestatus'],
  notes: ['notesofclaimdues','notes','description','claimnotes']
};
function mapped(row, field) {
  const wanted = aliases[field] || [];
  for (const [k, v] of Object.entries(row)) if (wanted.includes(keyOf(k))) return v;
  return '';
}
function excelDate(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.valueOf())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    return d ? [d.y, String(d.m).padStart(2,'0'), String(d.d).padStart(2,'0')].join('-') : null;
  }
  const d = new Date(v);
  return Number.isNaN(d.valueOf()) ? null : d.toISOString().slice(0, 10);
}
function parseWorkbook(buffer, originalname) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: true }).slice(0, 500);
}

router.post('/import', requireLogin, importUpload.single('spreadsheet'), wrap(async (req, res) => {
  if (!req.file) return res.redirect('/business?msg=' + encodeURIComponent('Choose an .xlsx, .xls or .csv file first.'));
  const me = res.locals.me;
  const applyBar = !!req.body.apply_bar;
  const rows = parseWorkbook(req.file.buffer, req.file.originalname);
  let made = 0, missingEmail = 0, skipped = 0;
  for (const row of rows) {
    const title = norm(mapped(row, 'title'));
    const rawAmount = String(mapped(row, 'amount')).replace(/[^0-9.-]/g, '');
    const amount = Math.round(Number(rawAmount));
    if (!title || !(amount > 0)) { skipped++; continue; }
    const rawEmail = norm(mapped(row, 'email')).toLowerCase();
    const email = EMAIL_RE.test(rawEmail) ? rawEmail : null;
    if (!email) missingEmail++;
    const currency = (norm(mapped(row, 'currency')) || 'GBP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'GBP';
    const token = crypto.randomBytes(16).toString('hex');
    const id = await db.createCase(title, amount, token, me.id, null, email, currency);
    await db.setStatus('draft', id);
    await bz.setMetadata(id, me.id, {
      creditor: norm(mapped(row, 'creditor')).slice(0, 200),
      category: norm(mapped(row, 'category')).slice(0, 100),
      our_ref: norm(mapped(row, 'our_ref')).slice(0, 100),
      source_status: norm(mapped(row, 'source_status')).slice(0, 100),
      issue_date: excelDate(mapped(row, 'issue_date')),
      due_date: excelDate(mapped(row, 'due_date')),
      notes: norm(mapped(row, 'notes')).slice(0, 2000)
    });
    await db.addEvent(id, 'created', 'Imported from ' + req.file.originalname + ' by ' + me.email);
    if (applyBar) await db.setClaimAnchors(
      Math.round(amount * me.bar_ideal_pct / 100),
      Math.round(amount * me.bar_target_pct / 100),
      Math.round(amount * me.bar_walk_pct / 100), id);
    made++;
  }
  let msg = made ? 'Imported ' + made + ' draft' + (made === 1 ? '' : 's') + '.' : 'No valid rows were imported.';
  if (missingEmail) msg += ' ' + missingEmail + ' email field' + (missingEmail === 1 ? ' is' : 's are') + ' blank and can be edited before inviting.';
  if (skipped) msg += ' ' + skipped + ' invalid row' + (skipped === 1 ? ' was' : 's were') + ' skipped.';
  res.redirect('/business?msg=' + encodeURIComponent(msg));
}));

router.post('/cases/:id/email', requireLogin, wrap(async (req, res) => {
  const value = norm(req.body.other_email).toLowerCase();
  if (value && !EMAIL_RE.test(value)) return res.redirect('/business?msg=' + encodeURIComponent('Enter a valid email address or leave it blank.'));
  await bz.setEmail(Number(req.params.id), req.session.userId, value || null);
  await db.addEvent(Number(req.params.id), 'email_updated', value ? 'Counterparty email updated' : 'Counterparty email cleared');
  res.redirect('/business?msg=' + encodeURIComponent(value ? 'Email saved.' : 'Email removed. This case remains a draft until an email is added.'));
}));

// ---- Apply the bid bar -------------------------------------------------------
// The heart of the business portal. The three percentages are turned into three
// real figures PER CASE, from that case's own amount, then written with the
// engine's existing anchor setter. No second bidding system.
router.post('/bidbar', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const i = pct(req.body.ideal, 95), t = pct(req.body.target, 80), w = pct(req.body.walk, 65);
  if (!(i >= t && t >= w)) return res.redirect('/business?msg=' + encodeURIComponent('Ideal must be at or above Target, and Target at or above Walk-away.'));
  await bz.setBar(me.id, i, t, w);

  const scope = req.body.scope || 'open';
  const picked = ids(req.body);
  const all = await bz.casesForBusiness(me.id);
  let n = 0;
  for (const c of all) {
    if (!isOpen(c)) continue;
    const hasBar = c.claim_ideal != null && c.claim_fair != null && c.claim_value != null;
    const inScope = scope === 'selected' ? picked.includes(c.id) : scope === 'nobar' ? !hasBar : true;
    if (!inScope) continue;
    await db.setClaimAnchors(
      Math.round(c.amount * i / 100),
      Math.round(c.amount * t / 100),
      Math.round(c.amount * w / 100), c.id);
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

// ---- Auto-nudge toggle -------------------------------------------------------
router.post('/nudge', requireLogin, wrap(async (req, res) => {
  const on = req.body.on === '1';
  await bz.setNudge(req.session.userId, on);
  res.redirect('/business?msg=' + encodeURIComponent(on
    ? 'Auto-nudge on — non-responders are reminded on day 3, 7 and 14.'
    : 'Auto-nudge off — reminders are manual.'));
}));

// ---- Bulk actions ------------------------------------------------------------
router.post('/bulk', requireLogin, wrap(async (req, res) => {
  const me = res.locals.me;
  const action = req.body.action;
  const picked = ids(req.body);
  if (!picked.length) return res.redirect('/business?msg=' + encodeURIComponent('Nothing selected.'));

  const all = await bz.casesForBusiness(me.id);
  const mine = all.filter((c) => picked.includes(c.id));     // ownership check
  let n = 0, msg = '';

  if (action === 'invite') {
    for (const c of mine) {
      if (stageOf(c) !== 'draft' || !EMAIL_RE.test(c.other_email || '')) continue;
      await inviteOne(req, c, me.email);
      n++;
    }
    msg = n ? 'Invited ' + n + ' counterpart' + (n === 1 ? 'y' : 'ies') + '.' : 'Those cases were already invited.';

  } else if (action === 'remind') {
    for (const c of mine) {
      if (c.status !== 'awaiting_other') continue;
      const inviteUrl = baseUrl(req) + '/join/' + c.invite_token;
      mailer.notifyCaseInvite(
        { id: c.id, title: c.title, amount: c.amount, currency: c.currency, other_email: c.other_email },
        { creatorEmail: me.email, recipientPosition: 'owe', inviteUrl }
      ).catch(() => {});
      await bz.markNudged(c.id);
      await db.addEvent(c.id, 'reminder', 'Reminder sent to ' + c.other_email);
      n++;
    }
    msg = n ? 'Reminder sent to ' + n + ' counterpart' + (n === 1 ? 'y' : 'ies') + '.' : 'Nothing to remind — those cases are not awaiting a response.';

  } else if (action === 'approve') {
    // Binding. Only cases actually in the settle band are approved; the rest are
    // skipped. Mirrors the individual /cases/:id/approve logic exactly.
    for (const c of mine) {
      if (c.status === 'settled' || c.status === 'closed') continue;
      if (!isClose(c)) continue;
      await db.setApproval('claim', c.id);
      await db.addEvent(c.id, 'approved', 'Claimant approved the settlement (business portal)');
      const u = await db.caseById(c.id);
      if (u.claim_approved && u.resp_approved) {
        const settled = Math.round((u.claim_value + u.resp_value) / 2 / 100) * 100;
        await db.settle('settled', settled, u.id);
        await db.addEvent(u.id, 'settled', 'Agreed at ' + res.locals.money(settled, u.currency) + ' — both sides approved');
        const full = await db.caseDetail(u.id);
        mailer.notifySettled(
          { id: full.id, title: full.title, settled_value: settled, currency: full.currency, other_email: full.other_email },
          full.claimant_acc_email, full.respondent_acc_email).catch(() => {});
      }
      n++;
    }
    msg = n ? 'Approved ' + n + ' case' + (n === 1 ? '' : 's') + '. Any where the other side has also approved are now settled.'
            : 'None of those cases are in the settle band yet.';

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

// ---- Export ------------------------------------------------------------------
router.get('/export.xlsx', requireLogin, wrap(async (req, res) => {
  const rows = await bz.casesForBusiness(req.session.userId);
  const data = rows.map((c) => ({
    'Case ID': 'MB-' + c.id,
    'Debtor Company': c.title,
    'Debtor Email': c.other_email || '',
    'Creditor': c.creditor || '',
    'Category': c.category || '',
    'Reference No.': c.our_ref || '',
    'Amount Owed': c.amount,
    'Currency': c.currency,
    'Issue Date': c.issue_date || '',
    'Due Date': c.due_date || '',
    'Source Status': c.source_status || '',
    'Notes of Claim / Dues': c.notes || '',
    'MidBid Status': stageOf(c),
    'Highest Bid': Math.max(...[c.claim_ideal,c.claim_fair,c.claim_value,c.resp_ideal,c.resp_fair,c.resp_value].filter((v)=>v!=null), 0) || '',
    'Lowest Bid': Math.min(...[c.claim_ideal,c.claim_fair,c.claim_value,c.resp_ideal,c.resp_fair,c.resp_value].filter((v)=>v!=null), Infinity) === Infinity ? '' : Math.min(...[c.claim_ideal,c.claim_fair,c.claim_value,c.resp_ideal,c.resp_fair,c.resp_value].filter((v)=>v!=null)),
    'Settled Amount': c.settled_value || '',
    'Date Settled': c.settled_at || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'MidBid Cases');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="midbid-disputes.xlsx"');
  res.send(buf);
}));

module.exports = { router, initBusiness, stageOf, STAGES };
