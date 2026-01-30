# Need-a-Cab Webhooks (Tracks)

## What this is
- **POST /tracks**: webhook receiver (Autocab should send JSON here)
- **GET /tracks**: dashboard to view recent webhook payloads
- **GET /api/tracks**: JSON API for latest payloads

## Run locally
```bash
npm install
npm start
```
Then open:
- http://localhost:3000/tracks

Test webhook:
```bash
curl -X POST http://localhost:3000/tracks \
  -H "Content-Type: application/json" \
  -d '{"hello":"world","source":"test"}'
```

## Deploy to Render
1. Create a new **Web Service** from this repo (or upload as a project).
2. Render will run `npm install` and `npm start`.
3. Add your custom domain in Render and point your DNS to Render.

> Note: storage is NDJSON appended to a file under `DATA_DIR`.
> On Render, this project defaults `DATA_DIR=/tmp/data` (ephemeral). If you want persistence across deploys/restarts, switch to a database (MongoDB/Postgres) or a Render disk.
