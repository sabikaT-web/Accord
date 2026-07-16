# Upload order — sealed bidding, on the live site

Eight files, replacing what's on `main`. **Order matters for the first two.**

| # | File | Why |
|---|------|-----|
| 1 | `db.js` | Creates the `bids` table, the unique index that enforces the lock, and `cases.round`. Everything else depends on it. |
| 2 | `server.js` | Sealed status, the locked submit, automatic settlement. |
| 3 | `case.ejs` | Locks after submit, one-way reminder, themed submit dialog. |
| 4 | `business.js` | Stops exposing the respondent's figure. Removes the "Converging" stage. |
| 5 | `business.ejs` | Panel no longer shows their position. |
| 6 | `dashboard.ejs` | Column shows only your own figure. |
| 7 | `mailer.js` | New round-closed email. Without it a closed round is silent and the case stalls. |
| 8 | `admin-cases.ejs` | **New file.** This view never existed — `/admin/cases` has been 500ing. |

Nothing else changes: `styles.css`, `head.ejs`, `home.ejs`, `package.json` all stay as they are.

## After uploading

- Render redeploys. Boot runs the migration: `CREATE TABLE bids`, `ADD COLUMN round`. All
  `IF NOT EXISTS`, nothing dropped, existing cases untouched.
- **Existing cases keep their figures but have no bid rows**, so both sides submit fresh
  into round 1. That's correct — nothing was ever committed under the old rules.
- Check `/healthz` returns `{"ok":true}`, then open a case and confirm you see the gold
  one-way reminder under the scale.

## What changed for the people using it

- One bid per round. It **locks** on submit — no edits until the other side has bid.
- **No feedback at all** while a round is open. No proximity bar, no "you're close".
- Ranges meet → it settles **automatically at the midpoint**. There is no approve step.
- You can bid again next round, but **only toward the other side**.
- The scale still turns green — at settlement, where it means "done", not "you're warm".
