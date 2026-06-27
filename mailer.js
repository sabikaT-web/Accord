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

// 4) OTHER PARTY: branded, graphics-led, two-tone (blue + gold) invitation.
//    opts: { creatorEmail, recipientPosition ('owe'|'owed'), inviteUrl }
function brandHeader() {
  return (
    '<div style="text-align:center;padding:4px 0 2px">' +
      '<span style="display:inline-block;width:20px;height:20px;border-radius:50%;' +
        'border:2.5px solid #2F6BFF;vertical-align:middle"></span>' +
      '<span style="display:inline-block;width:20px;height:20px;border-radius:50%;' +
        'border:2.5px solid #F5B312;vertical-align:middle;margin-left:-8px"></span>' +
      '<span style="font-family:Georgia,\'Times New Roman\',serif;font-size:22px;' +
        'color:#1E2A45;vertical-align:middle;margin-left:8px;letter-spacing:-.01em">MidBid</span>' +
      '<div style="width:24px;height:2px;background:#2F6BFF;border-radius:2px;margin:12px auto 0"></div>' +
    '</div>'
  );
}
function scaleGraphic(amount, recipientPosition, href) {
  const cap = recipientPosition === 'owe' ? 'the most you\'ll pay' : 'the least you\'ll accept';
  return (
    '<a href="' + href + '" style="text-decoration:none;color:inherit;display:block">' +
    '<div style="background:#FBF8F0;border:1px solid #EFE3C8;border-radius:14px;padding:20px 18px;margin:6px 0 4px">' +
      '<div style="text-align:center;font-family:Arial,sans-serif;font-size:13px;color:#586079;margin-bottom:12px">' +
        'You choose your figure — <strong style="color:#16306B">' + cap + '</strong></div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' +
        '<td style="height:12px;background:#2F6BFF;border-radius:7px 0 0 7px" width="52%"></td>' +
        '<td width="26" align="center" style="vertical-align:middle">' +
          '<div style="width:22px;height:22px;border-radius:50%;background:#fff;border:3px solid #16306B;margin:0 auto"></div>' +
        '</td>' +
        '<td style="height:12px;background:#DCE7FF;border-radius:0 7px 7px 0"></td>' +
      '</tr></table>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">' +
        '<tr style="font-family:Arial,sans-serif;font-size:12px;color:#586079">' +
          '<td align="left">£0</td>' +
          '<td align="center" style="color:#16306B;font-weight:bold">drag to set yours →</td>' +
          '<td align="right">' + gbp(amount) + '</td>' +
        '</tr></table>' +
    '</div></a>'
  );
}
async function notifyCaseInvite(c, opts) {
  const o = opts || {};
  const href = o.inviteUrl;
  await send(c.other_email,
    'You\'re invited to settle "' + c.title + '" on MidBid',
    '<div style="background:#F3EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" align="center" width="100%" style="max-width:520px;margin:0 auto;' +
      'background:#fff;border:1px solid #E8DFC9;border-radius:16px;border-collapse:separate"><tr><td style="padding:26px 26px 24px">' +
      brandHeader() +
      '<h1 style="font-family:Georgia,serif;font-weight:500;color:#1E2A45;font-size:24px;' +
        'text-align:center;margin:18px 0 6px;letter-spacing:-.01em">You\'re invited to settle</h1>' +
      '<p style="text-align:center;font-family:Arial,sans-serif;color:#586079;font-size:15px;margin:0 0 18px">' +
        esc(o.creatorEmail || 'Someone') + ' &nbsp;·&nbsp; ' + esc(c.title) + ' &nbsp;·&nbsp; <strong style="color:#1E2A45">' + gbp(c.amount) + '</strong></p>' +
      scaleGraphic(c.amount, o.recipientPosition, href) +
      '<div style="text-align:center;margin:22px 0 6px">' +
        '<a href="' + href + '" style="display:inline-block;background:#F5B312;color:#16306B;' +
          'text-decoration:none;padding:14px 30px;border-radius:10px;font-family:Arial,sans-serif;' +
          'font-size:16px;font-weight:bold">Set your figure &amp; sign up →</a>' +
      '</div>' +
      '<p style="text-align:center;font-family:Arial,sans-serif;color:#9099Ad;font-size:12px;margin:16px 0 0">' +
        'Private &amp; blind — the other side never sees your number.</p>' +
    '</td></tr></table>' +
    '<p style="text-align:center;font-family:Arial,sans-serif;color:#A39B86;font-size:11px;margin:14px auto 0;max-width:520px">' +
      'If the button doesn\'t work, open: <a href="' + href + '" style="color:#2F6BFF">' + esc(href) + '</a></p>' +
    '</div>');
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
