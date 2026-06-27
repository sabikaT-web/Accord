'use strict';

// Email via Resend (https://resend.com). OPTIONAL: with no RESEND_API_KEY the app
// still works — it logs instead of emailing, so nothing ever breaks on a failed email.
//
// DELIVERY NOTE (important): in Resend "test mode" (no verified domain), Resend will
// ONLY deliver to the email address that owns the Resend account. So:
//   - Admin alerts to NOTIFY_EMAIL deliver right away IF your Resend account is that
//     same address (midbid.settle@gmail.com).
//   - The invite email to the OTHER party (any address) only delivers once you verify
//     a sending domain in Resend and set MAIL_FROM to an address on that domain.
// Until then, the invite link is still shown on the case screen to copy/paste.

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'midbid.settle@gmail.com';
const MAIL_FROM = process.env.MAIL_FROM || 'MidBid <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'https://midbid-wdpc.onrender.com';

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

// 4) OTHER PARTY: you've been invited to a case — full details + a button to respond
//    opts: { creatorEmail, recipientPosition ('owe'|'owed'), inviteUrl }
async function notifyCaseInvite(c, opts) {
  const o = opts || {};
  const youAre = o.recipientPosition === 'owe'
    ? 'You are named as the party who <strong>owes</strong> money.'
    : 'You are named as the party who is <strong>owed</strong> money.';
  await send(c.other_email, 'You\'ve been invited to settle a dispute on MidBid: ' + c.title,
    '<h2 style="font-family:sans-serif">You\'ve been invited to settle a dispute</h2>' +
    '<p style="font-family:sans-serif">' + esc(o.creatorEmail || 'Someone') +
    ' has opened a private case with you on MidBid and wants to resolve it.</p>' +
    '<p style="font-family:sans-serif">' +
    '<strong>Case ID:</strong> MB-' + c.id + '<br>' +
    '<strong>What it\'s about:</strong> ' + esc(c.title) + '<br>' +
    '<strong>Amount in dispute:</strong> ' + gbp(c.amount) + '<br>' +
    '<strong>Your position:</strong> ' + youAre + '</p>' +
    '<p style="font-family:sans-serif">MidBid is a private, blind-bid settlement room: each side ' +
    'enters the figure they can live with, and neither side ever sees the other\'s number — you only ' +
    'get a signal when you\'re close, and it settles in the middle if your figures cross.</p>' +
    '<p style="font-family:sans-serif">On the next screen you can <strong>accept and join</strong> the ' +
    'case, or <strong>decline</strong> it.</p>' +
    btn(o.inviteUrl, 'Review the case &amp; respond') +
    '<p style="font-family:sans-serif;color:#667">If the button doesn\'t work, paste this link into your browser:<br>' +
    esc(o.inviteUrl) + '</p>');
}

// 4b) Admin: a case settled
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

// 5) CREATOR: the other party accepted and joined
async function notifyCaseAccepted(c, toEmail) {
  if (!toEmail) return;
  await send(toEmail, 'Your MidBid case was accepted: ' + c.title,
    '<h2 style="font-family:sans-serif">The other party joined your case 🎉</h2>' +
    '<p style="font-family:sans-serif"><strong>Case:</strong> ' + esc(c.title) + ' (MB-' + c.id + ')<br>' +
    '<strong>Amount in dispute:</strong> ' + gbp(c.amount) + '</p>' +
    '<p style="font-family:sans-serif">Both sides are now in. Open the case and set your private figure.</p>' +
    btn(APP_URL + '/cases/' + c.id, 'Open the case'));
}

// 6) CREATOR + admin: the other party declined
async function notifyCaseDeclined(c, toEmail) {
  const subject = 'A MidBid case was declined: ' + c.title;
  const html =
    '<h2 style="font-family:sans-serif">The other party declined</h2>' +
    '<p style="font-family:sans-serif"><strong>Case:</strong> ' + esc(c.title) + ' (MB-' + c.id + ')<br>' +
    '<strong>Amount in dispute:</strong> ' + gbp(c.amount) + '<br>' +
    '<strong>Declined by:</strong> ' + esc(c.other_email || '—') + '</p>' +
    '<p style="font-family:sans-serif">No figures were exchanged. You can open a fresh case if you\'d like to try again.</p>';
  if (toEmail) await send(toEmail, subject, html);
  await send(NOTIFY_EMAIL, subject, html);
}

module.exports = {
  notifyNewSignup, sendWelcome, notifyNewCase, notifySettled,
  notifyCaseInvite, notifyCaseAccepted, notifyCaseDeclined
};
