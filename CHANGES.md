# Send / Resend invitation

**Three files. `db.js` first — it adds the columns the other two read.**

| # | File | Change |
|---|------|--------|
| 1 | `db.js` | `invited_at`, `invite_count`, `last_invite_error` on `cases`, plus `markInvited()`. |
| 2 | `server.js` | Invite send is now honest. New `POST /cases/:id/invite`. Flash message passed to the case page. |
| 3 | `case.ejs` | The panel: Send / Resend, when it was last sent, and why it failed. |

## The bug this fixes

`server.js` line 595 was:

```js
mailer.notifyCaseInvite(...).catch(() => {});
await db.setStatus('awaiting_other', id);
```

It fired the email, ignored the result, and flipped the case to "awaiting_other"
regardless. So a case that had **never successfully emailed anyone** sat there saying
*"Waiting for the other party to join"* — waiting forever, for a message that did not
exist. This is the same silent-failure bug fixed in `business.js` a while back; it was
never fixed on the individual side.

Now the send is awaited. On failure the case **stays in draft**, the reason is stored in
`last_invite_error`, and the case page shows it. The status only advances when an
invitation genuinely went out.

## What you get on the case page

| State | Shows |
|---|---|
| Never invited | "They have not been invited yet" + **Send invitation** |
| No email on the case | The same, plus a field to type their address |
| Sent today | "Sent today to r@x.com" + **Resend invitation** |
| Sent 5+ days ago | Turns **gold** — "No reply yet, worth another nudge" |
| Sent 3 times | "Sent 9 days ago, 3 times" |
| Last send failed | Turns **red**, prints the actual mail error + **Send invitation** |
| They joined | Panel disappears |

The panel stays for the whole time the other side has not joined — not only in
`awaiting_other`. A failed send leaves the case in `draft`, which is exactly when you most
need the button.

The copy-link fallback is still there, tucked under "Or send them the link yourself".
It is a fallback now, not the mechanism.

## It still needs the mail keys

The button reports honestly — which means that until `RESEND_API_KEY` and `MAIL_FROM` are
set on Render, pressing it will show you the real error in red rather than pretending.
That is the point. Once the keys are set, the same button just works.
