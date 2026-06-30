'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { pool, db, init } = require('./db');
const mailer = require('./mailer');

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
    'dashboard','home','join','login','message','new-case','signup','signup-invite'];
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
const CLOSE_THRESHOLD = 0.10;                                   // "within 10% of the amount in dispute"
const FAIR_THRESHOLD  = 0.15;                                   // softer "within 15%" highlight on the middle (Fair) anchors
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'midbid.settle@gmail.com').toLowerCase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
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
  return gap <= CLOSE_THRESHOLD * c.amount ? 80 : 60;
}
function statusText(c) {
  if (c.status === 'settled') return 'Settled at £' + fmt(c.settled_value);
  if (c.status === 'closed') return 'Closed';
  if (c.status === 'declined') return 'Declined by the other party';
  if (c.status === 'awaiting_other') return 'Waiting for the other party';
  const cb = c.claim_value != null, rb = c.resp_value != null;
  if (!cb && !rb) return 'Both sides to enter a figure';
  if (!rb) return "Waiting for respondent's figure";
  if (!cb) return "Waiting for claimant's figure";
  const gap = c.claim_value - c.resp_value;
  return gap <= CLOSE_THRESHOLD * c.amount ? 'Within 10% — close to a deal' : 'Both bid — still apart';
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
    res.locals.fmt = fmt;
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
function proximity(c) {
  const A = c.amount || 1;
  const cFloor = c.claim_value, rCeil = c.resp_value;
  const cFair = c.claim_fair,  rFair = c.resp_fair;
  const resIn  = cFloor != null && rCeil != null;
  const fairIn = cFair  != null && rFair != null;
  if (!resIn) return { level: 'pending', fill: 0, canApprove: false };

  const overlap = rCeil >= cFloor;                 // ranges meet -> settlement available
  const resGap  = (cFloor - rCeil) / A;            // >0 still apart, <=0 overlap (walk-aways)
  const fairGap = fairIn ? Math.abs(cFair - rFair) / A : null;

  if (overlap)                       return { level: 'overlap', fill: 1.00, canApprove: true };
  if (resGap <= CLOSE_THRESHOLD)     return { level: 'close',   fill: 0.85, canApprove: true };   // within 10% on walk-aways
  if (fairGap != null && fairGap <= FAIR_THRESHOLD)
                                     return { level: 'near',    fill: 0.62, canApprove: false };  // within 15% on the Fair figures
  if (resGap <= 0.30)                return { level: 'apart',   fill: 0.40, canApprove: false };
  return { level: 'far', fill: 0.20, canApprove: false };
}

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
function coachNudge(c, role) {
  const A = c.amount || 0;
  const claim = c.claim_value;            // claimant: the least they'll accept
  const resp  = c.resp_value;             // respondent: the most they'll pay
  const mine  = role === 'claim' ? claim : resp;
  const bothIn = claim != null && resp != null;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // --- Before both figures are in: coach on YOUR position only ---
  if (!bothIn) {
    if (mine == null) {
      return role === 'claim'
        ? { tone: 'idle', text: pick([
            "A common opening is around 80% of the amount — it leaves room to move.",
            "Tip: start near 80% of the value rather than the very top. It signals you're here to settle."
          ]) }
        : { tone: 'idle', text: pick([
            "A common opening is around 20–40% of the amount — low, but not so low it stalls things.",
            "Tip: open with a little room to climb. Offers that start too low tend to freeze the other side."
          ]) };
    }
    if (role === 'claim' && mine >= 0.9 * A)
      return { tone: 'warn', text: "You're aiming near the very top. Most cases that settle start closer to 80% — worth a thought." };
    if (role === 'resp' && mine <= 0.1 * A)
      return { tone: 'warn', text: "That's a very low opening. Nudging it up a little tends to get things moving." };
    return { tone: 'idle', text: "You're in. Sit tight — nothing about your figure is shared." };
  }

  // --- Both walk-aways in: coach on the BAND (never reveals their number) ---
  const p = proximity(c);
  if (p.level === 'overlap') return { tone: 'deal',  text: "Your ranges meet — you can settle. Nice work." };
  if (p.level === 'close')   return { tone: 'close', text: pick([
    "You're nearly there — a small move closes this.",
    "So close. A lawyer would take more than this gap in fees anyway — worth finishing here."
  ]) };
  if (p.level === 'near')    return { tone: 'close', text: pick([
    "Your realistic figures are within about 15% — one step from each side does it.",
    "Within reach now — your middle figures are close. Want to meet around there?"
  ]) };
  if (p.level === 'apart')   return { tone: 'warn',  text: pick([
    "Some distance left — try a slightly bigger move this round.",
    "You might still be a fair way apart on the figure that binds."
  ]) };
  return { tone: 'warn', text: pick([
    "You might be stretching this a little — big gaps rarely settle on their own.",
    "Quite far apart right now. A bolder move could be what unlocks it."
  ]) };
}

// The blind-bid brain: returns ONLY what the asking side may see.
function viewerStatus(c, role) {
  const p = proximity(c);                                  // coarse, safe band
  const mine = role === 'claim'
    ? { ideal: c.claim_ideal, fair: c.claim_fair, reservation: c.claim_value }
    : { ideal: c.resp_ideal,  fair: c.resp_fair,  reservation: c.resp_value };
  const myValue = mine.reservation;                        // the binding walk-away figure
  const bothIn = c.claim_value != null && c.resp_value != null;
  const close = p.canApprove;                              // overlap OR within 10% on walk-aways
  const mineApproved = role === 'claim' ? !!c.claim_approved : !!c.resp_approved;
  const otherApproved = role === 'claim' ? !!c.resp_approved : !!c.claim_approved;
  let s;
  if (c.status === 'settled') s = { state: 'settled', colour: 'deal', title: 'Agreed at £' + fmt(c.settled_value), sub: 'Both sides approved. This is your agreed settlement.' };
  else if (myValue == null) s = { state: 'need_bid', colour: 'idle', title: 'Set your three figures to begin', sub: role === 'claim' ? 'Your ideal, a figure you would consider, and the least you will accept.' : 'Your ideal, a figure you would consider, and the most you will pay.' };
  else if (!bothIn) s = { state: 'waiting', colour: 'idle', title: 'Waiting for the other side', sub: 'You are in. Nothing is revealed until your figures are close.' };
  else if (close) s = { state: 'close', colour: 'close', title: p.level === 'overlap' ? 'Your ranges meet — you can approve' : "Within 10% — you can approve", sub: 'Either side can approve to settle.' };
  else if (p.level === 'near') s = { state: 'near', colour: 'close', title: 'Within ~15% — nearly there', sub: 'Close the last gap on your walk-away figure to settle.' };
  else s = { state: 'far', colour: 'idle', title: 'No signal yet', sub: 'Keep adjusting — nothing leaks while you are apart.' };
  s.myValue = myValue;
  s.mine = mine;                          // this viewer's own three anchors (safe — they are theirs)
  s.amount = c.amount;
  s.role = role;
  s.bothIn = bothIn;
  s.close = close;
  s.prox = { level: p.level, fill: p.fill, text: PROX_TEXT[p.level] || '' };
  s.mineApproved = mineApproved;
  s.otherApproved = otherApproved;
  s.settledValue = c.settled_value != null ? c.settled_value : null;
  s.coach = coachNudge(c, role);          // friendly nudge, safe for this viewer to see
  return s;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Auth ----
app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.render('home'); });

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
  mailer.notifyNewSignup({ name, email }).catch(() => {});      // email the admin
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
app.get('/dashboard', requireLogin, wrap(async (req, res) => {
  const cases = await db.casesForUser(req.session.userId);
  res.render('dashboard', { cases });
}));

app.get('/cases/new', requireLogin, (req, res) => res.render('new-case', { error: null }));
app.post('/cases/new', requireLogin, wrap(async (req, res) => {
  const title = (req.body.title || '').trim();
  const amount = parseInt(req.body.amount, 10);
  const role = req.body.role;
  const otherEmail = (req.body.other_email || '').trim().toLowerCase();
  if (!title || !(amount > 0) || !otherEmail || !['owed', 'owe'].includes(role)) return res.render('new-case', { error: 'Please fill in every field with valid values.' });
  const token = crypto.randomBytes(16).toString('hex');
  const me = req.session.userId;
  const claimantId = role === 'owed' ? me : null;
  const respondentId = role === 'owe' ? me : null;
  const id = await db.createCase(title, amount, token, claimantId, respondentId, otherEmail);
  const meEmail = res.locals.me ? res.locals.me.email : '';
  const claimantEmail = role === 'owed' ? meEmail : otherEmail;
  const respondentEmail = role === 'owe' ? meEmail : otherEmail;
  await db.addEvent(id, 'created', 'Case created by ' + meEmail + ' (' + (role === 'owed' ? 'claimant' : 'respondent') + ')');
  await db.addEvent(id, 'invited', 'Invited ' + otherEmail);
  const inviteUrl = req.protocol + '://' + req.get('host') + '/join/' + token;
  // Admin alert + invite the other party with the case details and accept/decline options
  mailer.notifyNewCase({ id, title, amount, other_email: otherEmail }, claimantEmail, respondentEmail).catch(() => {});
  mailer.notifyCaseInvite(
    { id, title, amount, other_email: otherEmail },
    { creatorEmail: meEmail, recipientPosition: role === 'owed' ? 'owe' : 'owed', inviteUrl }
  ).catch(() => {});
  res.redirect('/cases/' + id);
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
  mailer.notifyCaseAccepted({ id: c.id, title: c.title, amount: c.amount }, creatorEmail).catch(() => {});
  res.redirect('/cases/' + c.id);
}));

// Settle if both figures are in and they have crossed (shared by bid + join-with-figure).
async function maybeSettle(id) {
  const u = await db.caseById(id);
  if (u.claim_value != null && u.resp_value != null && u.resp_value >= u.claim_value) {
    const settled = Math.round((u.claim_value + u.resp_value) / 2 / 100) * 100;
    await db.settle('settled', settled, u.id);
    await db.addEvent(u.id, 'settled', 'Settled at £' + fmt(settled));
    const full = await db.caseDetail(u.id);
    mailer.notifySettled({ id: full.id, title: full.title, settled_value: settled, other_email: full.other_email }, full.claimant_acc_email, full.respondent_acc_email).catch(() => {});
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
  mailer.notifyCaseAccepted({ id: c.id, title: c.title, amount: c.amount }, creatorEmail).catch(() => {});
  await maybeSettle(c.id);
  return { role };
}

// The slider's "Continue with £X" button posts here. Choosing a figure = accepting.
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
  mailer.notifyCaseDeclined({ id: c.id, title: c.title, amount: c.amount, other_email: c.other_email }, creatorEmail).catch(() => {});
  res.render('message', { title: 'Invitation declined', body: 'Thanks — we\'ve let the other party know that you\'ve declined this case. Nothing further will happen.' });
}));

app.get('/cases/:id', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).render('message', { title: 'Not found', body: 'That case does not exist.' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).render('message', { title: 'No access', body: 'You are not a party to this case.' });
  const status = viewerStatus(c, role);
  const inviteUrl = req.protocol + '://' + req.get('host') + '/join/' + c.invite_token;
  res.render('case', { c, role, status, inviteUrl });
}));

app.post('/cases/:id/bid', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  if (c.status === 'settled' || c.status === 'closed') return res.json(viewerStatus(c, role));

  const A = c.amount;
  const clamp = (raw) => { let v = parseInt(raw, 10); if (!(v >= 0)) v = 0; if (v > A) v = A; return v; };
  let ideal = clamp(req.body.ideal);
  let fair  = clamp(req.body.fair);
  let resv  = clamp(req.body.reservation);   // reservation = walk-away (floor for claimant / ceiling for respondent)

  // Enforce the natural ordering of the three anchors so the data always makes sense.
  // Claimant wants high:   reservation (floor)  <= fair <= ideal (high)
  // Respondent wants low:  ideal (low)          <= fair <= reservation (ceiling)
  if (role === 'claim') {
    fair  = Math.max(resv, fair);
    ideal = Math.max(fair, ideal);
    await db.setClaimAnchors(ideal, fair, resv, c.id);
  } else {
    fair  = Math.min(resv, fair);
    ideal = Math.min(fair, ideal);
    await db.setRespAnchors(ideal, fair, resv, c.id);
  }

  // A changed figure changes the terms, so any earlier approval no longer holds.
  await db.resetApprovals(c.id);
  await db.addEvent(c.id, 'bid', (role === 'claim' ? 'Claimant' : 'Respondent') + ' set their three figures');
  const fresh = await db.caseById(c.id);
  res.json(viewerStatus(fresh, role));
}));

// Either side may approve once both figures are in and within 10%. The case
// only settles when BOTH sides have approved — that is the agreement.
app.post('/cases/:id/approve', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  if (c.status === 'settled' || c.status === 'closed') return res.json(viewerStatus(c, role));
  const close = proximity(c).canApprove;   // overlap, or within 10% on the walk-away figures
  if (!close) return res.status(400).json(viewerStatus(c, role));
  await db.setApproval(role, c.id);
  await db.addEvent(c.id, 'approved', (role === 'claim' ? 'Claimant' : 'Respondent') + ' approved the settlement');
  const updated = await db.caseById(c.id);
  if (updated.claim_approved && updated.resp_approved) {
    const settled = Math.round((updated.claim_value + updated.resp_value) / 2 / 100) * 100;
    await db.settle('settled', settled, updated.id);
    await db.addEvent(updated.id, 'settled', 'Agreed at £' + fmt(settled) + ' — both sides approved');
    const full = await db.caseDetail(updated.id);
    mailer.notifySettled({ id: full.id, title: full.title, settled_value: settled, other_email: full.other_email }, full.claimant_acc_email, full.respondent_acc_email).catch(() => {});
  }
  const fresh = await db.caseById(c.id);
  res.json(viewerStatus(fresh, role));
}));

app.get('/cases/:id/status', requireLogin, wrap(async (req, res) => {
  const c = await db.caseById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  const role = roleOf(c, req.session.userId);
  if (!role) return res.status(403).json({ error: 'forbidden' });
  res.json(viewerStatus(c, role));
}));

// A printable mediation settlement agreement, available to either party once
// the case is agreed. Built as a standalone page so it prints / saves to PDF.
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function agreementHtml(c) {
  const claimant = c.claimant_name || c.claimant_acc_email || 'Claimant';
  const respondent = c.respondent_name || c.respondent_acc_email || c.other_email || 'Respondent';
  const amount = '£' + fmt(c.amount);
  const agreed = '£' + fmt(c.settled_value);
  const today = fmtDay(c.settled_at || new Date());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mediation Settlement Agreement — MB-${c.id}</title>
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
  <h1>Mediation Settlement Agreement</h1>
  <div class="ref">Case reference MB-${c.id} — ${escapeHtml(c.title)}</div>

  <p>This agreement is made on <strong>${escapeHtml(today)}</strong> between:</p>
  <div class="parties">
    <p><strong>${escapeHtml(claimant)}</strong> (the "Claimant"), and</p>
    <p><strong>${escapeHtml(respondent)}</strong> (the "Respondent"),</p>
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
    <li>This agreement is governed by the law of England and Wales and the Parties submit to the exclusive jurisdiction of its courts.</li>
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
  if (c.status !== 'settled') return res.status(400).render('message', { title: 'Not yet agreed', body: 'A mediation agreement can be created once both sides have approved the figure.' });
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
  res.render('admin-case', { c, events });
}));
app.post('/admin/cases/:id/close', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setStatus('closed', Number(req.params.id)); await db.addEvent(Number(req.params.id), 'closed', 'Closed by admin'); res.redirect('/admin/cases/' + req.params.id); }));
app.post('/admin/cases/:id/reopen', requireLogin, requireAdmin, wrap(async (req, res) => { await db.setStatus('active', Number(req.params.id)); await db.addEvent(Number(req.params.id), 'reopened', 'Reopened by admin'); res.redirect('/admin/cases/' + req.params.id); }));

app.get('/admin/cases/:id/settlement.txt', requireLogin, requireAdmin, wrap(async (req, res) => {
  const c = await db.caseDetail(Number(req.params.id));
  if (!c) return res.status(404).send('Not found');
  const lines = [
    'MidBid — Settlement summary', '===========================', '',
    'Case ID:            MB-' + c.id,
    'Title:              ' + c.title,
    'Amount in dispute:  £' + fmt(c.amount),
    'Claimant (owed):    ' + (c.claimant_acc_email || '—'),
    'Respondent (owes):  ' + (c.respondent_acc_email || c.other_email || '—'),
    'Status:             ' + statusText(c),
    'Settlement amount:  ' + (c.settled_value != null ? '£' + fmt(c.settled_value) : '—'),
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
  .then(() => app.listen(PORT, () => console.log('MidBid running on http://localhost:' + PORT)))
  .catch((err) => { console.error('Database setup failed:', err); process.exit(1); });
