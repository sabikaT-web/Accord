# How to put Accord online — the simple version

Goal: take the files in this folder and turn them into a real website with a real
database that anyone can use. No coding. Two parts: first you put the files on
**GitHub** (a free filing cabinet for code), then you point **Render** at them
(Render runs the website and gives you a database automatically).

You do NOT need to run anything on your own computer.

---

## ✅ Which files to upload

Upload EVERYTHING in this folder **except two things**:

UPLOAD these:
- `server.js`
- `db.js`
- `package.json`
- `package-lock.json`
- `render.yaml`
- `README.md`
- `DEPLOY.md`  (this file)
- `.gitignore`
- `.env.example`
- the folder `views`  (with everything inside it)
- the folder `public` (with everything inside it)

❌ DO NOT upload:
- the folder `node_modules`  ← it's huge and Render rebuilds it for you
- any file called `accord.db` ← old test leftover, not needed

---

## Part 1 — Put the files on GitHub (about 5 minutes)

1. Go to **github.com** and make a free account (or log in).
2. Click the **+** in the top-right corner, then **New repository**.
3. Give it a name like `accord`. Leave the rest as-is. Click **Create repository**.
4. On the next page, click the link that says **"uploading an existing file"**.
5. Open this `accord-app` folder on your computer. Select the files and the two
   folders from the **UPLOAD** list above and **drag them into the browser window**.
   (Make sure `node_modules` is NOT among them.)
6. Click the green **Commit changes** button.

Your code now lives on GitHub. 🎉

---

## Part 2 — Put it online with Render (about 5 minutes)

1. Go to **render.com** and click **Get Started**. Sign up **with your GitHub
   account** — this links them together so Render can see your files.
2. Click **New +** (top right) → **Blueprint**.
3. Find your **`accord`** repository in the list and click it / click **Connect**.
4. Render reads the `render.yaml` file and shows it will create **two things**:
   a **Web Service** (your app) and a **Postgres database**. Click **Apply**.
5. Wait a few minutes while it builds. When it finishes, Render shows a web address
   like **`https://accord.onrender.com`**. That is your live website.
6. Open that link, click **Create an account**, and try it. To test both sides,
   open it again in a private/incognito window and sign up as a second person.

That's the whole thing. The database is created and connected for you, and a secret
key is generated automatically. Nothing else to set up.

---

## Good things to know (plain English)

- **First visit is slow.** On the free plan the app "sleeps" after nobody uses it for
  a while, so the very first visit wakes it up and takes a few seconds. Normal.
- **Keep the database for the long term.** The free database is great for trying it,
  but Render's free databases are limited and can expire. When you're serious, open the
  database in Render and upgrade it to a small paid plan so your data stays safe.
- **Your own web address.** Later, to use something like `app.yourname.com`, open your
  Web Service in Render → **Settings → Custom Domains** and follow the prompts.
- **Updating the site.** Change a file, upload the new version to GitHub the same way,
  and Render automatically rebuilds and republishes within a minute or two.

---

## If the "Blueprint" step doesn't work (manual backup path)

1. **New +** → **Postgres** → name it `accord-db` → **Create**. When it's ready, copy
   its **Internal Database URL**.
2. **New +** → **Web Service** → connect your `accord` repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In that Web Service, open **Environment** and add three variables:
   - `DATABASE_URL` = the Internal Database URL you copied
   - `SESSION_SECRET` = any long random text you make up
   - `NODE_ENV` = `production`
4. Click **Create**. Same result as the Blueprint.

---

Still not selling or moving real money yet — that's the regulated escrow step we add
later. This gets your real, usable product online safely.
