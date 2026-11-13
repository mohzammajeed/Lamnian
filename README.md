# Lamnian — community website

Weather forecast, local news, photo gallery, events, notice board, local directory
and an AI assistant slot — for the people of Lamnian.
Everything people submit waits for **your approval** before it appears.

No installs needed: it uses only Node.js (version 18 or newer).

## Run it

    node server.js

Open http://localhost:3000 (site) and http://localhost:3000/admin (admin panel).

Until you add an admin email (see below), an admin password is generated on first run, printed in the terminal and saved in
`data/admin-password.txt`. To choose your own, set `ADMIN_PASSWORD=...` before starting.

## What's inside

| Section | Who adds content | Notes |
|---|---|---|
| Weather (live) | automatic | Open-Meteo, no API key. 24 h chart, 7 days, sun, air quality, smart tips |
| Prayer times | automatic | Aladhan (Karachi method, Hanafi Asr) — change in `config.json` |
| News, Photos, Events, Notices, Directory | visitors submit → you approve | Phone numbers marked "only admin sees" are never public |
| Alert banner | you (Admin → Settings) | e.g. "Road closed due to landslide" |
| Emergency numbers | you (`config.json`) | Please double-check them for your area |
| AI assistant | you, later | Shows "coming soon" until connected |

## Connect your AI (later)

Set environment variables where the server runs, restart, and the chat on the site
switches on by itself (it already knows today's weather, news and events):

    LAMNIAN_AI_PROVIDER=anthropic     # or: openai | webhook
    LAMNIAN_AI_KEY=your-api-key
    # optional: LAMNIAN_AI_MODEL=model-name

Own AI server? Use `LAMNIAN_AI_PROVIDER=webhook` and `LAMNIAN_AI_WEBHOOK=https://your-server/chat`.
It receives `{messages, context, system}` and must answer `{"reply": "..."}`.
Never put API keys in files under `public/`.

## Admin sign-in with Google (Firebase)

Firebase is used **only** to prove who is signing in. The server checks Google's signature,
the project, and that the verified email is on your admin list, then starts its own session.

1. In `config.json` set your Google email(s):  `"firebase": { "adminEmails": ["you@gmail.com"], ... }`
   (or set the `ADMIN_EMAILS` environment variable, comma-separated), then restart.
2. Open `/admin` → **Sign in with Google**. Once an admin email is set, the password login
   is switched off (set `ALLOW_PASSWORD_LOGIN=1` if you want to keep it as a backup).
3. Firebase console → Authentication → Settings → **Authorized domains**: add the domain
   your site is on (localhost already works).
4. Your Realtime Database is not used by this site. Lock it:
   Realtime Database → Rules → paste `firebase-rules/database.rules.json` → Publish.
   (Databases created in "test mode" are open to everyone until they expire.)

The Firebase web config in `config.json` is public by design — it is not a secret.
What protects the admin panel is the server-side email check.

## Change location / settings

Edit `config.json` (coordinates are set to Lamnian, Azad Kashmir — **please check them**).

## Putting it online

Needs a host that runs Node.js **and keeps files** (a small VPS, or Render/Railway with a
persistent disk) — your posts and photos are stored in `data/` and `uploads/`.
Behind a proxy/HTTPS set `TRUST_PROXY=1` and `ADMIN_PASSWORD`. Back up via Admin → Settings.

## Safety built in

Admin login rate-limited · posts and AI questions rate-limited per visitor · photos verified
and shrunk · spam trap field · all text escaped · strict Content-Security-Policy.
