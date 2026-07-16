# Business portal — ask freely, admin approves

**Six files. Nothing else from the previous batch changes.**

| File | Change |
|------|--------|
| `db.js` | `business_requested` + `business_requested_at` columns, `requestBusiness()`. |
| `signup.ejs` | "Just me" / "My business — 25 or more" choice, with a company field. |
| `server.js` | Signup records the request (does **not** grant it). Exposes `ADMIN_EMAIL` to views. |
| `business.js` | New 403 copy: 25+, and an "Ask for a demo" button. |
| `message.ejs` | Optional `html` field (see note). |
| `dashboard.ejs` | The portal is now discoverable, and sharpens at 25 cases. |

## The model

- **`account_type`** = approved access. Only you set it, in Admin > Users.
- **`business_requested`** = they asked. Set at signup.

Two flags, not one. With a single flag you cannot tell "waiting on you" from "you said no",
and every request looks identical to an account you have already turned down.

Choosing "My business" at signup **does not grant anything**. They land on the individual
view with their request logged, and you approve it in Admin > Users. Granting it at signup
would be the old silent-promotion bug in nicer clothes.

## What people now see

| Who | Dashboard | Switch | `/business` |
|-----|-----------|--------|-------------|
| Individual, few cases | quiet mention + "Ask for a demo" | hidden | 403 with a demo button |
| Individual, 25+ cases | **gold** — "You're handling 26 disputes…" | hidden | 403 with a demo button |
| Asked, waiting | "Your request is with us" | hidden | 403, "we'll be in touch" |
| Approved | nothing | **visible** | works |

## Note on message.ejs

`body` stays escaped. The new `html` field is opt-in and used only by the 403 page.
I did not simply make `body` unescaped because the admin password-reset page interpolates
a user's email address into it, and signup does not validate email format — so unescaping
would turn a hostile signup address into an XSS on your own admin page.

## After uploading

Boot adds the two columns (`IF NOT EXISTS`, nothing dropped). Existing accounts keep
whatever `account_type` they have — including anyone the old code silently promoted, so
Admin > Users > **Close portal** is still the way to clean those up.
