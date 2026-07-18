# Settlement rules — read before changing the settle logic

A case settles when **either**:

1. **Overlap** — the respondent's ceiling reaches the claimant's floor
   (`respondent_walk >= claimant_walk`). A genuine deal.
2. **Within 5% of each other** — the gap between the two walk-aways is 5% or less of the
   **smaller** of the two figures. MidBid closes the gap and settles at the midpoint.

Either way the settled figure is the midpoint of the two walk-aways. Neither side ever
sees the other's number. On a band settlement the announcement says only that the two
were "within 5% of each other" — never the figures, never the exact gap.

## The tradeoff, on the record

The 5% band is a deliberate choice, made knowing the cost:

- **It can settle a party past the limit they set.** If a respondent's ceiling is 13,165
  and the claimant's floor is 13,600, the band settles both at ~13,382 — the respondent
  pays £217 more than the maximum they entered. They did not approve that figure; the
  band did.
- **It is discoverable.** Because the announcement states the 5% rule, users learn it.
  A user who wants to can bid ~5% short of their true figure, betting the band pulls the
  midpoint their way. This is the guesswork the sealed design otherwise removes.

Both were flagged before the rule was built and the decision was made to proceed. This
file exists so that decision is documented — if a settled party ever disputes paying past
their stated maximum, the mechanism and the reasoning are on record.

## Case 43

Case 43's gap is ~5.9% of the smaller figure, so it does **not** settle under a true 5%
band — it needs one more small move from either side. If the intention is for 43 to
settle immediately, the band must be 6% (`SETTLE_BAND = 0.06` in server.js), not 5%.

## Where the number lives

`server.js`, one constant: `const SETTLE_BAND = 0.05;`  Change it in that one place.

## Files

| File | Change |
|------|--------|
| `server.js` | Overlap **or** within-5% settles. Records why (`overlap`/`band`). **Also removes the dead 10% proximity code** that was still live — the old "you're within 10%" leak. |
| `db.js` | `settle_reason` column. |
| `case.ejs` | Settled announcement adds one green line on a band settle: "within 5% of each other, so MidBid closed the gap." Silent on overlap. |

## Important: the 10% leak was still live

Until this change, `server.js` on `main` still contained the old `proximity()` function
and `CLOSE_THRESHOLD = 0.10` — the "within 10% — close to a deal" signalling from before
sealed bidding. It was dead code (nothing called it), but it was one wiring mistake away
from leaking again. It is now removed.
