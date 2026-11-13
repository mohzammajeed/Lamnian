# Lamnian — community website (Vercel + Firebase)

Weather forecast, local news, photo gallery, events, notice board, local directory and an AI
assistant slot. Everything visitors submit waits for **your approval**.

**How it runs on Vercel**
- `public/` → the website pages (static)
- `api/[...path].js` + `lib/` → the backend (Vercel serverless function)
- Posts, photos and settings are stored in your **Firebase Realtime Database**
- Admin login = **Sign in with Google**, allowed only for the emails in `config.json → firebase.adminEmails`
  (currently `mohzammajeed@gmail.com`)

## Deploy (one time, ~10 minutes)

1. **Put the project on Vercel** — push this folder to GitHub and import it in Vercel
   (Framework Preset: *Other*; leave build/output settings empty — `vercel.json` handles it).
2. **Create a Firebase service-account key** (this is how the backend talks to your database):
   Firebase console → ⚙ Project settings → **Service accounts** → *Generate new private key* → a `.json` file downloads.
3. **Give it to Vercel**: Vercel → your project → Settings → **Environment Variables** → add
   `FIREBASE_SERVICE_ACCOUNT` = the **entire contents** of that `.json` file (all environments). 
   Treat it like a password: never put it in GitHub or in `config.json`.
4. **Allow your website address for Google sign-in**: Firebase console → Authentication → Settings →
   **Authorized domains** → add `your-project.vercel.app` (and your own domain if you have one).
5. **Lock the database** (the backend uses its own key, so public access is not needed):
   Realtime Database → Rules → paste `firebase-rules/database.rules.json` → Publish.
6. **Redeploy** in Vercel (Deployments → ⋯ → Redeploy) so the new variable is picked up.
7. Open `https://your-site/admin` → **Sign in with Google**.

If something is missing the site tells you what: e.g. “The database is not connected yet…”.

## Connect your AI (later)

Vercel → Settings → Environment Variables, then redeploy. The chat switches on by itself and already
knows today’s weather, news and events:

    LAMNIAN_AI_PROVIDER=anthropic     # or: openai | webhook
    LAMNIAN_AI_KEY=your-api-key
    # optional: LAMNIAN_AI_MODEL=model-name

Own AI server? `LAMNIAN_AI_PROVIDER=webhook` and `LAMNIAN_AI_WEBHOOK=https://your-server/chat`;
it receives `{messages, context, system}` and must answer `{"reply": "..."}`.

## Good to know

- New approved posts appear within about 30 seconds (pages are cached for speed).
- Photos are shrunk in the browser to ≤1280 px and stored in the database (≈100–300 KB each).
  The free database (1 GB) holds thousands. Deleting a post deletes its photo.
- Spam protection: honeypot field, 8 posts per hour per visitor (shared across servers), photo checks, your approval.
- Backup: Admin → Settings → Download backup (posts and settings; photos stay in Firebase).
- Change location, prayer settings, emergency numbers and admin emails in `config.json`
  (or set `ADMIN_EMAILS=a@x.com,b@y.com` in Vercel).
- Coordinates are set to Lamnian, Azad Kashmir — please check them.

## Run on your own computer (optional)

    node server.js        # http://localhost:3000

Uses a local file database (`data/db.json`) unless `FIREBASE_SERVICE_ACCOUNT` is set.
Google sign-in works on localhost too. For a quick password login while testing:
`ADMIN_PASSWORD=choose-one ALLOW_PASSWORD_LOGIN=1 node server.js`.
