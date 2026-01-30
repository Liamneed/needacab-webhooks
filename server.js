import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

// --- request logging (so you can see Autocab hits in Render logs) ---
app.use((req, res, next) => {
  console.log(
    `[REQ] ${req.method} ${req.originalUrl} ct=${req.headers["content-type"] || ""}`
  );
  next();
});

// --- middleware ---
// Accept JSON when it is JSON
app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  })
);
// Also accept raw text for anything else so we don't silently drop Autocab payloads
app.use(
  express.text({
    limit: "2mb",
    type: "*/*",
  })
);

// --- storage ---
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "tracks.ndjson");
fs.mkdirSync(DATA_DIR, { recursive: true });

let recent = [];
const MAX_RECENT = 500;

// load last N events from disk on boot
if (fs.existsSync(STORE_FILE)) {
  const raw = fs.readFileSync(STORE_FILE, "utf8").trim();
  if (raw) {
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-MAX_RECENT);
    recent = tail
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

function storeEvent(payload, meta) {
  const evt = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    meta,
    payload,
  };

  recent.unshift(evt);
  if (recent.length > MAX_RECENT) recent.pop();

  fs.appendFileSync(STORE_FILE, JSON.stringify(evt) + "\n");
  return evt;
}

// --- webhook receiver ---
// Autocab should POST here: https://autocab.needacabwebhooks.co.uk/tracks
app.post("/tracks", (req, res) => {
  const meta = {
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"] || null,
    contentType: req.headers["content-type"] || null,
  };

  let payload = req.body;

  // If body arrived as text, try parse JSON; otherwise store raw
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (trimmed) {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        payload = { _raw: payload };
      }
    } else {
      payload = { _empty: true };
    }
  }

  if (payload == null) payload = { _empty: true };

  const evt = storeEvent(payload, meta);
  res.status(200).json({ ok: true, id: evt.id });
});

// --- API for dashboard ---
app.get("/api/tracks", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  res.json({ ok: true, count: recent.length, items: recent.slice(0, limit) });
});

app.get("/api/tracks/:id", (req, res) => {
  const item = recent.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, item });
});

// --- viewer page ---
app.get("/tracks", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Need-a-Cab Webhooks · Tracks</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0d10;color:#e9eef4}
    header{padding:16px 18px;border-bottom:1px solid #202630;position:sticky;top:0;background:#0b0d10}
    .wrap{max-width:1200px;margin:0 auto;padding:16px}
    .grid{display:grid;grid-template-columns:420px 1fr;gap:14px}
    .card{background:#12161c;border:1px solid #202630;border-radius:16px;overflow:hidden}
    .card h3{margin:0;padding:12px 14px;border-bottom:1px solid #202630;font-size:14px;color:#9bb0c2}
    .list{max-height:70vh;overflow:auto}
    .row{padding:12px 14px;border-bottom:1px solid #202630;cursor:pointer}
    .row:hover{background:#0f1319}
    .muted{color:#9bb0c2;font-size:12px}
    pre{margin:0;padding:14px;max-height:70vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    button{background:#1b222c;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px;cursor:pointer}
    button:hover{background:#202836}
    input{background:#0f1319;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px;width:120px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1b222c;border:1px solid #2a3340;font-size:12px;color:#cfe1f3}
    @media (max-width: 980px){ .grid{grid-template-columns:1fr} .list, pre{max-height:45vh} }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="topbar">
        <div style="font-weight:700">Need-a-Cab Webhooks</div>
        <span class="pill">/tracks</span>
        <span class="muted" id="status">Loading…</span>
        <div style="flex:1"></div>
        <label class="muted">Limit</label>
        <input id="limit" type="number" min="1" max="200" value="50"/>
        <button id="refresh">Refresh</button>
        <button id="auto">Auto: ON</button>
      </div>
    </div>
  </header>

  <div class="wrap">
    <div class="grid">
      <div class="card">
        <h3>Latest payloads</h3>
        <div class="list" id="list"></div>
      </div>

      <div class="card">
        <h3>Selected payload</h3>
        <pre id="detail" class="muted">Click an item to view its JSON…</pre>
      </div>
    </div>
  </div>

<script>
  let auto = true;
  let timer = null;
  let selectedId = null;

  function fmt(s){ try { return new Date(s).toLocaleString(); } catch { return s; } }

  async function load() {
    const limit = Math.max(1, Math.min(200, Number(document.getElementById('limit').value || 50)));
    const status = document.getElementById('status');
    status.textContent = 'Refreshing…';

    const res = await fetch('/api/tracks?limit=' + limit, { cache: 'no-store' });
    const data = await res.json();

    const list = document.getElementById('list');
    list.innerHTML = '';

    if (!data.ok || !data.items?.length) {
      list.innerHTML = '<div class="row"><div>No payloads received yet.</div><div class="muted">Autocab needs to POST to /tracks</div></div>';
      status.textContent = 'Ready';
      return;
    }

    for (const item of data.items) {
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.id = item.id;

      const keys = item.payload && typeof item.payload === 'object'
        ? Object.keys(item.payload).slice(0, 8).join(', ')
        : '(non-object payload)';

      div.innerHTML =
        '<div style="display:flex;justify-content:space-between;gap:10px">' +
          '<div>' +
            '<div><b>' + fmt(item.receivedAt) + '</b></div>' +
            '<div class="muted">Keys: ' + (keys || '-') + '</div>' +
          '</div>' +
          '<div class="muted" style="text-align:right">' +
            '<div>' + ((item.meta?.ip || '').toString().slice(0, 30)) + '</div>' +
            '<div>' + (item.meta?.contentType || '') + '</div>' +
          '</div>' +
        '</div>';

      div.onclick = () => select(item.id);
      list.appendChild(div);
    }

    if (!selectedId && data.items[0]) select(data.items[0].id);

    status.textContent = 'Last update: ' + new Date().toLocaleTimeString();
  }

  async function select(id) {
    selectedId = id;
    const res = await fetch('/api/tracks/' + id, { cache: 'no-store' });
    const data = await res.json();
    const detail = document.getElementById('detail');
    if (!data.ok) {
      detail.textContent = 'Not found.';
      return;
    }
    detail.textContent = JSON.stringify(data.item, null, 2);
  }

  function setAuto(on) {
    auto = on;
    document.getElementById('auto').textContent = 'Auto: ' + (auto ? 'ON' : 'OFF');
    if (timer) clearInterval(timer);
    if (auto) timer = setInterval(load, 3000);
  }

  document.getElementById('refresh').onclick = load;
  document.getElementById('auto').onclick = () => setAuto(!auto);

  setAuto(true);
  load();
</script>
</body>
</html>`);
});

app.get("/", (req, res) => res.redirect("/tracks"));

// body parser errors (invalid JSON etc.)
app.use((err, req, res, next) => {
  console.error("[BODY ERROR]", err?.message || err);
  res.status(400).send("Bad Request");
});

app.listen(PORT, () => {
  console.log("Need-a-Cab Webhooks listening on", PORT);
});
