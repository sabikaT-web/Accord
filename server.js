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
    'dashboard','home','join','login','message','new-case','signup'];
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

// The blind-bid brain: returns ONLY what the asking side may see.
function viewerStatus(c, role) {
  const myValue = role === 'claim' ? c.claim_value : c.resp_value;
  const bothIn = c.claim_value != null && c.resp_value != null;
  if (c.status === 'settled') return { state: 'settled', colour: 'deal', myValue, settled: c.settled_value, title: 'Settled at £' + fmt(c.settled_value), sub: 'Your figures met. This is recorded as your agreed settlement.' };
  if (myValue == null) return { state: 'need_bid', colour: 'idle', myValue: null, title: 'Set your figure to begin', sub: role === 'claim' ? 'Enter the least you will accept.' : 'Enter the most you will pay.' };
  if (!bothIn) return { state: 'waiting', colour: 'idle', myValue, title: 'Waiting for the other side', sub: 'You are in. Nothing is revealed until your figures are close.' };
  const gap = c.claim_value - c.resp_value;
  if (gap <= CLOSE_THRESHOLD * c.amount) return { state: 'close', colour: 'close', myValue, title: "Within 10% — you're close", sub: 'A small move could close the gap. Keep going.' };
  return { state: 'far', colour: 'idle', myValue, title: 'No signal yet', sub: 'Keep adjusting — nothing leaks while you are apart.' };
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
  if (!req.session.userId) return res.redirect('/login?next=' + encodeURIComponent('/join/' + req.params.token));
  if (roleOf(c, req.session.userId)) return res.redirect('/cases/' + c.id);
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
  let value = parseInt(req.body.value, 10);
  if (!(value >= 0)) value = 0;
  if (value > c.amount) value = c.amount;
  if (role === 'claim') await db.setClaimValue(value, c.id); else await db.setRespValue(value, c.id);
  await db.addEvent(c.id, 'bid', (role === 'claim' ? 'Claimant' : 'Respondent') + ' submitted a figure');
  const updated = await db.caseById(c.id);
  if (updated.claim_value != null && updated.resp_value != null && updated.resp_value >= updated.claim_value) {
    const settled = Math.round((updated.claim_value + updated.resp_value) / 2 / 100) * 100;
    await db.settle('settled', settled, updated.id);
    await db.addEvent(updated.id, 'settled', 'Settled at £' + fmt(settled));
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
