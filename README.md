# Lamnian

Community website for Lamnian: live weather, prayer times, local news, photo gallery, events, notices and a local directory. Static site on Vercel, Firebase (Spark plan) for data.

## Files
| File | Purpose |
|---|---|
| `index.html` | The whole public site (inline CSS and JS) |
| `admin.html` | Admin panel at `/admin`: approve or delete posts (Google sign-in) |
| `firestore.rules` | Firestore security rules (paste into Firebase console) |
| `api/weather.js` | Serverless function: calls Open-Meteo with your private API key |
| `vercel.json` | Clean URLs (`/admin`) and security headers |
| `404.html` | Not-found page |
| `favicon.svg`, `robots.txt` | Icon; keeps `/admin` out of search |

## Setup
1. **Firestore:** create the database, then paste `firestore.rules` into Rules and Publish.
2. **Authentication:** enable the Google provider. Add your Vercel domain (and custom domain) under Settings → Authorized domains.
3. **GitHub:** push all files to the repo root.
4. **Vercel:** import the repo. Framework preset: Other. No build command, no output directory.
5. Open `/admin`, sign in with the admin Google account, and approve posts.

## Settings
Edit the `CFG` block near the top of the script in `index.html`:
- `lat`, `lon`: Lamnian's coordinates (weather, air quality, prayer times)
- `region`: text shown above the title
- `prayerMethod`: Aladhan calculation method (1 = Karachi)

## How posts work
Visitors submit through **Contribute**. Photos are shrunk in the browser (max 900 px JPEG) and stored inside the Firestore document. Posts are saved with `approved: false` and only appear after approval in `/admin`.

## Weather API key
In Vercel → Settings → Environment Variables add `OPEN_METEO_API_KEY` (all environments), then redeploy. The site calls `/api/weather`; if that fails it falls back to the free Open-Meteo endpoint.

## Never commit
Service account keys and API keys that must stay private. Put them in Vercel → Settings → Environment Variables. The `.gitignore` already skips `.env` and service account files. The Firebase web config in `index.html` is public by design; the Firestore rules are what protect your data.
