# Individual dashboard — legal-fintech redesign + owed/owe colour

**Upload order: `db.js` first, then `server.js`, then `admin-cases.ejs` and
`dashboard.ejs`. One commit.** (db.js adds the column the others read.)

This one batch carries everything from the last few turns — they build on each other,
so upload them together:

## Legal-fintech dashboard (new look)
- Dark navy header band, KPI cards overlapping it, tabular-figure numbers, restrained
  colour as data hierarchy. Navy = law, royal blue = fintech, gold = value, green = settled.
- Filter chips (All / each stage) + Export + New case.
- The individual portal only. `business.ejs` already has its own analytics look — untouched.

## Two column changes you asked for
- "Amount" -> **"Original amount"** (the sum in dispute — unchanged data, clearer label).
- "Your figure" -> **"Last bid"**, now wired to real data: it shows the walk-away from the
  viewer's most recent bid (`db.lastBid`), per case, their own side only. Shows "no bid yet"
  until they've bid. This is live-connected, not a static field.

## Owed / owe colour (from earlier, included here)
- `creator_owes` column (NULL = unconfirmed -> no colour, never guessed).
- New cases set it from the "I'm owed / I owe" answer already in the create form.
- Admin -> Cases has a per-case Owed/Owe/- setter for your existing real cases.
- Dashboard rows carry a blue (owed) or amber (owe) left stripe. **No owe/owed words
  anywhere** in the dashboard — the colour is the only signal.

## Files
| File | Why |
|------|-----|
| db.js | `creator_owes` column + `setCreatorOwes`. **Upload first.** |
| server.js | `moneySide` helper, admin direction route, role saved at creation, **`myLastBid` per case**. |
| admin-cases.ejs | per-case Owed/Owe setter. |
| dashboard.ejs | legal-fintech skin + Original amount + Last bid + colour stripes. |

## Verified
Renders with real last bids (£6,500 shown), "no bid yet" when unbid, dark header, KPIs,
colour stripes, no owe/owed words. Unconfirmed cases show no stripe.

## Reminder
The GitHub web uploader has silently skipped a file before. After committing, check each
file's timestamp on GitHub to confirm all four landed.
