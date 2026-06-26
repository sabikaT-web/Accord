'use strict';

// Email via Resend (https://resend.com). OPTIONAL: with no RESEND_API_KEY the app
// still works — it logs instead of emailing, so nothing ever breaks on a failed email.
//
// NOTE on Resend test mode: until you verify a domain, Resend can only deliver to the
// email address you signed up with. So ADMIN emails (to NOTIFY_EMAIL) work right away,
// but the user-facing WELCOME email only delivers once you verify a domain.

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'saabika.tyagi@gmail.com';
const MAIL_FROM = process.env.MAIL_FROM || 'MidBid <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://midbid.onrender.com';

let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  } catch (e) {
    console.error('[mailer] Resend library not available:', e.message);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const gbp = (n) => '£' + Number(n || 0).toLocaleString('en-GB');
const btn = (href, label) =>
  '<p><a href="' + href + '" style="display:inline-block;background:#16306B;color:#fff;' +
  'text-decoration:none;padding:10px 18px;border-radius:8px;font-family:sans-serif">' + label + '</a></p>';

async function send(to, subject, html) {
  if (!resendClient) {
    console.log('[mailer] (no RESEND_API_KEY) would email', to, '—', subject);
    return;
  }
  try {
    await resendClient.emails.send({ from: MAIL_FROM, to, subject, html });
    console.log('[mailer] sent "' + subject + '" to', to);
  } catch (e) {
    console.error('[mailer] could not send to', to, '-', e.message);
  }
}

// 1) Admin: a new account was created
async function notifyNewSignup(user) {
  await send(NOTIFY_EMAIL, 'New MidBid sign-up: ' + user.name,
    '<h2 style="font-family:sans-serif">New user registered</h2>' +
    '<p style="font-family:sans-serif"><strong>Name:</strong> ' + esc(user.name) + '<br>' +
    '<strong>Email:</strong> ' + esc(user.email) + '<br>' +
    '<strong>Time:</strong> ' + new Date().toLocaleString('en-GB') + '</p>' +
    btn(APP_URL + '/admin/users', 'Open dashboard'));
}

// 2) User: welcome (only delivers once a domain is verified in Resend)
async function sendWelcome(user) {
  await send(user.email, 'Welcome to MidBid',
    '<h2 style="font-family:sans-serif">Welcome, ' + esc(user.name) + '</h2>' +
    '<p style="font-family:sans-serif">Your MidBid account is ready. You can open a case, ' +
    'invite the other side, and settle privately — neither side ever sees the other\'s figure.</p>' +
    btn(APP_URL + '/dashboard', 'Go to your cases'));
}

// 3) Admin: a new case was created
async function notifyNewCase(c, claimantEmail, respondentEmail) {
  await send(NOTIFY_EMAIL, 'New MidBid case created: ' + c.title,
    '<h2 style="font-family:sans-serif">New dispute created</h2>' +
    '<p style="font-family:sans-serif">' +
    '<strong>Case ID:</strong> MB-' + c.id + '<br>' +
    '<strong>Title:</strong> ' + esc(c.title) + '<br>' +
    '<strong>Claimant (owed):</strong> ' + esc(claimantEmail || '—') + '<br>' +
    '<strong>Respondent (owes):</strong> ' + esc(respondentEmail || c.other_email || '—') + '<br>' +
    '<strong>Amount in dispute:</strong> ' + gbp(c.amount) + '<br>' +
    '<strong>Status:</strong> Waiting for the other party</p>' +
    btn(APP_URL + '/admin/cases/' + c.id, 'Open case'));
}

// 4) Admin: a case settled
async function notifySettled(c, claimantEmail, respondentEmail) {
  await send(NOTIFY_EMAIL, 'MidBid case settled: ' + c.title,
    '<h2 style="font-family:sans-serif">Case settled 🎉</h2>' +
    '<p style="font-family:sans-serif">' +
    '<strong>Case ID:</strong> MB-' + c.id + '<br>' +
    '<strong>Title:</strong> ' + esc(c.title) + '<br>' +
    '<strong>Parties:</strong> ' + esc(claimantEmail || '—') + ' &amp; ' + esc(respondentEmail || c.other_email || '—') + '<br>' +
    '<strong>Settlement amount:</strong> ' + gbp(c.settled_value) + '</p>' +
    btn(APP_URL + '/admin/cases/' + c.id, 'View case'));
}

module.exports = { notifyNewSignup, sendWelcome, notifyNewCase, notifySettled };
