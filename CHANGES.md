# Owed / Owe colour — per case, never guessed

**Four files. `db.js` FIRST** (adds the column the others read), then server.js,
admin-cases.ejs, dashboard.ejs. One commit.

## The safe design (because your cases are real)

Money direction is coloured **per case**, from a real stored field — never from a guess.

- New column `creator_owes` on cases. Default **NULL = unconfirmed**.
- A case with NULL direction shows **no colour** — neutral, exactly like today. Nothing
  is ever mislabelled, because nothing is asserted about a case you haven't confirmed.
- Blue = you're owed in that case. Amber (#C98A0E) = you owe. Green stays settled-only.

## The three pieces

1. **New cases set it automatically.** Your create form already asks "I'm owed / I owe"
   (the `role` field). That answer is now stored into `creator_owes`, so every new case
   is coloured truthfully from birth. No new question added — it was already there, just
   not saved.

2. **Existing cases: you set them in Admin.** Admin -> Cases now has an **Owed / Owe / –**
   setter on each row. Click the right one for each of your handful of real cases. The
   buttons describe the **claimant** (first-named party): "Owed" = the claimant is owed,
   "Owe" = the claimant owes. Until you set a case, it stays neutral.

3. **Dashboard colours each case** by the viewer's side: blue stripe + "Owed" badge when
   you're owed, amber stripe + "Owe" badge when you owe, nothing when unconfirmed. The
   "you are owed / you owe" sub-line now reads from the real field too.

## Why per-case, not a whole-dashboard theme

A person is claimant on one case and respondent on another, so a single dashboard colour
would contradict itself. Per-case colour is always true and matches the claimant/
respondent logic your blind-bid mechanic already runs on.

## Verified

- Owed case -> blue stripe + Owed badge. Owe case -> amber + Owe badge.
- **Unconfirmed case -> no stripe, no badge, neutral** (checked explicitly — this is the
  safety property that stops any real case being mislabelled).
- Admin setter shows the current state and lets you change or clear it per case.

## NOT included

The clickable "You're owed / You owe" homepage labels are a separate small change that
belongs in `home.ejs` (the hero work). Say the word and I'll add them there — they just
link to /signup, no theming, no risk.

## Backfill note

No bulk backfill is run. Every existing case starts NULL (neutral) on purpose, because
you confirmed your real cases go both ways. Set your handful by hand in Admin; they colour
the moment you do.
