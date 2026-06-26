# Accord — working blind-bid mediation app

This is a real, working version of the Accord engine (not just a landing page).
Two people can each sign up, open a case, and privately enter a figure. Neither
side ever sees the other's number — the server only tells each person a **colour**:
nothing while they're far apart, **green when they're within 10%** of the amount in
dispute, and **settled** the moment their figures cross (it settles at the midpoint).

## What it does
- Real accounts (email + password, passwords are hashed)
- One party opens a case and invites the other by a private link
- Each party privately sets their figure and can change it any time
- The 10% colour signal and the settlement are calculated **on the server**, so the
  blind bidding is genuine — the other person's figure is never sent to your browser
- A live case screen that updates as the other side moves

## What it deliberately does NOT do yet (and why)
- **It does not move real money.** Holding other people's funds is regulated in the UK.
  When you're ready, you connect a regulated partner (e.g. Shieldpay, Stripe Connect,
  Mangopay) at the point of settlement. The code marks where that goes.
- **No identity checks (KYC) or emails are sent.** Invites are shown as a link you copy.
  For launch you'd add an email service (e.g. Postmark, SendGrid) and KYC via your
  payments partner.
This version stores everything in a **Postgres database** (set up automatically when
you deploy), so accounts and cases survive restarts — it's ready for real users.

---

## Put it online so real people can use it
👉 **See DEPLOY.md for the simple, step-by-step guide** (GitHub + Render, no coding).
Render runs the app and creates the Postgres database for you automatically.

You do **not** need to run it on your own computer first — deploying is the easy path.

### (Optional, advanced) Run it on your own computer
This now needs **Node.js 18+** and a local **Postgres** database. If you have both:
1. Copy `.env.example` to `.env` and set `DATABASE_URL` to your local Postgres.
2. `npm install`
3. `npm start`
4. Open **http://localhost:3000**

### Try it as two people
Open the app in a normal window **and** a private/incognito window. Sign up as two
different people. In window 1, start a case and copy the invite link. Paste it into
window 2 and join. Each window sets its own figure and watches the colour change.

---

## Before a real public launch — the checklist
- **Set `SESSION_SECRET`** to a long random value (Render's Blueprint does this for you).
- **Database: done** — this version already uses Postgres, so logins and cases persist.
  For the long term, upgrade Render's free database to a small paid plan so it doesn't expire.
- **Send real emails** for invites and "you're close / settled" alerts.
- **Connect a regulated payments/escrow partner** at settlement — this is the money step.
- **Add the legal layer**: terms, the mediation/settlement agreement, confidentiality,
  a privacy policy (UK GDPR). Starting with business-to-business disputes keeps you out
  of the consumer-ADR certification regime at first.
- **One known refinement:** because the signal flips exactly at 10%, a determined user
  could nudge their figure to probe roughly where the other side sits. If that matters
  to you, add a limit on how often each side can change their figure, or only reveal the
  colour after both have locked in a round. The rule lives in one place: `CLOSE_THRESHOLD`
  and `viewerStatus()` in `server.js`.

---

## What's in here
- `server.js` — the app and the blind-bid logic (`viewerStatus` is the private "brain")
- `db.js` — the database tables and queries
- `views/` — the pages (login, dashboard, new case, the case room, etc.)
- `public/styles.css` — the Accord look
- `package.json` — the dependency list and the `npm start` script

Not for legal or financial advice — the regulatory and money points above are
pressure points to confirm with a specialist.
