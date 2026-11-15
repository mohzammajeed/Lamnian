# Lamnian

Community website for Lamnian: live weather, prayer times, local news, photo gallery, events, notices and a local directory. Static site on Vercel, Firebase (Spark plan) for data.

## Files
| File | Purpose |
|---|---|
| `index.html` | The whole public site (inline CSS and JS) |
| `admin.html` | Admin panel at `/admin`: delete any post (Google sign-in) |
| `firestore.rules` | Firestore security rules (paste into Firebase console) |
| `api/weather.js` | Serverless function: calls Open-Meteo with your private API key |
| `vercel.json` | Clean URLs (`/admin`) and security headers |
| `manifest.webmanifest` | Lets people install the site on their phone home screen |
| `sw.js` | Service worker: opens the app shell offline |
| `404.html` | Not-found page |
| `favicon.svg`, `robots.txt` | Icon; keeps `/admin` out of search |

## Setup
1. **Firestore:** create the database, then paste `firestore.rules` into Rules and Publish.
2. **Authentication:** enable the **Google** and **Email/Password** providers. Add your Vercel domain (and custom domain) under Settings → Authorized domains.
3. **GitHub:** push all files to the repo root.
4. **Vercel:** import the repo. Framework preset: Other. No build command, no output directory.
5. Open `/admin`, sign in with the admin Google account, and delete any post.

## User accounts
Users can change their name, request a password reset email, delete all their own posts, or delete their account (which also deletes their posts). They can only touch their own data; the Firestore rules enforce this.

## Comments, refresh, offline
Signed-in users can comment on posts (stored in the `comments` collection; users delete their own, the admin can delete any). Pulling down at the top of a page refreshes the feed and weather. When offline the site shows the last saved weather and posts (without photos).

## App feel
Splash screen, bottom tab bar, slide-in pages, press feedback, safe-area padding for notches, Android back button closes windows before leaving, pull-to-refresh, offline mode. The admin link now lives in the account window (visible only to the admin).

## Settings
Edit the `CFG` block near the top of the script in `index.html`:
- `lat`, `lon`: Lamnian's coordinates (weather, air quality, prayer times)
- `region`: text shown above the title
- `prayerMethod`: Aladhan calculation method (1 = Karachi)

## How posts work
Visitors must sign in (Google or email) to post, using the post box at the top of the feed. Photos are shrunk in the browser (max 900 px JPEG) and stored inside the Firestore document. Posts appear immediately with the poster's name. Users can delete their own posts (🗑 Delete button); the admin can delete any post from `/admin`.

## Weather API key
In Vercel → Settings → Environment Variables add `OPEN_METEO_API_KEY` (all environments), then redeploy. The site calls `/api/weather`; if that fails it falls back to the free Open-Meteo endpoint.

## Never commit
Service account keys and API keys that must stay private. Put them in Vercel → Settings → Environment Variables. The `.gitignore` already skips `.env` and service account files. The Firebase web config in `index.html` is public by design; the Firestore rules are what protect your data.
