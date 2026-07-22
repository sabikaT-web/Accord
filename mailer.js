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

(function mailerSelfCheck() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[mailer] WARNING: RESEND_API_KEY is not set — NO EMAIL WILL BE SENT.');
    return;
  }
  if (/onboarding@resend\.dev/i.test(MAIL_FROM)) {
    console.warn('[mailer] WARNING: MAIL_FROM is still ' + MAIL_FROM + ' (Resend\'s test sender). '
      + 'Resend will ONLY deliver to your own account address — invites to anyone else will be refused. '
      + 'Set MAIL_FROM to an address on your verified domain, e.g. "MidBid <hello@midbid.org>".');
    return;
  }
  console.log('[mailer] ready — sending as ' + MAIL_FROM);
})();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const _CUR = { GBP:['\u00a3','en-GB'], USD:['$','en-US'], CAD:['C$','en-CA'], EUR:['\u20ac','de-DE'], SGD:['S$','en-SG'], INR:['\u20b9','en-IN'] };
const money = (n, code) => { const c = _CUR[String(code || 'GBP').toUpperCase()] || _CUR.GBP; return c[0] + Number(n || 0).toLocaleString(c[1]); };
const btn = (href, label) =>
  '<p><a href="' + href + '" style="display:inline-block;background:#16306B;color:#fff;' +
  'text-decoration:none;padding:10px 18px;border-radius:8px;font-family:sans-serif">' + label + '</a></p>';

// The Resend SDK RESOLVES with { data, error } — it does NOT throw when the API
// rejects a message. A bare try/catch therefore never fires, and every send looks
// like a success even when it was refused. Check the payload, not just the throw.
async function send(to, subject, html) {
  if (!resendClient) {
    console.log('[mailer] NOT SENT (no RESEND_API_KEY):', to, '—', subject);
    return { ok: false, error: 'Email is not configured — RESEND_API_KEY is not set on the server.' };
  }
  if (!to) return { ok: false, error: 'No email address on this case.' };
  try {
    const res = await resendClient.emails.send({ from: MAIL_FROM, to, subject, html });
    if (res && res.error) {
      const msg = res.error.message || String(res.error);
      console.error('[mailer] REJECTED by Resend for', to, '—', msg);
      return { ok: false, error: explain(msg) };
    }
    console.log('[mailer] sent "' + subject + '" to', to, '(id ' + ((res && res.data && res.data.id) || '?') + ')');
    return { ok: true, id: res && res.data && res.data.id };
  } catch (e) {
    console.error('[mailer] could not send to', to, '—', e.message);
    return { ok: false, error: e.message };
  }
}

// Turn Resend's wording into something that says what to actually do about it.
function explain(msg) {
  const m = String(msg || '');
  if (/testing emails|own email address|verify a domain/i.test(m)) {
    return 'Resend is still in test mode: it will only deliver to your own account address. '
         + 'Verify midbid.org in Resend, then set MAIL_FROM to an address on that domain (e.g. "MidBid <hello@midbid.org>").';
  }
  if (/domain is not verified|not verified/i.test(m)) {
    return 'The sending domain in MAIL_FROM is not verified in Resend. Finish DNS verification, then try again.';
  }
  if (/API key|unauthorized|invalid/i.test(m)) return 'Resend rejected the API key. Check RESEND_API_KEY on Render.';
  if (/rate/i.test(m)) return 'Resend rate limit hit. Wait a moment and retry.';
  return m;
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
    '<strong>Amount in dispute:</strong> ' + money(c.amount, c.currency) + '<br>' +
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
function scaleGraphic(amount, recipientPosition, href, currency) {
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
          '<td align="left">' + (_CUR[String(currency||'GBP').toUpperCase()]||_CUR.GBP)[0] + '0</td>' +
          '<td align="center" style="color:#16306B;font-weight:bold">drag to set yours →</td>' +
          '<td align="right">' + money(amount, currency) + '</td>' +
        '</tr></table>' +
    '</div></a>'
  );
}
async function notifyCaseInvite(c, opts) {
  const o = opts || {};
  const href = o.inviteUrl;
  return send(c.other_email,
    'You\'re invited to settle "' + c.title + '" on MidBid',
    '<div style="background:#F3EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" align="center" width="100%" style="max-width:520px;margin:0 auto;' +
      'background:#fff;border:1px solid #E8DFC9;border-radius:16px;border-collapse:separate"><tr><td style="padding:26px 26px 24px">' +
      brandHeader() +
      '<h1 style="font-family:Georgia,serif;font-weight:500;color:#1E2A45;font-size:24px;' +
        'text-align:center;margin:18px 0 6px;letter-spacing:-.01em">You\'re invited to settle</h1>' +
      '<p style="text-align:center;font-family:Arial,sans-serif;color:#586079;font-size:15px;margin:0 0 18px">' +
        esc(o.creatorEmail || 'Someone') + ' &nbsp;·&nbsp; ' + esc(c.title) + ' &nbsp;·&nbsp; <strong style="color:#1E2A45">' + money(c.amount, c.currency) + '</strong></p>' +
      scaleGraphic(c.amount, o.recipientPosition, href, c.currency) +
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
    '<strong>Settlement amount:</strong> ' + money(c.settled_value, c.currency) + '</p>' +
    btn(APP_URL + '/admin/cases/' + c.id, 'View case'));
}

// 5) CREATOR: the other party accepted and joined
async function notifyCaseAccepted(c, toEmail) {
  if (!toEmail) return;
  await send(toEmail, 'Your MidBid case was accepted: ' + c.title,
    '<h2 style="font-family:sans-serif">The other party joined your case 🎉</h2>' +
    '<p style="font-family:sans-serif"><strong>Case:</strong> ' + esc(c.title) + ' (MB-' + c.id + ')<br>' +
    '<strong>Amount in dispute:</strong> ' + money(c.amount, c.currency) + '</p>' +
    '<p style="font-family:sans-serif">Both sides are now in. Open the case and set your private figure.</p>' +
    btn(APP_URL + '/cases/' + c.id, 'Open the case'));
}

// 6) CREATOR + admin: the other party declined
async function notifyCaseDeclined(c, toEmail) {
  const subject = 'A MidBid case was declined: ' + c.title;
  const html =
    '<h2 style="font-family:sans-serif">The other party declined</h2>' +
    '<p style="font-family:sans-serif"><strong>Case:</strong> ' + esc(c.title) + ' (MB-' + c.id + ')<br>' +
    '<strong>Amount in dispute:</strong> ' + money(c.amount, c.currency) + '<br>' +
    '<strong>Declined by:</strong> ' + esc(c.other_email || '—') + '</p>' +
    '<p style="font-family:sans-serif">No figures were exchanged. You can open a fresh case if you\'d like to try again.</p>';
  if (toEmail) await send(toEmail, subject, html);
  await send(NOTIFY_EMAIL, subject, html);
}

module.exports = {
  notifyNewSignup, sendWelcome, notifyNewCase, notifySettled,
  notifyCaseInvite, notifyCaseAccepted, notifyCaseDeclined,
  notifyMediatorRequest, notifyRoundClosed, notifyBusinessRequest, notifyAgreementRequest
};

// A party asked MidBid to prepare a formal settlement agreement. Goes to you.
async function notifyAgreementRequest(c, docCount, note) {
  const to = process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'midbid.settle@gmail.com';
  return send(to, 'Settlement agreement requested — ' + (c.title || ('case ' + c.id)),
    '<div style="background:#F3EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" align="center" width="100%" style="max-width:520px;margin:0 auto;' +
      'background:#fff;border:1px solid #E8DFC9;border-radius:16px;border-collapse:separate"><tr><td style="padding:26px">' +
      brandHeader() +
      '<h1 style="font-family:Georgia,serif;font-weight:500;color:#1E2A45;font-size:22px;text-align:center;margin:18px 0 14px">' +
        'A settlement agreement was requested</h1>' +
      '<p style="color:#586079;font-size:15px;line-height:1.6;margin:0 0 14px">' +
        '<b>' + esc(c.title || ('Case ' + c.id)) + '</b> (MB-' + c.id + '). ' +
        esc(String(docCount || 0)) + ' document(s) were uploaded with the request.</p>' +
      (note ? '<p style="color:#586079;font-size:14px;line-height:1.6;background:#F7F9FD;border-radius:10px;padding:12px 14px;margin:0 0 16px"><b>Note from the party:</b><br>' + esc(note) + '</p>' : '') +
      '<p style="text-align:center;margin:8px 0 0"><a href="' + (process.env.APP_URL || '') + '/admin/cases" ' +
        'style="background:#16306B;color:#F4F2EB;text-decoration:none;padding:12px 22px;border-radius:999px;' +
        'font-weight:700;font-size:15px;display:inline-block">Open in Admin</a></p>' +
    '</td></tr></table></div>');
}

// Someone asked for the business portal. This goes to you, not to them.
async function notifyBusinessRequest(user, company, caseCount) {
  const to = process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'midbid.settle@gmail.com';
  const rows = [
    ['Name', user.name || '-'],
    ['Email', user.email || '-'],
    ['Company', company || '-'],
    ['Disputes on their account', String(caseCount == null ? '-' : caseCount)]
  ].map(function (r) {
    return '<tr><td style="padding:6px 10px;color:#586079;font-size:13px">' + esc(r[0]) + '</td>'
         + '<td style="padding:6px 10px;color:#1E2A45;font-size:13px;font-weight:700">' + esc(r[1]) + '</td></tr>';
  }).join('');
  return send(to, 'Business portal request - ' + (company || user.email),
    '<div style="background:#F3EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<table role="presentation" align="center" width="100%" style="max-width:520px;margin:0 auto;'
    + 'background:#fff;border:1px solid #E8DFC9;border-radius:16px;border-collapse:separate"><tr><td style="padding:26px">'
    + brandHeader()
    + '<h1 style="font-family:Georgia,serif;font-weight:500;color:#1E2A45;font-size:22px;text-align:center;margin:18px 0 14px">'
    + 'Someone wants the business portal</h1>'
    + '<table role="presentation" width="100%" style="border-collapse:collapse;background:#F7F9FD;border-radius:10px">' + rows + '</table>'
    + '<p style="color:#586079;font-size:14px;line-height:1.6;margin:16px 0 18px;text-align:center">'
    + 'It is logged against their account. Approve it in Admin &gt; Users &gt; Open portal.</p>'
    + '<p style="text-align:center;margin:0"><a href="' + (process.env.APP_URL || '') + '/admin/users" '
    + 'style="background:#16306B;color:#F4F2EB;text-decoration:none;padding:12px 22px;border-radius:999px;'
    + 'font-weight:700;font-size:15px;display:inline-block">Open Admin - Users</a></p>'
    + '</td></tr></table></div>');
}

// A round closed without a deal. Both sides get the same message, and it says
// nothing about the other side's figure — only that the round is over. Without
// this email nobody knows to come back, and the case simply stalls.
async function notifyRoundClosed(c, round, claimantEmail, respondentEmail) {
  const body = function (who) {
    return '<div style="background:#F3EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
      '<table role="presentation" align="center" width="100%" style="max-width:520px;margin:0 auto;' +
        'background:#fff;border:1px solid #E8DFC9;border-radius:16px;border-collapse:separate"><tr><td style="padding:26px">' +
        brandHeader() +
        '<h1 style="font-family:Georgia,serif;font-weight:500;color:#1E2A45;font-size:22px;text-align:center;margin:18px 0 6px">' +
          'Round ' + round + ' closed — no settlement</h1>' +
        '<p style="color:#586079;font-size:15px;line-height:1.6;text-align:center;margin:0 0 18px">' +
          'Your figures did not meet on <b>' + esc(c.title) + '</b>. Nothing about either side\'s numbers has been shared.</p>' +
        '<p style="color:#586079;font-size:15px;line-height:1.6;text-align:center;margin:0 0 20px">' +
          'You can bid again — but only toward the other side. If your ranges meet, it settles on the spot.</p>' +
        '<p style="text-align:center;margin:0"><a href="' + (process.env.APP_URL || '') + '/cases/' + c.id + '" ' +
          'style="background:#16306B;color:#F4F2EB;text-decoration:none;padding:12px 22px;border-radius:999px;' +
          'font-weight:700;font-size:15px;display:inline-block">Open round ' + (round + 1) + '</a></p>' +
      '</td></tr></table></div>';
  };
  const subject = 'Round ' + round + ' closed — no settlement yet on "' + c.title + '"';
  const to1 = claimantEmail;
  const to2 = respondentEmail || c.other_email;      // the respondent may not have an account yet
  const a = to1 ? await send(to1, subject, body('claimant')) : { ok: false };
  const b = to2 ? await send(to2, subject, body('respondent')) : { ok: false };
  return { ok: a.ok || b.ok };
}

// Human-mediator escalation: alert the admin + acknowledge the parties.
async function notifyMediatorRequest(c, claimantEmail, respondentEmail, role) {
  const who = role === 'claim' ? 'the claimant' : 'the respondent';
  const adminTo = process.env.ADMIN_EMAIL || MAIL_FROM;
  await send(adminTo, 'Mediator requested — case #' + c.id,
    brandHeader() + '<p><strong>' + esc(who) + '</strong> has requested a human mediator on case #' + esc(c.id) +
    ' (“' + esc(c.title) + '”).</p><p>Reach out to both parties to arrange a session and confirm the fee.</p>');
  const parties = [claimantEmail, respondentEmail].filter(Boolean);
  for (const to of parties) {
    await send(to, 'Your MidBid mediator request',
      brandHeader() + '<p>Thanks — we’ve received a request for a human mediator on “' + esc(c.title) +
      '”. A MidBid mediator will be in touch shortly to arrange a session and confirm the fee.</p>');
  }
}
