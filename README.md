# Factory Face Recognition Attendance System

Runs entirely in the browser (face detection + matching happens on-device via face-api.js).
Works on Android and iPhone through the phone's browser — no app install needed.

## How it works
- **Enroll Worker**: capture each worker's face once, save name + employee ID.
- **Mark Attendance**: point any phone/tablet camera at a worker — it auto-detects,
  matches against enrolled faces, and logs check-in/check-out with a timestamp.
  First scan of the day = check-in, next scan = check-out, and so on.
- **Report**: view attendance by date.
- All data (worker faces, attendance logs) lives on your server (`data/workers.json`
  and `data/attendance.json`), so every device hitting the same server sees the same records.

## IMPORTANT: HTTPS is required
Phone browsers only allow camera access (`getUserMedia`) over **HTTPS** (or `localhost`
for testing). You cannot just open this over plain `http://` on a phone.

Options:
1. **Deploy on your Hostinger VPS** (you already have one for the WordPress site) if it
   supports Node.js, with a free SSL cert (Let's Encrypt / Hostinger's built-in SSL).
2. **Use a free tunnel for quick testing**: run locally, then expose via `ngrok http 3000`
   — gives you an HTTPS URL instantly to test on your phone.
3. **Deploy to a small cloud host** (Railway, Render, a DigitalOcean droplet, etc.) — all
   give you HTTPS out of the box.

## Setup
```bash
cd face-attendance
npm install
npm start
```
Server runs on port 3000 by default. Visit the HTTPS URL from any phone browser.

## Using it at the factory
- Put a phone/tablet on a stand at the entrance, open the site, keep it on the
  "Mark Attendance" tab. It runs continuously — workers just walk up and look at it.
- Use "Enroll Worker" once per employee (best done indoors, good lighting, face straight-on).
- On iPhone/Android, tap "Add to Home Screen" from the browser share menu so it opens
  like an app.

## Tuning accuracy
In `server.js`, `MATCH_THRESHOLD` (default 0.5) controls strictness:
- Lower (e.g. 0.4) = stricter matching, fewer false positives, but may reject valid faces
  in poor lighting.
- Higher (e.g. 0.6) = more lenient, but risk of mismatching similar-looking faces.
Test with your actual workforce and adjust.

## Known limitations / next steps for a production rollout
- JSON file storage is fine for tens to low hundreds of workers. For a bigger workforce
  or multiple factory locations, swap in a real database (SQLite/Postgres) — the API
  layer stays the same.
- No login/admin auth yet — anyone with the URL can enroll/delete workers. Add a simple
  password gate on the Enroll and Report tabs before deploying for real.
- No liveness detection (a printed photo could theoretically fool it). If that's a risk
  at your factory, we can add a blink/movement check.
- Descriptors (face "fingerprints") are stored as plain numbers, not photos — reasonably
  private, but you should still tell workers their face data is being stored.
