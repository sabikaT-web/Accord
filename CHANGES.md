# Payout clarity + agreement-upload popup

**Four files. `db.js` first** (adds a column the others use). One commit.

Built on your CURRENT live files — including the Stripe Connect payout work already on
`main`. Nothing there is overwritten.

## 1. Payout clarity (your live payout flow already worked — this makes it obvious)

Your site already locks the payer's button until the payee adds bank details, and already
shows a waiting state. I only sharpened the wording so the dependency is unmistakable:

- Payer, waiting: button reads **"Payment opens once they add bank details"** and the
  status says the Pay button unlocks the instant the other party adds their bank details —
  "we'll email you, you don't need to keep checking."
- Payer, ready: **"The other party has added their bank details, so your payment can be
  routed to them. You're clear to pay."**
- Payee: their button reads **"Add your bank details to get paid"**, and the modal spells
  out that the other party's Pay button stays locked until they finish.

No logic changed here — only copy. The mechanism was already correct.

## 2. Agreement-upload popup (new)

The old "Request a settlement agreement" button was a dead stub. It now opens a popup:

- Headed **"Recommended for high-value cases."**
- Explains the settlement is already binding, and the written agreement is an added layer
  for large sums or documents you may need later.
- **Uploads case documents** (contract, invoices, correspondence) + an optional note.
- On submit: files are stored against the case, you get an email (`notifyAgreementRequest`)
  with the count, the note, and a link to Admin, and the button flips to "Agreement
  requested."

This is the deliberate alternative to auto-generating a contract per jurisdiction: the
party sends their papers, and you prepare the agreement by hand. Lower legal risk, and it
makes the agreement the premium path.

## The Stripe loop is NOT a code bug

"Set up payouts" looping back to the same screen is a Stripe-side config issue, not the
code — the onboard route is correct. Two likely causes:

1. **Connect isn't enabled** on your Stripe account. Dashboard, search "Connect", if it
   says Activate, it's off. accounts.create({type:'express'}) needs it on.
2. **Key/mode mismatch** — a test key (sk_test_...) on Render while Connect was activated
   in live mode, or vice versa.

To find which: open Render logs, click "Set up payouts", look for a line starting
`connect return:` or any `StripeError`. Paste it and I'll give the exact fix.

Until Connect works, the payee can't finish onboarding, so the payer's button never
unlocks — every downstream "why won't it pay" traces back to this one setting.
