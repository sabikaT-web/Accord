'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { pool, db, init } = require('./db');
const mailer = require('./mailer');
// Business portal: its own routes + its own migrations. Mounted below.
const { router: businessRouter, initBusiness, casesForIndividual, decorate } = require('./business');

// --- Self-heal folder layout -------------------------------------------------
// The app expects templates in views/ (+ views/partials/) and the stylesheet in
// public/. If those folders are missing (e.g. files were uploaded flat to GitHub),
// rebuild the structure from the flat files at startup. Safe to keep; once the
// real folders exist in the repo this simply copies identical files over them.
const fs = require('node:fs');
(function ensureLayout() {
  const viewsDir = path.join(__dirname, 'views');
  const partialsDir = path.join(viewsDir, 'partials');
  const publicDir = path.join(__dirname, 'public');
  fs.mkdirSync(partialsDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  const pages = ['admin-case','admin-cases','admin-users','admin','case',
    'dashboard','home','join','login','message','new-case','signup','signup-invite',
    'terms','fees','privacy','business'];
  for (const p of pages) {
    const src = path.join(__dirname, p + '.ejs');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(viewsDir, p + '.ejs'));
  }
  for (const part of ['head','foot']) {
    const src = path.join(__dirname, part + '.ejs');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(partialsDir, part + '.ejs'));
  }
  const css = path.join(__dirname, 'styles.css');
  if (fs.existsSync(css)) fs.copyFileSync(css, path.join(publicDir, 'styles.css'));
  console.log('[layout] views/ and public/ are ready');
})();
// -----------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Payments (optional). If STRIPE_SECRET_KEY is not set, charging is disabled
// and the app behaves exactly as before (cases activate free, agreement is open). ----
let Stripe = null;
try { Stripe = require('stripe'); } catch (_) { /* package not installed yet */ }
const PAYMENTS_ENABLED = !!process.env.STRIPE_SECRET_KEY && !!Stripe;
const stripe = PAYMENTS_ENABLED ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ---- Multi-currency. Each case is denominated in ONE currency (chosen at creation).
// Percentages (10/15/5%) are the same everywhere; only the tier threshold, the flat
// fee and the activation fee are per-currency. Tune the numbers to your pricing. ----
const CURRENCIES = {
  GBP: { code: 'GBP', symbol: '£',  stripe: 'gbp', locale: 'en-GB', threshold: 2000,   flat: 50,   start: 5,   label: 'United Kingdom — £ GBP', law: 'the law of England and Wales', courts: 'the courts of England and Wales' },
  USD: { code: 'USD', symbol: '$',  stripe: 'usd', locale: 'en-US', threshold: 2500,   flat: 60,   start: 6,   label: 'United States — $ USD', law: 'the laws of the State of New York, United States', courts: 'the courts of the State of New York' },
  CAD: { code: 'CAD', symbol: 'C$', stripe: 'cad', locale: 'en-CA', threshold: 3500,   flat: 80,   start: 8,   label: 'Canada — C$ CAD', law: 'the laws of the Province of Ontario, Canada', courts: 'the courts of the Province of Ontario' },
  EUR: { code: 'EUR', symbol: '€',  stripe: 'eur', locale: 'de-DE', threshold: 2300,   flat: 55,   start: 6,   label: 'Germany — € EUR', law: 'the laws of Germany', courts: 'the courts of Germany' },
  SGD: { code: 'SGD', symbol: 'S$', stripe: 'sgd', locale: 'en-SG', threshold: 3500,   flat: 80,   start: 8,   label: 'Singapore — S$ SGD', law: 'the laws of Singapore', courts: 'the courts of Singapore' },
  INR: { code: 'INR', symbol: '₹',  stripe: 'inr', locale: 'en-IN', threshold: 200000, flat: 5000, start: 500, label: 'India — ₹ INR', law: 'the laws of India', courts: 'the courts of India' }
};
const DEFAULT_CURRENCY = (process.env.DEFAULT_CURRENCY || 'GBP').toUpperCase();
function curOf(code) { return CURRENCIES[(code || DEFAULT_CURRENCY).toUpperCase()] || CURRENCIES[DEFAULT_CURRENCY] || CURRENCIES.GBP; }
function money(n, code) { const c = curOf(code); return c.symbol + Number(n == null ? 0 : n).toLocaleString(c.locale); }
function guessCurrency(req) {
  const al = (req.headers['accept-language'] || '').toLowerCase();
  if (/en-in|hi-in|[,;]\s*in\b/.test(al)) return 'INR';
  if (/en-sg/.test(al)) return 'SGD';
  if (/en-ca|fr-ca/.test(al)) return 'CAD';
  if (/^de|[,;\s]de\b/.test(al)) return 'EUR';
  if (/en-us/.test(al)) return 'USD';
  if (/en-gb/.test(al)) return 'GBP';
  return DEFAULT_CURRENCY;
}
const MEDIATOR_FEE_NOTE = process.env.MEDIATOR_FEE_NOTE || 'A MidBid mediator will be in touch to arrange a session and confirm the fee.';

function baseUrl(req) { return req.protocol + '://' + req.get('host'); }
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }

// Bump this whenever the wording of the payment mandate changes. It is stored
// against each party so you can prove, later, exactly what they agreed to.
const MANDATE_VERSION = process.env.MANDATE_VERSION || '2026-07-v1';

// Success fee per the published Fee Schedule, in the case's own currency (MAJOR units).
function computeSuccessFee(c) {
  const cur = curOf(c.currency);
  const amt = c.amount, settled = c.settled_value || 0;
  const days = c.settled_at ? daysBetween(c.created_at, c.settled_at) : 0;
  if (amt < cur.threshold) return Math.round((days <= 30 ? 0.10 : 0.15) * settled);
  return (days <= 20) ? cur.flat : Math.round(0.05 * amt);
}

// ---- Fee ledger ------------------------------------------------------------
// All fee arithmetic happens in MINOR units so a 50/50 split of an odd amount
// does not silently lose a penny. Major units are only for display.
//
//   gross  = published success fee
//   credit = the activation fee the creator already paid (deducted from the TOTAL,
//            not from one party's share, so 50/50 stays symmetric and there is no
//            asymmetric figure to hide from either side)
//   due    = gross - credit, floored at zero
//
// This is the ONLY place the fee is computed. The Fee Schedule page and the terms
// must both read from it, or the number you promise and the number Stripe charges
// will drift apart.
const toMinor = (major) => Math.round(Number(major || 0) * 100);
const toMajor = (minor) => Number(minor || 0) / 100;

function feeLedger(c) {
  const cur = curOf(c.currency);
  const gross = toMinor(computeSuccessFee(c));
  const credit = c.start_fee_paid ? toMinor(cur.start) : 0;
  const due = Math.max(0, gross - credit);
  const paid = (c.claim_fee_paid_minor || 0) + (c.resp_fee_paid_minor || 0);
  const outstanding = Math.max(0, due - paid);
  return {
    gross, credit, due, paid, outstanding,
    settled: outstanding === 0 && due > 0,
    // A party's "half" is half of the ORIGINAL due, not half of what is left,
    // so choosing 50/50 late does not quietly cost you more.
    half: Math.ceil(due / 2),
    grossLabel: money(toMajor(gross), c.currency),
    creditLabel: money(toMajor(credit), c.currency),
    dueLabel: money(toMajor(due), c.currency),
    outstandingLabel: money(toMajor(outstanding), c.currency),
    halfLabel: money(toMajor(Math.ceil(due / 2)), c.currency)
  };
}

function myFeePaid(c, role) { return role === 'claim' ? (c.claim_fee_paid_minor || 0) : (c.resp_fee_paid_minor || 0); }
function myCard(c, role) {
  return role === 'claim'
    ? { customer: c.claim_customer_id, pm: c.claim_pm_id }
    : { customer: c.resp_customer_id,  pm: c.resp_pm_id };
}

// Credit a payment, then release the agreement if the fee is fully covered.
// Idempotent: releaseAgreement() is a no-op once agreement_released_at is set.
async function creditFeeAndMaybeRelease(req, id, role, amountMinor) {
  await db.addFeePayment(role, amountMinor, id);
  const c = await db.caseById(id);
  const led = feeLedger(c);
  await db.addEvent(id, 'payment',
    (role === 'claim' ? 'Claimant' : 'Respondent') + ' paid ' + money(toMajor(amountMinor), c.currency) +
    ' toward the service charge (' + money(toMajor(led.paid), c.currency) + ' of ' + led.dueLabel + ')');
  if (led.outstanding === 0 && led.due > 0) {
    await db.releaseAgreement(id);
    await db.addEvent(id, 'released', 'Service charge paid in full — settlement agreement released');
    const full = await db.caseDetail(id);
    if (mailer.notifyAgreementReleased) {
      mailer.notifyAgreementReleased(
        { id, title: full.title, url: baseUrl(req) + '/cases/' + id + '/agreement' },
        full.claimant_acc_email, full.respondent_acc_email
      ).catch(() => {});
    }
    return true;
  }
  return false;
}

// The condition precedent, in one place. Every route that generates, previews,
// emails or downloads the agreement must call this — not just the download button.
function agreementReleasable(c) {
  if (!PAYMENTS_ENABLED) return true;
  return !!c.agreement_released_at;
}

// Send the payer to Stripe Checkout for a one-off payment.
async function startCheckout(req, res, { caseId, kind, role, amountMajor, label, stripeCurrency, successUrl, cancelUrl }) {
  const sessionObj = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: stripeCurrency || 'gbp', unit_amount: Math.round(amountMajor * 100), product_data: { name: label } } }],
    metadata: { caseId: String(caseId), kind, role: role || '' },
    // Save the card on this one SCA challenge, so the success fee can later be
    // taken off-session without dragging the payer back through 3-D Secure.
    customer_creation: 'always',
    payment_intent_data: { setup_future_usage: 'off_session' },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
  res.redirect(303, sessionObj.url);
}

// Pull the customer + payment method off a completed Checkout session and store
// them against the paying side.
async function rememberCardFromSession(sessionObj, caseId, role) {
  try {
    const customer = typeof sessionObj.customer === 'string' ? sessionObj.customer : (sessionObj.customer && sessionObj.customer.id);
    let pm = null;
    if (sessionObj.payment_intent) {
      const piId = typeof sessionObj.payment_intent === 'string' ? sessionObj.payment_intent : sessionObj.payment_intent.id;
      const pi = await stripe.paymentIntents.retrieve(piId);
      pm = typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method && pi.payment_method.id);
    }
    if (customer && pm) await db.saveCard(role, customer, pm, caseId);
  } catch (err) { console.error('rememberCardFromSession:', err.message); }
}

// Charge a saved card without the payer present. Returns 'paid', 'needs_action'
// or 'failed'. Never throws — a declined card is a normal outcome, not a crash.
async function chargeSavedCard(c, role, amountMinor, label) {
  const card = myCard(c, role);
  if (!card.customer || !card.pm) return 'no_card';
  try {
    const pi = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: curOf(c.currency).stripe,
      customer: card.customer,
      payment_method: card.pm,
      off_session: true,
      confirm: true,
      description: label,
      metadata: { caseId: String(c.id), kind: 'success', role }
    });
    return pi.status === 'succeeded' ? 'paid' : 'failed';
  } catch (err) {
    if (err.code === 'authentication_required') return 'needs_action';
    console.error('chargeSavedCard:', err.code || err.message);
    return 'failed';
  }
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'midbid.settle@gmail.com').toLowerCase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));

// Supporting documents are held in memory then written to Postgres, because
// Render's disk is wiped on every deploy. Keep the limits tight.
const multer = require('multer');
const MAX_DOC_BYTES = 5 * 1024 * 1024;   // 5 MB per file
const MAX_DOCS = 5;
const ALLOWED_DOC_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES, files: MAX_DOCS },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_DOC_TYPES.includes(file.mimetype))
});
// Never let an oversized upload crash the app.
const uploadDocs = (req, res, next) => upload.array('documents', MAX_DOCS)(req, res, (err) => {
  if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 5 MB or smaller.' : 'Those files could not be uploaded.'; req.files = []; }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// ---- helpers shared with templates ----
const fmt = (n) => Number(n == null ? 0 : n).toLocaleString('en-GB');
const fmtDate = (ts) => ts ? new Date(ts).toLocaleString('en-GB') : '—';
const fmtDay = (ts) => ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function progressFor(c) {
  if (c.status === 'settled' || c.status === 'closed' || c.status === 'declined') return 100;
  if (c.status === 'awaiting_other') return 10;
  const cb = c.claim_value != null, rb = c.resp_value != null;
  if (!cb && !rb) return 30;
  if (cb !== rb) return 45;
  const gap = c.claim_value - c.resp_value;
  return 70;   // sealed: fill never varies with the other side's figure
}
function statusText(c) {
  if (c.status === 'settled') return 'Settled at ' + money(c.settled_value, c.currency);
  if (c.status === 'closed') return 'Closed';
  if (c.status === 'declined') return 'Declined by the other party';
  if (c.status === 'awaiting_other') return 'Waiting for the other party';
  const cb = c.claim_value != null, rb = c.resp_value != null;
  if (!cb && !rb) return 'Both sides to enter a figure';
  if (!rb) return "Waiting for respondent's figure";
  if (!cb) return "Waiting for claimant's figure";
  const gap = c.claim_value - c.resp_value;
  return 'Both bid — sealed until it settles';
}
function humanDuration(secs) {
  secs = Number(secs) || 0;
  if (secs <= 0) return '—';
  const d = secs / 86400; if (d >= 1) return d.toFixed(1) + ' days';
  const h = secs / 3600; if (h >= 1) return h.toFixed(1) + ' hours';
  return Math.round(secs / 60) + ' mins';
}

app.use(async (req, res, next) => {
  try {
    const me = req.session.userId ? await db.userById(req.session.userId) : null;
    res.locals.me = me;
    res.locals.isAdmin = !!(me && me.email && me.email.toLowerCase() === ADMIN_EMAIL);
    res.locals.currentPath = req.path;          // so the nav can mark itself
    res.locals.ADMIN_EMAIL = ADMIN_EMAIL;       // views link to it for demo requests
    res.locals.fmt = fmt;
    res.locals.money = money;
    res.locals.curOf = curOf;
    res.locals.CURRENCIES = CURRENCIES;
    res.locals.fmtDate = fmtDate;
    res.locals.fmtDay = fmtDay;
    res.locals.statusText = statusText;
    res.locals.progressFor = progressFor;
    next();
  } catch (err) { next(err); }
});

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireAdmin(req, res, next) {
  if (!res.locals.isAdmin) return res.status(403).render('message', { title: 'Admins only', body: 'You need to be signed in as the administrator to view this page.' });
  next();
}
function roleOf(c, userId) {
  if (c.claimant_id === userId) return 'claim';
  if (c.respondent_id === userId) return 'resp';
  return null;
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Blind proximity read. Sees BOTH sides' anchors but returns ONLY a coarse band
// and a safe message — never a number, never the gap, never the other side's figure.
//   claim_value = claimant floor (least they'll accept)  -> their walk-away
//   resp_value  = respondent ceiling (most they'll pay)   -> their walk-away
//   *_fair      = the middle figure each side would genuinely consider
// A deal is possible once the walk-aways overlap (ceiling >= floor). The Fair
// anchors give an earlier, softer "you're nearly there" highlight at 15%.

const PROX_TEXT = {
  pending: '',
  far:     'Some distance between you for now — nothing about your figures is shared.',
  apart:   'Getting closer, but still a gap. A slightly bolder move could help.',
  near:    'Your realistic figures look within about 15% of each other — a deal is in reach.',
  close:   "You're within 10% — either side can approve to settle.",
  overlap: 'Your ranges meet — a settlement is available. Approve to lock it in.'
};

// Friendly coach: picks a short nudge based on how extreme YOUR figure is
// and how far the two sides are apart. Runs server-side, so it can see both
// numbers — but it NEVER returns the other side's figure or the actual gap,
// only a gentle message. Blindness stays intact.

// The blind-bid brain: returns ONLY what the asking side may see.
// ---- Sealed-bid status --------------------------------------------------------
// The rule this function exists to enforce: NOTHING returned here may vary with
// the other side's figures until the case has settled. If the screen changes when
// you move your slider, the slider is not a bid — it is a query, and the blindness
// is decoration. That is why there is no proximity band, no "you're close", and no
// coach line that reads the gap.
async function viewerStatus(c, role) {
  const party  = role === 'claim' ? 'claimant' : 'respondent';
  const other  = party === 'claimant' ? 'respondent' : 'claimant';
  const round  = c.round || 1;
  const mine = role === 'claim'
    ? { ideal: c.claim_ideal, fair: c.claim_fair, reservation: c.claim_value }
    : { ideal: c.resp_ideal,  fair: c.resp_fair,  reservation: c.resp_value };

  const myBid    = await db.bidFor(c.id, party, round);
  const theirBid = await db.bidFor(c.id, other, round);
  const prev     = await db.lastBid(c.id, party);

  let s;
  if (c.status === 'settled') {
    s = { state: 'settled', colour: 'deal',
          title: 'Agreed at ' + money(c.settled_value, c.currency),
          sub: 'Your ranges met, so it settled automatically at the midpoint.',
          coach: { tone: 'deal', text: 'Settled. Nothing further to bid.' } };
  } else if (c.status === 'closed' || c.status === 'declined') {
    s = { state: 'closed', colour: 'idle', title: 'This case is closed', sub: '',
          coach: { tone: 'idle', text: '' } };
  } else if (myBid) {
    s = { state: 'submitted', colour: 'idle',
          title: 'Round ' + round + ' — your figures are locked in',
          sub: 'You cannot change them this round. If your ranges meet, this settles on its own.',
          coach: { tone: 'idle', text: theirBid ? 'Both bids are in — resolving.' : 'Waiting for the other side to bid this round.' } };
  } else if (round > 1) {
    s = { state: 'round_open', colour: 'idle',
          title: 'Round ' + round,
          sub: 'Round ' + (round - 1) + ' closed without a settlement. You can move again — but only toward them.',
          coach: { tone: 'idle', text: 'No deal last round. Move if you want to; nothing about their figure is shown.' } };
  } else {
    s = { state: 'need_bid', colour: 'idle', title: 'Set your three figures to begin',
          sub: role === 'claim'
            ? 'Your ideal, a figure you would consider, and the least you will accept.'
            : 'Your ideal, a figure you would consider, and the most you will pay.',
          coach: { tone: 'idle', text: 'Nothing you set is shown to the other side.' } };
  }

  s.myValue = mine.reservation;
  s.mine    = mine;                 // your own three figures — safe, they are yours
  s.amount  = c.amount;
  s.role    = role;
  s.round   = round;
  s.locked  = !!myBid;              // this round's bid is in and cannot be changed
  s.theirBidIn = !!theirBid;        // that they have bid, never what they bid
  // The one-way rule, sent so the sliders can enforce it before you submit.
  s.limit = prev ? prev.walk : null;
  s.limitText = prev
    ? (role === 'claim'
        ? 'Last round you would accept ' + money(prev.walk, c.currency) + '. You can only come down from there.'
        : 'Last round you would pay ' + money(prev.walk, c.currency) + '. You can only go up from there.')
    : null;
  s.settledValue     = c.settled_value != null ? c.settled_value : null;
  s.settleReason     = c.settle_reason || null;   // 'overlap' | 'band' — for the announcement
  s.mediatorRequested = !!c.mediator_requested;
  s.myDetailsDone    = role === 'claim' ? !!(c.claim_full_name && c.claim_address) : !!(c.resp_full_name && c.resp_address);
  s.bothDetailsDone  = !!(c.claim_full_name && c.claim_address && c.resp_full_name && c.resp_address);
  // Deliberately dead. Kept so any older client reading them degrades to "nothing
  // to see" rather than crashing.
  s.prox   = { level: 'sealed', fill: 0, text: '' };
  s.close  = false;
  s.bothIn = false;
  s.mineApproved = false;
  s.otherApproved = false;
  return s;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Auth ----
// The homepage does the asking now: the scale multiplies, and one row under it
// sends you to the right portal. No interstitial gate.
app.get('/', (req, res) => {
  if (req.session.userId) {
    const acct = res.locals.me && res.locals.me.account_type;
    return res.redirect(acct === 'business' ? '/business' : '/dashboard');
  }
  res.render('home');
});

// The marketing homepage, always reachable even when signed in.
app.get('/home', (req, res) => res.render('home'));

// ---- Business portal ----
app.use('/business', businessRouter);

// ---- Public policy pages ----
app.get('/terms', (req, res) => res.render('terms'));
app.get('/fees', (req, res) => res.render('fees', { currencies: CURRENCIES }));
app.get('/privacy', (req, res) => res.render('privacy'));


app.get('/signup', (req, res) => res.render('signup', { error: null, next: req.query.next || '' }));
app.post('/signup', wrap(async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  const nextUrl = req.body.next || '/dashboard';
  if (!name || !email || pw.length < 6) return res.render('signup', { error: 'Enter a name, email, and a password of at least 6 characters.', next: req.body.next || '' });
  if (await db.userByEmail(email)) return res.render('signup', { error: 'An account with that email already exists. Try logging in.', next: req.body.next || '' });
  const hash = bcrypt.hashSync(pw, 10);
  const id = await db.createUser(email, name, hash);

  // Asking is not the same as getting. They start as an individual either way; the
  // request is recorded for you to approve in Admin > Users. Granting it here would
  // be the old silent-promotion bug wearing a nicer hat.
  const wantsBusiness = req.body.account === 'business';
  if (wantsBusiness) await db.requestBusiness(id, (req.body.company || '').trim());

  mailer.notifyNewSignup({ name, email, wantsBusiness, company: (req.body.company || '').trim() }).catch(() => {});
  mailer.sendWelcome({ name, email }).catch(() => {});          // welcome the user (needs verified domain)
  req.session.userId = id;
  res.redirect(nextUrl);
}));

app.get('/login', (req, res) => res.render('login', { error: null, next: req.query.next || '' }));
app.post('/login', wrap(async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  const nextUrl = req.body.next || '/dashboard';
  const user = await db.userByEmail(email);
  if (!user || !bcrypt.compareSync(pw, user.pw_hash)) return res.render('login', { error: 'Email or password is incorrect.', next: req.body.next || '' });
  if (user.suspended) return res.render('login', { error: 'This account has been suspended. Contact support.', next: req.body.next || '' });
  await db.updateLastLogin(user.id);
  req.session.userId = user.id;
  res.redirect(nextUrl);
}));

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---- Dashboard / cases (user-facing) ----
// The individual workspace: cases you raised as yourself, PLUS every case you
// were invited into. Business-raised cases never appear here — and a case you
// were invited into always does, whoever invited you.
app.get('/dashboard', requireLogin, wrap(async (req, res) => {
  const me = req.session.userId;
  // On this dashboard you may be the claimant on one case and the respondent on
  // another, so the masking has to be per case, per viewer. You see YOUR committed
  // figure and nothing else — the other side's number only ever appears as the
  // agreed amount, once it has settled.
  const cases = (await casesForIndividual(me)).map(decorate).map((c) => Object.assign(c, {
    highest: c.claimant_id === me ? c.claim_value : c.resp_value,   // your own figure
    lowest:  c.status === 'settled' ? c.settled_value : null,       // the deal, if there is one
  }));
  res.render('dashboard', { cases, filter: req.query.filter || 'all' });
}));

app.get('/cases/new', requireLogin, (req, res) => {
  const guess = guessCurrency(req);
  res.render('new-case', { error: null, currencies: CURRENCIES, selectedCurrency: guess, paymentsEnabled: PAYMENTS_ENABLED });
});

// Invite the other party. Used at creation, after the start fee, and by the Send /
// Resend button on the case page.
//
// This used to fire the email with .catch(() => {}) and flip the case to
// 'awaiting_other' regardless — so a case that had never successfully emailed anyone
// still displayed "Waiting for the other party to join". It waited forever, for a
// message that did not exist. The result is now recorded either way.
async function activateCaseAndInvite(req, id) {
  const c = await db.caseById(id);
  const full = await db.caseDetail(id);
  const meEmail = c.claimant_id ? full.claimant_acc_email : full.respondent_acc_email;
  const otherEmail = c.other_email;
  const claimantEmail = c.claimant_id ? meEmail : otherEmail;
  const respondentEmail = c.respondent_id ? meEmail : otherEmail;
  const inviteUrl = baseUrl(req) + '/join/' + c.invite_token;

  if (!otherEmail) {
    await db.markInvited(id, false, 'No email address on this case yet.');
    return { ok: false, error: 'No email address on this case yet.' };
  }

  let res = { ok: false, error: 'Unknown mail error.' };
  try {
    res = (await mailer.notifyCaseInvite(
      { id, title: c.title, amount: c.amount, currency: c.currency, other_email: otherEmail },
      { creatorEmail: meEmail, recipientPosition: c.claimant_id ? 'owe' : 'owed', inviteUrl }
    )) || { ok: true };
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  if (!res.ok) {
    await db.markInvited(id, false, res.error);
    await db.addEvent(id, 'error', 'Invite to ' + otherEmail + ' FAILED — ' + res.error);
    return res;
  }

  await db.setStatus('awaiting_other', id);
  await db.markInvited(id, true);
  await db.addEvent(id, 'invited', 'Invited ' + otherEmail);
  mailer.notifyNewCase({ id, title: c.title, amount: c.amount, currency: c.currency, other_email: otherEmail },
    claimantEmail, respondentEmail).catch(() => {});     // your own copy; not critical
  return { ok: true };
}

// Send, or send again. The other side going quiet is the normal case, not the
// exception, so this has to be a button that is always there.
app.post('/cases/:id/invite', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'No such case.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });
  if (c.respondent_id && c.claimant_id) return res.redirect('/cases/' + c.id);   // already joined
  if (['settled', 'closed', 'declined'].includes(c.status)) return res.redirect('/cases/' + c.id);

  const email = (req.body.email || '').trim();
  if (email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.redirect('/cases/' + c.id + '?msg=' + encodeURIComponent('That does not look like an email address.'));
    }
    await pool.query('UPDATE cases SET other_email=$1 WHERE id=$2', [email, c.id]);
  }

  const r = await activateCaseAndInvite(req, c.id);
  const msg = r.ok
    ? 'Invitation sent to ' + ((email || c.other_email))
    : 'Could not send: ' + r.error;
  res.redirect('/cases/' + c.id + '?msg=' + encodeURIComponent(msg));
}));

app.post('/cases/new', requireLogin, uploadDocs, wrap(async (req, res) => {
  const title = (req.body.title || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const role = req.body.role;
  const currency = curOf(req.body.currency).code;   // validate to a supported currency
  const otherEmail = (req.body.other_email || '').trim().toLowerCase();
  const reshow = (msg) => res.render('new-case', { error: msg, currencies: CURRENCIES, selectedCurrency: curOf(req.body.currency).code, paymentsEnabled: PAYMENTS_ENABLED });
  if (req.uploadError) return reshow(req.uploadError);
  if (!title || !(amount > 0) || !otherEmail || !['owed', 'owe'].includes(role)) return reshow('Please fill in every field with valid values.');
  const token = crypto.randomBytes(16).toString('hex');
  const me = req.session.userId;
  const claimantId = role === 'owed' ? me : null;
  const respondentId = role === 'owe' ? me : null;
  const id = await db.createCase(title, amount, token, claimantId, respondentId, otherEmail, currency);

  // Details for the agreement, captured up front from whoever opens the case.
  // The other side supplies theirs at settlement. Collected here because the
  // creator is already in a form and already paying — it is free friction.
  const clean = (v, n) => (v || '').trim().slice(0, n);
  const myName = clean(req.body.full_name, 200);
  const myAddress = clean(req.body.address, 500);
  if (myName.length >= 2 && myAddress.length >= 6) {
    await db.setPartyDetails(role === 'owed' ? 'claim' : 'resp',
      { fullName: myName, company: clean(req.body.company, 200) || null, address: myAddress }, id);
  }

  const meEmail = res.locals.me ? res.locals.me.email : '';
  await db.addEvent(id, 'created', 'Case created by ' + meEmail + ' (' + (role === 'owed' ? 'claimant' : 'respondent') + ', ' + currency + ')');

  // Attach any supporting documents to the case.
  const files = req.files || [];
  for (const f of files) {
    await db.addDocument(id, me, f.originalname.slice(0, 200), f.mimetype, f.size, f.buffer);
  }
  if (files.length) await db.addEvent(id, 'documents', files.length + ' document' + (files.length === 1 ? '' : 's') + ' attached by ' + meEmail);

  // Charge to start: hold the case until the activation fee is paid, then invite the other party.
  const startFee = curOf(currency).start;
  if (PAYMENTS_ENABLED && startFee > 0) {
    await db.setStatus('pending_payment', id);
    await db.recordMandate(role === 'owed' ? 'claim' : 'resp', MANDATE_VERSION, id);
    return startCheckout(req, res, {
      caseId: id, kind: 'start', role: role === 'owed' ? 'claim' : 'resp',
      amountMajor: startFee, stripeCurrency: curOf(currency).stripe,
      label: 'MidBid — case activation fee',
      successUrl: baseUrl(req) + '/cases/' + id + '/pay/return?kind=start&session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: baseUrl(req) + '/cases/' + id + '/pay/cancel'
    });
  }
  await activateCaseAndInvite(req, id);
  res.redirect('/cases/' + id);
}));

// Return from Stripe Checkout — verify the session, then apply the paid action.
app.get('/cases/:id/pay/return', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const kind = req.query.kind;
  const sid = req.query.session_id;
  if (!PAYMENTS_ENABLED || !sid) return res.redirect('/cases/' + id);
  let ok = false;
  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    ok = s && s.payment_status === 'paid' && s.metadata && s.metadata.caseId === String(id) && s.metadata.kind === kind;
  } catch (_) { ok = false; }
  if (!ok) return res.render('message', { title: 'Payment not completed', body: 'Your payment was not completed, so nothing has been charged. You can try again from the case page.' });
  let sessionObj = null;
  try { sessionObj = await stripe.checkout.sessions.retrieve(sid); } catch (_) {}
  const role = (sessionObj && sessionObj.metadata && sessionObj.metadata.role) || roleOf(await db.caseById(id), req.session.userId);

  if (kind === 'start') {
    if (sessionObj && role) await rememberCardFromSession(sessionObj, id, role);
    await db.markStartFeePaid(id);
    await db.addEvent(id, 'payment', 'Case activation fee paid');
    await activateCaseAndInvite(req, id);
  } else if (kind === 'success') {
    if (sessionObj && role) await rememberCardFromSession(sessionObj, id, role);
    const paidMinor = sessionObj && sessionObj.amount_total ? sessionObj.amount_total : 0;
    if (paidMinor > 0 && role) await creditFeeAndMaybeRelease(req, id, role, paidMinor);
  } else if (kind === 'settlement') {
    await db.markSettlementPaid(id);
    await db.addEvent(id, 'payment', 'Settlement paid — funds routed to the other party');
  }
  res.redirect('/cases/' + id);
}));

app.get('/cases/:id/pay/cancel', requireLogin, wrap(async (req, res) => {
  res.render('message', { title: 'Payment cancelled', body: 'No payment was taken. Your case is saved but not yet active — you can complete the activation payment from your dashboard when ready.' });
}));

// Pay the MidBid service charge. Each party chooses to split it 50/50 or cover it
// in full. Whoever pays, the agreement is released once the total is covered —
// ICC Art. 37-style substitution, so one side's default never strands the other.
//
// There is deliberately no refund path. The fee is for the mediation, and the
// mediation happened (see terms cl. 4.3). A party who pays half and whose
// opponent never pays can top up the balance and take the agreement, then
// recover the difference under the joint and several liability clause.
// ---- Stripe Connect (Stage 1): onboard the party who is OWED so we can pay them out ----
app.post('/cases/:id/payout/onboard', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (role !== 'claim') return res.status(403).render('message', { title: 'No access', body: 'Only the party who is owed sets up payouts.' });
  if (c.status !== 'settled') return res.redirect('/cases/' + id);
  if (!PAYMENTS_ENABLED) return res.redirect('/cases/' + id);

  const base = req.protocol + '://' + req.get('host');
  let acct = c.payee_connect_id;
  if (!acct) {
    const account = await stripe.accounts.create({
      type: 'express',
      capabilities: { transfers: { requested: true } },
      business_type: 'individual',
      metadata: { caseId: String(id) }
    });
    acct = account.id;
    await db.setPayeeConnect(id, acct);
  }
  const link = await stripe.accountLinks.create({
    account: acct,
    refresh_url: base + '/cases/' + id + '/payout/onboard',
    return_url:  base + '/cases/' + id + '/payout/return',
    type: 'account_onboarding'
  });
  res.redirect(303, link.url);
}));

// Stripe returns the payee here after onboarding; refresh their payout status.
app.get('/cases/:id/payout/return', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c) return res.redirect('/dashboard');
  const role = roleOf(c, req.session.userId);
  if (role === 'claim' && c.payee_connect_id && PAYMENTS_ENABLED) {
    try {
      const acct = await stripe.accounts.retrieve(c.payee_connect_id);
      await db.setPayeePayoutsReady(id, !!acct.payouts_enabled);
      if (acct.payouts_enabled) await db.addEvent(id, 'payout', 'Party who is owed completed payout setup');
    } catch (e) { console.error('connect return:', e.message); }
  }
  res.redirect('/cases/' + id);
}));

// ---- Stripe Connect (Stage 2): the PAYER pays; Stripe routes the settlement to
// the payee's connected account and MidBid's fee to us. Redirects to Stripe's
// hosted payment portal (a destination charge). ----
app.post('/cases/:id/pay', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (role !== 'resp') return res.status(403).render('message', { title: 'No access', body: 'Only the party who owes completes the payment.' });
  if (c.status !== 'settled') return res.redirect('/cases/' + id);
  if (!PAYMENTS_ENABLED) return res.redirect('/cases/' + id);
  if (c.settlement_paid_at) return res.redirect('/cases/' + id);
  if (!c.payee_connect_id || !c.payee_payouts_ready) {
    return res.render('message', { title: 'Not ready yet', body: 'The other party has not finished setting up their payout account. We will email you the moment you can pay.' });
  }
  const cur = curOf(c.currency);
  const led = feeLedger(c);
  const feeShareMinor  = led.half;
  const settlementMinor = Math.round((c.settled_value || 0) * 100);
  const totalMinor = settlementMinor + feeShareMinor;
  const base = req.protocol + '://' + req.get('host');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: cur.stripe || 'gbp', unit_amount: totalMinor, product_data: { name: 'Settlement \u2014 ' + (c.title || ('case ' + id)) } } }],
    payment_intent_data: {
      application_fee_amount: feeShareMinor,
      transfer_data: { destination: c.payee_connect_id }
    },
    metadata: { caseId: String(id), kind: 'settlement', role: 'resp' },
    success_url: base + '/cases/' + id + '/pay/return?kind=settlement&session_id={CHECKOUT_SESSION_ID}',
    cancel_url:  base + '/cases/' + id + '/pay/cancel'
  });
  res.redirect(303, session.url);
}));

app.post('/cases/:id/pay/success-fee', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });
  if (c.status !== 'settled') return res.redirect('/cases/' + id);

  const led = feeLedger(c);
  if (led.outstanding === 0) return res.redirect('/cases/' + id);

  // Persist the ledger the first time we quote it, so the figure the party saw
  // is the figure they are charged, even if the fee schedule changes tomorrow.
  if (c.fee_due_minor == null) await db.setFeeLedger(id, led.gross, led.credit, led.due);

  const choice = req.body.choice === 'full' ? 'full' : 'split';
  await db.setFeeChoice(role, choice, id);

  // 'split' pays your half, less anything you have already put in.
  // 'full' clears whatever is left on the case.
  const already = myFeePaid(c, role);
  const amountMinor = choice === 'full'
    ? led.outstanding
    : Math.max(0, Math.min(led.half - already, led.outstanding));

  if (amountMinor <= 0) return res.redirect('/cases/' + id);

  if (!PAYMENTS_ENABLED) {
    await creditFeeAndMaybeRelease(req, id, role, amountMinor);
    return res.redirect('/cases/' + id);
  }

  await db.recordMandate(role, MANDATE_VERSION, id);

  // If we already hold this party's card (the creator, from activation), charge it
  // silently. Otherwise send them through Checkout, which also saves the card.
  const outcome = await chargeSavedCard(c, role, amountMinor,
    'MidBid — service charge, case MB-' + id);

  if (outcome === 'paid') {
    await creditFeeAndMaybeRelease(req, id, role, amountMinor);
    return res.redirect('/cases/' + id);
  }
  if (outcome === 'failed') {
    await db.addEvent(id, 'payment', 'Card declined for ' + (role === 'claim' ? 'claimant' : 'respondent'));
  }
  // no_card, needs_action, or a decline — fall back to an on-session Checkout.
  return startCheckout(req, res, {
    caseId: id, kind: 'success', role, amountMajor: toMajor(amountMinor),
    stripeCurrency: curOf(c.currency).stripe,
    label: 'MidBid — service charge (case MB-' + id + ')',
    successUrl: baseUrl(req) + '/cases/' + id + '/pay/return?kind=success&session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: baseUrl(req) + '/cases/' + id + '/pay/cancel'
  });
}));

// Request a human mediator (escalation lead — MidBid follows up to arrange).
app.post('/cases/:id/mediator', requireLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.caseById(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  await db.setMediatorRequested(id, role);
  await db.addEvent(id, 'mediator', (role === 'claim' ? 'Claimant' : 'Respondent') + ' requested a human mediator');
  const full = await db.caseDetail(id);
  if (mailer.notifyMediatorRequest) {
    mailer.notifyMediatorRequest({ id, title: c.title, amount: c.amount }, full.claimant_acc_email, full.respondent_acc_email, role).catch(() => {});
  }
  res.json({ ok: true, mediatorRequested: true });
}));

app.get('/join/:token', wrap(async (req, res) => {
  const c = await db.caseByToken(req.params.token);
  if (!c) return res.status(404).render('message', { title: 'Invitation not found', body: 'This invitation link is not valid.' });
  if (req.session.userId && roleOf(c, req.session.userId)) return res.redirect('/cases/' + c.id);
  if (c.status === 'settled' || c.status === 'closed') return res.render('message', { title: 'This case is closed', body: 'This invitation is no longer open.' });
  res.render('join', { c });
}));
app.post('/join/:token', requireLogin, wrap(async (req, res) => {
  const c = await db.caseByToken(req.params.token);
  if (!c) return res.status(404).render('message', { title: 'Invitation not found', body: 'This invitation link is not valid.' });
  if (roleOf(c, req.session.userId)) return res.redirect('/cases/' + c.id);
  const me = req.session.userId;
  const meEmail = res.locals.me ? res.locals.me.email : '';
  if (c.claimant_id == null) { await db.setClaimant(me, 'active', c.id); await db.addEvent(c.id, 'joined', 'Claimant joined (' + meEmail + ')'); }
  else if (c.respondent_id == null) { await db.setRespondent(me, 'active', c.id); await db.addEvent(c.id, 'joined', 'Respondent joined (' + meEmail + ')'); }
  else return res.status(403).render('message', { title: 'Case is full', body: 'Both sides of this case are already taken.' });
  // Tell the person who created the case that the other party accepted
  const full = await db.caseDetail(c.id);
  const creatorEmail = c.claimant_id != null ? full.claimant_acc_email : full.respondent_acc_email;
  mailer.notifyCaseAccepted({ id: c.id, title: c.title, amount: c.amount, currency: c.currency }, creatorEmail).catch(() => {});
  res.redirect('/cases/' + c.id);
}));

// DELIBERATE CHANGE: this no longer settles the case on its own.
//
// It used to mark a case 'settled' the moment the figures crossed, with no
// approval from either party. That meant a binding compromise could arise from
// the bidding process itself — which would gut the "subject to contract" clause
// and leave the condition precedent guarding a door that was already open.
//
// Convergence is now only a signal. Nothing settles until BOTH sides approve,
// in /cases/:id/approve. Revert at your peril.
async function maybeSettle(id) {
  const u = await db.caseById(id);
  if (u.claim_value != null && u.resp_value != null && u.resp_value >= u.claim_value) {
    await db.addEvent(u.id, 'converged', 'Figures converged — both sides may now approve');
  }
}

// Put a user into the open slot AND record their opening figure in one step.
async function joinWithFigure(c, userId, userEmail, rawValue) {
  let role;
  if (c.claimant_id == null) { await db.setClaimant(userId, 'active', c.id); role = 'claim'; await db.addEvent(c.id, 'joined', 'Claimant joined (' + userEmail + ')'); }
  else if (c.respondent_id == null) { await db.setRespondent(userId, 'active', c.id); role = 'resp'; await db.addEvent(c.id, 'joined', 'Respondent joined (' + userEmail + ')'); }
  else return { full: true };
  let v = parseInt(rawValue, 10);
  if (!(v >= 0)) v = 0;
  if (v > c.amount) v = c.amount;
  if (role === 'claim') await db.setClaimValue(v, c.id); else await db.setRespValue(v, c.id);
  await db.addEvent(c.id, 'bid', (role === 'claim' ? 'Claimant' : 'Respondent') + ' set an opening figure');
  const full = await db.caseDetail(c.id);
  const creatorEmail = c.claimant_id != null ? full.claimant_acc_email : full.respondent_acc_email;
  mailer.notifyCaseAccepted({ id: c.id, title: c.title, amount: c.amount, currency: c.currency }, creatorEmail).catch(() => {});
  await maybeSettle(c.id);
  return { role };
}

// The slider's "Continue with <amount>" button posts here. Choosing a figure = accepting.
app.post('/join/:token/accept', wrap(async (req, res) => {
  const c = await db.caseByToken(req.params.token);
  if (!c) return res.status(404).render('message', { title: 'Invitation not found', body: 'This invitation link is not valid.' });
  if (c.status === 'settled' || c.status === 'closed') return res.render('message', { title: 'This case is closed', body: 'This invitation is no longer open.' });
  const value = req.body.value;
  if (req.session.userId) {
    if (roleOf(c, req.session.userId)) return res.redirect('/cases/' + c.id);
    const meEmail = res.locals.me ? res.locals.me.email : '';
    const r = await joinWithFigure(c, req.session.userId, meEmail, value);
    if (r.full) return res.status(403).render('message', { title: 'Case is full', body: 'Both sides of this case are already taken.' });
    return res.redirect('/cases/' + c.id);
  }
  // Not logged in: carry their figure into a quick "set a password" finish-signup step.
  res.render('signup-invite', { c, value: value, error: null });
}));

// Finish signup from an invite, then join + record the figure in one go.
app.post('/invite/:token/signup', wrap(async (req, res) => {
  const c = await db.caseByToken(req.params.token);
  if (!c) return res.status(404).render('message', { title: 'Invitation not found', body: 'This invitation link is not valid.' });
  if (c.status === 'settled' || c.status === 'closed') return res.render('message', { title: 'This case is closed', body: 'This invitation is no longer open.' });
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const pw = req.body.password || '';
  const value = req.body.value;
  if (!name || !email || pw.length < 6) return res.render('signup-invite', { c, value, error: 'Enter your name and a password of at least 6 characters.' });
  if (await db.userByEmail(email)) return res.render('signup-invite', { c, value, error: 'An account with that email already exists. Please log in first, then open this invite again to join.' });
  const hash = bcrypt.hashSync(pw, 10);
  const id = await db.createUser(email, name, hash);
  mailer.notifyNewSignup({ name, email }).catch(() => {});
  req.session.userId = id;
  const r = await joinWithFigure(c, id, email, value);
  if (r.full) return res.status(403).render('message', { title: 'Case is full', body: 'Both sides of this case are already taken.' });
  res.redirect('/cases/' + c.id);
}));

// Decline an invitation. Uses POST (a confirmation button on the join page), so email
// link-prefetchers can never decline a case by accident.
app.post('/decline/:token', wrap(async (req, res) => {
  const c = await db.caseByToken(req.params.token);
  if (!c) return res.status(404).render('message', { title: 'Invitation not found', body: 'This invitation link is not valid.' });
  if (c.status === 'settled' || c.status === 'closed') return res.render('message', { title: 'Already closed', body: 'This case is no longer open.' });
  await db.setStatus('declined', c.id);
  await db.addEvent(c.id, 'declined', 'Invitation declined by ' + (c.other_email || 'the other party'));
  const full = await db.caseDetail(c.id);
  const creatorEmail = c.claimant_id != null ? full.claimant_acc_email : full.respondent_acc_email;
  mailer.notifyCaseDeclined({ id: c.id, title: c.title, amount: c.amount, currency: c.currency, other_email: c.other_email }, creatorEmail).catch(() => {});
  res.render('message', { title: 'Invitation declined', body: 'Thanks — we\'ve let the other party know that you\'ve declined this case. Nothing further will happen.' });
}));

app.get('/cases/:id', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });
  const status = await viewerStatus(c, role);
  const inviteUrl = req.protocol + '://' + req.get('host') + '/join/' + c.invite_token;
  const led = c.status === 'settled' ? feeLedger(c) : null;
  const pay = {
    enabled: PAYMENTS_ENABLED,
    released: agreementReleasable(c),
    fee: led,
    myPaid: myFeePaid(c, role),
    myPaidLabel: money(toMajor(myFeePaid(c, role)), c.currency),
    myChoice: role === 'claim' ? c.claim_fee_choice : c.resp_fee_choice,
    hasCard: !!myCard(c, role).pm,
    // What the other side chose or paid is never sent to this template.
    successFeePaid: agreementReleasable(c),
    mediatorRequested: !!c.mediator_requested,
    mediatorNote: MEDIATOR_FEE_NOTE
  };
  const docs = await db.documentsForCase(c.id);
  const myDetailsDone = role === 'claim' ? !!(c.claim_full_name && c.claim_address) : !!(c.resp_full_name && c.resp_address);
  const bothDetailsDone = !!(c.claim_full_name && c.claim_address && c.resp_full_name && c.resp_address);
  res.render('case', { c, role, status, inviteUrl, pay, cur: curOf(c.currency), docs, myDetailsDone, bothDetailsDone, payeeOnboarded: !!c.payee_payouts_ready, settlementPaid: !!c.settlement_paid_at,
    agreementRequested: !!c.agreement_requested_at,
    msg: req.query.msg || null });
}));

app.post('/cases/:id/bid', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  if (['settled', 'closed', 'declined'].includes(c.status)) return res.json(await viewerStatus(c, role));

  const party = role === 'claim' ? 'claimant' : 'respondent';
  const round = c.round || 1;

  // The lock. One bid per party per round — no edits, no re-saves. This is the
  // whole fix: a figure you can revise for free is a probe, not a bid.
  if (await db.bidFor(c.id, party, round)) {
    return res.status(409).json({ error: 'Your figures for round ' + round + ' are locked in. Wait for the other side.' });
  }

  const A = c.amount;
  const clamp = (raw) => { let v = parseInt(raw, 10); if (!(v >= 0)) v = 0; if (v > A) v = A; return v; };
  let ideal = clamp(req.body.ideal);
  let fair  = clamp(req.body.fair);
  let resv  = clamp(req.body.reservation);

  if (role === 'claim') { fair = Math.max(resv, fair); ideal = Math.max(fair, ideal); }
  else                  { fair = Math.min(resv, fair); ideal = Math.min(fair, ideal); }

  // One-way movement. Without this you could bid low, get "no deal", and jump
  // back up — learning a free upper bound on their figure. A concession has to
  // be a concession.
  const prev = await db.lastBid(c.id, party);
  if (prev) {
    if (role === 'claim' && resv > prev.walk) {
      return res.status(400).json({ error: 'Your walk-away can only come down. Last round you would accept ' + money(prev.walk, c.currency) + '.' });
    }
    if (role === 'resp' && resv < prev.walk) {
      return res.status(400).json({ error: 'Your ceiling can only go up. Last round you would pay ' + money(prev.walk, c.currency) + '.' });
    }
  }

  try {
    await db.addBid(c.id, party, round, ideal, fair, resv);
  } catch (e) {
    // The unique index caught a double submit that slipped past the check above.
    return res.status(409).json({ error: 'Your figures for this round are already in.' });
  }
  if (role === 'claim') await db.setClaimAnchors(ideal, fair, resv, c.id);
  else                  await db.setRespAnchors(ideal, fair, resv, c.id);
  await db.addEvent(c.id, 'bid', (role === 'claim' ? 'Claimant' : 'Respondent') + ' submitted round ' + round);

  const bids = await db.bidsInRound(c.id, round);
  if (bids.length < 2) {
    return res.json(await viewerStatus(await db.caseById(c.id), role));   // -> "locked in, waiting"
  }

  // Both are in: the round resolves now. Settlement is automatic, because asking
  // you to approve would mean first telling you that you are close — and that
  // message is the leak we are removing.
  const cl = bids.find((b) => b.party === 'claimant');
  const rp = bids.find((b) => b.party === 'respondent');
  // Two ways a round settles:
  //   1. Overlap — the respondent's ceiling reaches the claimant's floor. A real deal.
  //   2. Within 5% of each other — the two walk-aways are close enough that MidBid
  //      closes the last sliver automatically, at the midpoint.
  //
  // The 5% band is measured against the SMALLER of the two figures (the tighter,
  // more defensible reading of "within 5% of each other"). NOTE: this can settle a
  // party a little past the number they set as their limit — that is the deliberate
  // tradeoff of a proximity band, chosen knowingly. See SETTLEMENT-RULES.md.
  const SETTLE_BAND = 0.05;
  const overlap = rp.walk >= cl.walk;
  const gap = Math.abs(cl.walk - rp.walk);
  const smaller = Math.min(cl.walk, rp.walk);
  const withinBand = smaller > 0 && (gap <= SETTLE_BAND * smaller);

  if (overlap || withinBand) {
    const value = Math.round((cl.walk + rp.walk) / 2);
    const reason = overlap ? 'overlap' : 'band';
    await db.settle('settled', value, c.id);
    await db.addEvent(c.id, 'settled',
      'Round ' + round + (overlap
        ? ' — ranges met. Settled at ' + money(value, c.currency)
        : ' — figures within 5% of each other. Settled at ' + money(value, c.currency)));
    // record WHY, so the announcement can say it (without ever showing the figures)
    try { await pool.query('UPDATE cases SET settle_reason=$1 WHERE id=$2', [reason, c.id]); } catch (e) {}
    const full = await db.caseDetail(c.id);
    mailer.notifySettled(
      { id: full.id, title: full.title, settled_value: value, currency: full.currency, other_email: full.other_email },
      full.claimant_acc_email, full.respondent_acc_email).catch(() => {});
  } else {
    await db.bumpRound(c.id);
    await db.addEvent(c.id, 'round', 'Round ' + round + ' closed — no settlement');
    const full = await db.caseDetail(c.id);
    mailer.notifyRoundClosed(full, round, full.claimant_acc_email, full.respondent_acc_email).catch(() => {});
  }
  res.json(await viewerStatus(await db.caseById(c.id), role));
}));

// Approval no longer exists. Under sealed bidding your submitted figure IS the
// commitment — "I will settle at anything at or beyond this" — so a round that
// overlaps settles itself. Kept as a route only so an old cached page gets a
// sensible answer instead of a 404.
app.post('/cases/:id/approve', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  return res.status(400).json(Object.assign(await viewerStatus(c, role),
    { error: 'Settlement is automatic now — if your ranges meet, the round settles itself.' }));
}));

app.get('/cases/:id/status', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  res.json(await viewerStatus(c, role));
}));

// After both sides settle, each party fills in the details needed to name them
// properly on the agreement.
app.post('/cases/:id/party-details', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  if (c.status !== 'settled') return res.status(400).json({ error: 'not settled' });
  const clean = (v, n) => (v || '').trim().slice(0, n);
  const fullName = clean(req.body.full_name, 200);
  const company = clean(req.body.company, 200);
  const address = clean(req.body.address, 500);
  if (fullName.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
  if (address.length < 6) return res.status(400).json({ error: 'Please enter your address.' });
  await db.setPartyDetails(role, { fullName, company: company || null, address }, c.id);
  await db.addEvent(c.id, 'details', (role === 'claim' ? 'Claimant' : 'Respondent') + ' added their details for the agreement');
  const fresh = await db.caseById(c.id);
  const bothIn = !!(fresh.claim_full_name && fresh.claim_address && fresh.resp_full_name && fresh.resp_address);
  res.json({ ok: true, bothIn });
}));

// Escrow has been removed from the flow. MidBid never holds the settlement money —
// the parties settle the agreed sum directly, and MidBid only collects its service
// charge (see /cases/:id/pay/success-fee). Any old link to /escrow just lands the
// party back on their case page.
app.get('/cases/:id/escrow', requireLogin, (req, res) => {
  res.redirect('/cases/' + Number(req.params.id));
});

// Supporting documents: only the parties (or an admin) may list or download them.
async function guardCase(req, res) {
  const c = await db.caseById(Number(req.params.id));
  if (!c) { res.status(404).json({ error: 'not found' }); return null; }
  const role = roleOf(c, req.session.userId);
  if (!role && !res.locals.isAdmin) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// A party asks MidBid to prepare a formal settlement agreement, uploading the case
// papers with the request. The uploaded files are stored against the case (same table
// as any other case document); MidBid is notified to prepare the agreement by hand.
// This is the deliberate alternative to auto-generating a contract per jurisdiction.
app.post('/cases/:id/agreement/request', requireLogin, uploadDocs, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });

  const me = req.session.userId;
  let saved = 0;
  if (Array.isArray(req.files)) {
    for (const f of req.files) {
      await db.addDocument(c.id, me, f.originalname.slice(0, 200), f.mimetype, f.size, f.buffer);
      saved++;
    }
  }
  const note = (req.body.note || '').trim().slice(0, 1000);
  await db.markAgreementRequested(c.id);
  await db.addEvent(c.id, 'agreement', 'Settlement agreement requested' + (saved ? ' with ' + saved + ' document(s)' : '') + (note ? ' — note: ' + note : ''));
  if (mailer.notifyAgreementRequest) {
    const full = await db.caseDetail(c.id);
    mailer.notifyAgreementRequest(full, saved, note).catch(() => {});
  }
  res.redirect('/cases/' + c.id + '?msg=' + encodeURIComponent('Your settlement agreement request is in — we\'ll be in touch with next steps.'));
}));

app.get('/cases/:id/documents', requireLogin, wrap(async (req, res) => {
  const c = await guardCase(req, res); if (!c) return;
  res.json(await db.documentsForCase(c.id));
}));

app.get('/cases/:id/documents/:docId', requireLogin, wrap(async (req, res) => {
  const c = await guardCase(req, res); if (!c) return;
  const doc = await db.documentById(Number(req.params.docId), c.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', 'inline; filename="' + doc.filename.replace(/"/g, '') + '"');
  res.send(doc.data);
}));

// A printable settlement agreement, available to either party once
// the case is agreed. Built as a standalone page so it prints / saves to PDF.
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function agreementHtml(c) {
  const cur = curOf(c.currency);
  const claimant = c.claim_full_name || c.claimant_name || c.claimant_acc_email || 'Claimant';
  const respondent = c.resp_full_name || c.respondent_name || c.respondent_acc_email || c.other_email || 'Respondent';
  const amount = money(c.amount, c.currency);
  const agreed = money(c.settled_value, c.currency);
  const today = fmtDay(c.settled_at || new Date());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settlement Agreement — MB-${c.id}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#1b1b1b;max-width:760px;margin:2.5rem auto;padding:0 1.5rem;line-height:1.6}
  h1{font-size:1.5rem;text-align:center;margin-bottom:.2rem}
  .ref{text-align:center;color:#555;margin-bottom:2rem;font-size:.9rem}
  h2{font-size:1.05rem;margin-top:1.8rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
  .parties p{margin:.3rem 0}
  ol li{margin:.5rem 0}
  .sign{display:flex;gap:2rem;margin-top:3rem;flex-wrap:wrap}
  .sign div{flex:1;min-width:220px}
  .line{border-top:1px solid #333;margin-top:2.5rem;padding-top:.3rem;font-size:.85rem;color:#444}
  .note{margin-top:2.5rem;font-size:.8rem;color:#777;border-top:1px dashed #ccc;padding-top:1rem}
  .btns{margin:1.5rem 0;text-align:center}
  button,a.btn{font-family:Arial,sans-serif;font-size:.9rem;padding:.5rem 1rem;border:1px solid #888;border-radius:6px;background:#f4f4f4;cursor:pointer;text-decoration:none;color:#222}
  @media print{.btns{display:none}}
</style></head><body>
  <div class="btns"><button onclick="window.print()">Print / Save as PDF</button> <a class="btn" href="/cases/${c.id}">← Back to case</a></div>
  <h1>Settlement Agreement</h1>
  <div class="ref">Case reference MB-${c.id} — ${escapeHtml(c.title)}</div>

  <p>This agreement is made on <strong>${escapeHtml(today)}</strong> between:</p>
  <div class="parties">
    <p><strong>${escapeHtml(claimant)}</strong>${c.claim_company ? ', of ' + escapeHtml(c.claim_company) : ''} (the "Claimant"), and</p>
    ${c.claim_address ? '<p style="margin-left:1.2rem;color:#444">' + escapeHtml(c.claim_address) + '</p>' : ''}
    <p><strong>${escapeHtml(respondent)}</strong>${c.resp_company ? ', of ' + escapeHtml(c.resp_company) : ''} (the "Respondent"),</p>
    ${c.resp_address ? '<p style="margin-left:1.2rem;color:#444">' + escapeHtml(c.resp_address) + '</p>' : ''}
    <p>together the "Parties".</p>
  </div>

  <h2>1. Background</h2>
  <p>The Parties were in dispute over a sum of up to ${amount}. They have used MidBid's blind-bid process to negotiate, and each Party has independently approved the settlement figure set out below.</p>

  <h2>2. Settlement</h2>
  <ol>
    <li>The Parties agree to settle the dispute in full for the sum of <strong>${agreed}</strong> (the "Settlement Sum"), payable by the Respondent to the Claimant.</li>
    <li>The Settlement Sum is to be paid within 14 days of the date of this agreement, unless the Parties agree otherwise in writing.</li>
    <li>On payment of the Settlement Sum, the Parties release and discharge one another from all claims arising out of or in connection with the matters described above.</li>
  </ol>

  <h2>3. General</h2>
  <ol>
    <li>This agreement is in full and final settlement of the dispute and may be relied upon by either Party.</li>
    <li>This agreement is governed by ${cur.law} and the Parties submit to the exclusive jurisdiction of ${cur.courts}.</li>
    <li>This agreement may be signed in counterparts, each of which is an original.</li>
  </ol>

  <div class="sign">
    <div><div class="line">Signed by the Claimant — ${escapeHtml(claimant)}</div></div>
    <div><div class="line">Signed by the Respondent — ${escapeHtml(respondent)}</div></div>
  </div>

  <p class="note">This document is a draft produced automatically from the agreed figure to help the Parties record their settlement. It is not legal advice. Both Parties should review it, and seek independent legal advice, before signing.</p>
</body></html>`;
}

app.get('/cases/:id/agreement', requireLogin, wrap(async (req, res) => {
  const c = await db.caseDetail(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role && !res.locals.isAdmin) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });
  if (c.status !== 'settled') return res.status(400).render('message', { title: 'Not yet agreed', body: 'A settlement agreement can be created once both sides have approved the figure.' });
  if (!agreementReleasable(c) && !res.locals.isAdmin) {
    return res.status(402).render('message', {
      title: 'Service charge outstanding',
      body: 'The settlement agreement is released once the MidBid service charge has been paid in full. You can pay your share, or cover the balance, from the case page.'
    });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(agreementHtml(c));
}));

// ============================ ADMIN PORTAL ============================
app.get('/admin', requireLogin, requireAdmin, wrap(async (req, res) => {
  const counts = await db.counts();
  const recent = await db.recentActivity(14);
  let usersDay = [], casesDay = [], avgSecs = 0;
  try { usersDay = await db.perDay('users', 14); } catch (e) { console.error('perDay users:', e.message); }
  try { casesDay = await db.perDay('cases', 14); } catch (e) { console.error('perDay cases:', e.message); }
  try { avgSecs = await db.avgSettleSeconds(); } catch (e) { console.error('avgSettle:', e.message); }
  const settlementRate = Number(counts.cases) > 0 ? Math.round(Number(counts.settled) / Number(counts.cases) * 100) : 0;
  res.render('admin', { counts, recent, usersDay, casesDay, settlementRate, avgSettle: humanDuration(avgSecs) });
}));

app.get('/admin/users', requireLogin, requireAdmin, wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  const users = await db.listUsers(q);
  res.render('admin-users', { users, q, ADMIN_EMAIL });
}));
app.post('/admin/users/:id/suspend', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setSuspended(Number(req.params.id), true); res.redirect('/admin/users'); }));
app.post('/admin/users/:id/unsuspend', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setSuspended(Number(req.params.id), false); res.redirect('/admin/users'); }));
// Business portal access. Not self-serve: you grant it, having looked at how many
// cases the account actually has. The Cases column on this page is the evidence.
app.post('/admin/users/:id/business', requireLogin, requireAdmin, wrap(async (req, res) => {
  const on = req.body.on === '1';
  await pool.query('UPDATE users SET account_type=$1 WHERE id=$2', [on ? 'business' : 'individual', Number(req.params.id)]);
  res.redirect('/admin/users');
}));

app.post('/admin/users/:id/reset', requireLogin, requireAdmin, wrap(async (req, res) => {
  const u = await db.userById(Number(req.params.id));
  if (!u) return res.redirect('/admin/users');
  const temp = crypto.randomBytes(4).toString('hex');
  await db.setPassword(Number(req.params.id), bcrypt.hashSync(temp, 10));
  res.render('message', { title: 'Temporary password set', body: 'New temporary password for ' + u.email + ' is:  ' + temp + '  — share it with them and ask them to change it.' });
}));
app.post('/admin/users/:id/delete', requireLogin, requireAdmin, wrap(async (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.render('message', { title: 'Cannot delete yourself', body: 'You are signed in as this account.' });
  await db.deleteUserCascade(Number(req.params.id));
  res.redirect('/admin/users');
}));

app.get('/admin/cases', requireLogin, requireAdmin, wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  const cases = await db.allCases(q);
  res.render('admin-cases', { cases, q });
}));
app.get('/admin/cases/:id', requireLogin, requireAdmin, wrap(async (req, res) => {
  const c = await db.caseDetail(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'No such case.' });
  const events = await db.eventsForCase(c.id);
  const docs = await db.documentsForCase(c.id);
  res.render('admin-case', { c, events, docs });
}));
app.post('/admin/cases/:id/close', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setStatus('closed', Number(req.params.id)); await db.addEvent(Number(req.params.id), 'closed', 'Closed by admin'); res.redirect('/admin/cases/' + req.params.id); }));
app.post('/admin/cases/:id/reopen', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setStatus('active', Number(req.params.id)); await db.addEvent(Number(req.params.id), 'reopened', 'Reopened by admin'); res.redirect('/admin/cases/' + req.params.id); }));

app.get('/admin/cases/:id/documents/:docId', requireLogin, requireAdmin, wrap(async (req, res) => {
  const doc = await db.documentById(Number(req.params.docId), Number(req.params.id));
  if (!doc) return res.status(404).send('Not found');
  const safe = doc.filename.replace(/"/g, '');
  const mode = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', mode + '; filename="' + safe + '"');
  res.send(doc.data);
}));

app.get('/admin/cases/:id/settlement.txt', requireLogin, requireAdmin, wrap(async (req, res) => {
  const c = await db.caseDetail(Number(req.params.id));
  if (!c) return res.status(404).send('Not found');
  const lines = [
    'MidBid — Settlement summary', '===========================', '',
    'Case ID:            MB-' + c.id,
    'Title:              ' + c.title,
    'Amount in dispute:  ' + money(c.amount, c.currency),
    'Claimant (owed):    ' + (c.claimant_acc_email || '—'),
    'Respondent (owes):  ' + (c.respondent_acc_email || c.other_email || '—'),
    'Status:             ' + statusText(c),
    'Settlement amount:  ' + (c.settled_value != null ? money(c.settled_value, c.currency) : '—'),
    'Created:            ' + fmtDate(c.created_at),
    'Settled:            ' + fmtDate(c.settled_at)
  ];
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MB-' + c.id + '-settlement.txt"');
  res.send(lines.join('\n'));
}));

function csvCell(v) { const s = String(v == null ? '' : v); return '"' + s.replace(/"/g, '""') + '"'; }
app.get('/admin/cases.csv', requireLogin, requireAdmin, wrap(async (req, res) => {
  const rows = await db.allCases('');
  const head = ['ID', 'Title', 'Amount', 'Claimant', 'Respondent', 'Status', 'Progress%', 'SettledAmount', 'Created', 'Settled'];
  const out = [head.map(csvCell).join(',')];
  for (const c of rows) out.push([
    'MB-' + c.id, c.title, c.amount, c.claimant_acc_email || '', c.respondent_acc_email || c.other_email || '',
    statusText(c), progressFor(c), c.settled_value || '', fmtDate(c.created_at), fmtDate(c.settled_at)
  ].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="midbid-cases.csv"');
  res.send(out.join('\n'));
}));
app.get('/admin/users.csv', requireLogin, requireAdmin, wrap(async (req, res) => {
  const rows = await db.listUsers('');
  const head = ['Name', 'Email', 'Joined', 'Status', 'LastLogin', 'Cases'];
  const out = [head.map(csvCell).join(',')];
  for (const u of rows) out.push([
    u.name, u.email, fmtDate(u.created_at), u.suspended ? 'Suspended' : 'Active', fmtDate(u.last_login), u.case_count
  ].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="midbid-users.csv"');
  res.send(out.join('\n'));
}));

init()
  .then(() => initBusiness())
  .then(() => app.listen(PORT, () => console.log('MidBid running on http://localhost:' + PORT)))
  .catch((err) => { console.error('Database setup failed:', err); process.exit(1); });
