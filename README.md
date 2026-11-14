# Lamnian — community website (Vercel + Firebase)

Weather, local news, photo gallery, events, notice board, local directory and an AI assistant slot.
Everything visitors submit waits for **your approval**.

## How it saves data (same idea as the RishtaCV site)

The **browser talks to Firebase directly**. There is no custom login and no service-account key.

| What | Where it is stored |
|---|---|
| Posts (news, gallery, events, notices, directory) | Firestore `news`, `gallery`, `events`, `notices`, `directory` → one document per post |
| Photos | inside the post document (`image`, shrunk to < 400 KB in the browser) |
| Private phone numbers (news + gallery) | Firestore `contacts/{postId}` — only the admin can read it |
| Banner at the top of the site | Firestore `settings/alert` |
| Admin login | Firebase Authentication → Google |

Each post has `status`: `pending` → `approved` / `rejected`. Visitors can only create `pending` posts and
only read `approved` ones. **`firestore.rules` is what enforces this** (and who the admin is).

All of it is in one file: `db.js`.

The small server part (`api/index.js`) only handles things that cannot run in the browser:
`/api/weather`, `/api/prayer`, `/api/ai`. It stores nothing.

```
index.html  admin.html  style.css  admin.css  theme.js  common.js  app.js  admin.js   the website
db.js            all saving/loading (browser → Firebase)
config.json      site name, location, emergency numbers, Firebase web config
firestore.rules  paste into Firebase → Firestore → Rules
api/index.js     weather + prayer times + AI chat (Vercel needs this one file inside a folder named api)
vercel.json  package.json  favicon.svg
```

## Deploy (one time, ~5 minutes)

1. **Firebase console → Build → Firestore Database → Create database** (any location, start in production mode).
2. **Firestore → Rules** → paste the whole `firestore.rules` file → **Publish**.
3. **Authentication → Sign-in method** → turn on **Google**.
4. **Authentication → Settings → Authorized domains** → add `your-project.vercel.app` (and your own domain).
5. **Vercel**: push this folder to GitHub → import in Vercel (Framework Preset: *Other*, leave build/output/install commands empty).
   **No environment variables are needed** for the site itself.
6. Open `https://your-site/admin` → **Sign in with Google** with the admin Gmail.

The old Realtime Database is no longer used; you can leave it.

### Change the admin
Edit the email list in `isAdmin()` at the top of `firestore.rules` and publish the rules again.
That list is the only place that decides who is admin.

## AI assistant (later)

Vercel → Settings → Environment Variables, then redeploy. The chat switches on by itself:

    LAMNIAN_AI_PROVIDER=anthropic     # or: openai | webhook
    LAMNIAN_AI_KEY=your-api-key
    # optional: LAMNIAN_AI_MODEL=model-name

Own AI server: `LAMNIAN_AI_PROVIDER=webhook` and `LAMNIAN_AI_WEBHOOK=https://your-server/chat`
(it receives `{messages, context, system}` and must answer `{"reply": "..."}`).

## Good to know

- Spam protection: hidden honeypot field, 8 posts per hour per browser, size/field checks in the rules, and your approval
  (nothing is public until you approve). Firestore rules cannot limit per IP; if spam ever becomes a problem, turn on Firebase App Check.
- Free Firebase limits: 50,000 reads/day. Each page visit reads the approved posts once.
- Backup: Admin → Settings → Download backup (posts and settings; photos are left out).
- Change location, prayer settings and emergency numbers in `config.json`.
- Coordinates are set to Lamnian, Azad Kashmir — please check them.
