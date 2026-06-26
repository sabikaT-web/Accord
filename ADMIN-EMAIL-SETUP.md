# MidBid — Admin Portal & Email Alerts setup

You now have an **Admin Portal** and **email alerts**. This guide turns them on.
It's two things: (A) upload the updated files, (B) flip on email + admin in Render.

---

## A. What you get

**Admin Portal** (only visible when you're logged in as the admin email):
- **Dashboard** — total users, total cases, cases in progress, settled, settlement
  rate, average time to settle, sign-ups & cases charts, and a live activity feed.
- **Users** — everyone who signed up, with joined date, last login, number of cases,
  and buttons to **Suspend**, **Reset password**, **Delete**, plus search and CSV export.
- **Cases** — every dispute with both parties, amount, status and a progress bar;
  search and CSV export.
- **Open a case** — see the full **timeline** (created → invited → joined → each bid →
  settled), both parties' figures (for your oversight only), download the settlement,
  and **close / reopen** the case.

**Email alerts** sent to **saabika.tyagi@gmail.com**:
- New user registered
- New case created
- Case settled

---

## B. Turn on email alerts (5 minutes)

Emails are sent through **Resend** (free). The app already has the code — it just
needs a key.

1. Go to **resend.com** and **sign up using saabika.tyagi@gmail.com**.
   (This matters: until you add a website domain, Resend can only deliver to the
   address you signed up with — which is exactly where you want the alerts.)
2. In Resend, open **API Keys → Create API Key**. Copy the key (starts with `re_`).
3. Go to your **Render dashboard → your `midbid` service → Environment**.
4. Click **Add Environment Variable**:
   - **Key:** `RESEND_API_KEY`
   - **Value:** paste the key you copied
5. Click **Save changes**. Render restarts the app. Done — new sign-ups now email you.

First time, check your spam folder; the sender is `onboarding@resend.dev`.

> Later, if you want **users** to get a welcome email too (not just you), you'll need to
> verify a domain in Resend. Until then, only your own alert emails are delivered.

---

## C. Open your Admin Portal

1. On your live site, make sure you have an account using **saabika.tyagi@gmail.com**
   (sign up there if you haven't).
2. Log in. An **Admin** link appears in the top menu.
3. That's your control room: Dashboard, Users, Cases.

Only the admin email sees this. Everyone else just sees their own cases.

---

## D. Which files to upload to GitHub

Upload these over the existing ones (Render redeploys automatically after each commit).
Easiest is folder by folder — go **into** the folder on GitHub first, then
**Add file → Upload files**.

**Repo root** (Add file → Upload files at the top level):
- `server.js`
- `db.js`
- `mailer.js`
- `package.json`
- `package-lock.json`
- `render.yaml`

**Inside the `views` folder:**
- `home.ejs`
- `admin.ejs`
- `admin-users.ejs`
- `admin-cases.ejs`
- `admin-case.ejs`

**Inside `views/partials`:**
- `head.ejs`

**Inside `public`:**
- `styles.css`

(If you'd rather not pick files, the whole updated project is in the zip — but uploading
these is enough.)

After the files are up **and** the `RESEND_API_KEY` is set, you're fully live with
the admin portal and email alerts.
