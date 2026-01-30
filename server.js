import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const MAX_RECENT_PER_HOOK = Number(process.env.MAX_RECENT_PER_HOOK || 500);

// Optional allowlist: comma-separated hook names, e.g. "tracks,modify,cancel"
const HOOK_ALLOWLIST = (process.env.HOOK_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isHookAllowed(hook) {
  if (!hook) return false;
  // only allow letters, numbers, dash, underscore
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(hook)) return false;
  if (HOOK_ALLOWLIST.length === 0) return true;
  return HOOK_ALLOWLIST.includes(hook);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Request logging ----
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl} ct=${req.headers["content-type"] || ""}`);
  next();
});

// ---- Body parsing: accept JSON or any text ----
app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "application/*+json"],
  })
);
app.use(
  express.text({
    limit: "2mb",
    type: "*/*",
  })
);

// ---- Storage (per hook) ----
// In-memory: { [hook]: [events...] }
const recentByHook = new Map();

function hookFile(hook) {
  return path.join(DATA_DIR, `${hook}.ndjson`);
}

function loadHook(hook) {
  const file = hookFile(hook);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const lines = raw.split("\n").filter(Boolean);
  const tail = lines.slice(-MAX_RECENT_PER_HOOK);
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureHookLoaded(hook) {
  if (!recentByHook.has(hook)) recentByHook.set(hook, loadHook(hook));
  return recentByHook.get(hook);
}

function storeEvent(hook, payload, meta) {
  const evt = {
    id: crypto.randomUUID(),
    hook,
    receivedAt: new Date().toISOString(),
    meta,
    payload,
  };

  const arr = ensureHookLoaded(hook);
  arr.unshift(evt);
  if (arr.length > MAX_RECENT_PER_HOOK) arr.pop();

  fs.appendFileSync(hookFile(hook), JSON.stringify(evt) + "\n");
  return evt;
}

function listHooksOnDisk() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    const hooks = files
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => f.replace(/\.ndjson$/, ""))
      .filter((h) => isHookAllowed(h));
    hooks.sort((a, b) => a.localeCompare(b));
    return hooks;
  } catch {
    return [];
  }
}

// ---- Search helpers ----
function normalizeQ(q) {
  const s = (q || "").toString().trim();
  return s.length ? s : "";
}

function eventMatchesQ(evt, qLower) {
  if (!qLower) return true;

  // Search across: id, hook, receivedAt, meta values, payload JSON
  const metaStr = JSON.stringify(evt.meta || {});
  const payloadStr = (() => {
    try {
      return typeof evt.payload === "string" ? evt.payload : JSON.stringify(evt.payload || {});
    } catch {
      return String(evt.payload || "");
    }
  })();

  const haystack =
    `${evt.id} ${evt.hook} ${evt.receivedAt} ${metaStr} ${payloadStr}`.toLowerCase();

  return haystack.includes(qLower);
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---- Webhook receiver (ANY hook) ----
// Autocab can POST to: /tracks, /modify, /cancel, etc.
app.post("/:hook", (req, res) => {
  const hook = (req.params.hook || "").trim();

  // Don't allow posting to internal paths
  if (hook === "api" || hook === "dashboard") {
    return res.status(404).json({ ok: false, error: "Unknown webhook" });
  }

  if (!isHookAllowed(hook)) {
    return res.status(404).json({ ok: false, error: "Unknown webhook" });
  }

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

  const evt = storeEvent(hook, payload, meta);
  res.status(200).json({ ok: true, id: evt.id, hook: evt.hook });
});

// ---- API ----
app.get("/api/hooks", (req, res) => {
  const hooks = listHooksOnDisk();
  res.json({ ok: true, hooks });
});

// list events for a hook, supports q= search
app.get("/api/hooks/:hook", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).json({ ok: false, error: "Not found" });

  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
  const q = normalizeQ(req.query.q);
  const qLower = q.toLowerCase();

  const arr = ensureHookLoaded(hook);
  const filtered = q ? arr.filter((evt) => eventMatchesQ(evt, qLower)) : arr;

  res.json({ ok: true, hook, q, count: filtered.length, items: filtered.slice(0, limit) });
});

app.get("/api/hooks/:hook/:id", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).json({ ok: false, error: "Not found" });

  const arr = ensureHookLoaded(hook);
  const item = arr.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, item });
});

// Export NDJSON (optionally filtered with q)
app.get("/api/hooks/:hook/export.ndjson", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).send("Not found");

  const q = normalizeQ(req.query.q);
  const qLower = q.toLowerCase();

  const arr = ensureHookLoaded(hook);
  const filtered = q ? arr.filter((evt) => eventMatchesQ(evt, qLower)) : arr;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${hook}${q ? "-filtered" : ""}.ndjson"`);
  res.send(filtered.map((e) => JSON.stringify(e)).join("\n") + (filtered.length ? "\n" : ""));
});

// Export CSV (optionally filtered with q)
app.get("/api/hooks/:hook/export.csv", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).send("Not found");

  const q = normalizeQ(req.query.q);
  const qLower = q.toLowerCase();

  const arr = ensureHookLoaded(hook);
  const filtered = q ? arr.filter((evt) => eventMatchesQ(evt, qLower)) : arr;

  const header = ["receivedAt", "id", "hook", "ip", "contentType", "userAgent", "payloadJson"];
  const rows = [header.join(",")];

  for (const e of filtered) {
    const payloadJson =
      typeof e.payload === "string" ? e.payload : (() => { try { return JSON.stringify(e.payload ?? {}); } catch { return String(e.payload ?? ""); } })();

    rows.push(
      [
        csvEscape(e.receivedAt),
        csvEscape(e.id),
        csvEscape(e.hook),
        csvEscape(e.meta?.ip || ""),
        csvEscape(e.meta?.contentType || ""),
        csvEscape(e.meta?.userAgent || ""),
        csvEscape(payloadJson),
      ].join(",")
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${hook}${q ? "-filtered" : ""}.csv"`);
  res.send(rows.join("\n") + "\n");
});

// ---- Dashboard ----
app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/dashboard", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Need-a-Cab Webhooks · Dashboard</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0d10;color:#e9eef4}
    header{padding:16px 18px;border-bottom:1px solid #202630;position:sticky;top:0;background:#0b0d10;z-index:10}
    .wrap{max-width:1400px;margin:0 auto;padding:16px}
    .grid{display:grid;grid-template-columns:420px 1fr;gap:14px}
    .card{background:#12161c;border:1px solid #202630;border-radius:16px;overflow:hidden}
    .card h3{margin:0;padding:12px 14px;border-bottom:1px solid #202630;font-size:14px;color:#9bb0c2;display:flex;justify-content:space-between;align-items:center;gap:10px}
    .list{max-height:72vh;overflow:auto}
    .row{padding:12px 14px;border-bottom:1px solid #202630;cursor:pointer}
    .row:hover{background:#0f1319}
    .muted{color:#9bb0c2;font-size:12px}
    pre{margin:0;padding:14px;max-height:72vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    button,a.btn{background:#1b222c;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    button:hover,a.btn:hover{background:#202836}
    input,select{background:#0f1319;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px}
    input{width:160px}
    input.search{width:260px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1b222c;border:1px solid #2a3340;font-size:12px;color:#cfe1f3}
    .kv{display:flex;gap:10px;align-items:center}
    .kv label{font-size:12px;color:#9bb0c2}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    @media (max-width: 980px){ .grid{grid-template-columns:1fr} .list, pre{max-height:45vh} input.search{width:100%} }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="topbar">
        <div style="font-weight:800">Need-a-Cab Webhooks</div>
        <span class="pill" id="hookPill">loading…</span>
        <span class="muted" id="status">Loading…</span>
        <div style="flex:1"></div>

        <div class="kv">
          <label>Webhook</label>
          <select id="hookSelect"></select>
        </div>

        <div class="kv">
          <label>Search</label>
          <input id="q" class="search" type="text" placeholder="bookingId / jobId / driverId / any text"/>
        </div>

        <div class="kv">
          <label>Limit</label>
          <input id="limit" type="number" min="1" max="200" value="50"/>
        </div>

        <button id="refresh">Refresh</button>
        <button id="auto">Auto: ON</button>

        <a class="btn" id="dlNdjson" href="#" download>Download NDJSON</a>
        <a class="btn" id="dlCsv" href="#" download>Download CSV</a>
      </div>

      <div class="muted" style="margin-top:8px">
        Receiver endpoints: <span class="pill">POST /{hook}</span>
        e.g. <span class="pill">/tracks</span> <span class="pill">/modify</span>
      </div>
    </div>
  </header>

  <div class="wrap">
    <div class="grid">
      <div class="card">
        <h3>
          <span>Latest payloads (selected webhook)</span>
          <span class="muted" id="count"></span>
        </h3>
        <div class="list" id="list"></div>
      </div>

      <div class="card">
        <h3>
          <span>Selected payload</span>
          <span class="actions">
            <button id="copyBtn" title="Copy selected JSON">Copy JSON</button>
          </span>
        </h3>
        <pre id="detail" class="muted">Select a webhook and click an event…</pre>
      </div>
    </div>
  </div>

<script>
  let auto = true;
  let timer = null;
  let selectedId = null;
  let selectedHook = null;

  const qs = new URLSearchParams(location.search);
  function fmt(s){ try { return new Date(s).toLocaleString(); } catch { return s; } }

  function setStatus(txt){ document.getElementById('status').textContent = txt; }
  function setCount(txt){ document.getElementById('count').textContent = txt || ''; }
  function setHookPill(h){ document.getElementById('hookPill').textContent = '/' + (h || ''); }

  function getQ(){
    const v = (document.getElementById('q').value || '').trim();
    return v;
  }

  function updateDownloadLinks(){
    if (!selectedHook) return;
    const q = getQ();
    const u1 = new URL('/api/hooks/' + encodeURIComponent(selectedHook) + '/export.ndjson', location.origin);
    const u2 = new URL('/api/hooks/' + encodeURIComponent(selectedHook) + '/export.csv', location.origin);
    if (q) { u1.searchParams.set('q', q); u2.searchParams.set('q', q); }
    document.getElementById('dlNdjson').href = u1.toString();
    document.getElementById('dlCsv').href = u2.toString();
  }

  async function loadHooks() {
    const res = await fetch('/api/hooks', { cache: 'no-store' });
    const data = await res.json();
    const hooks = (data && data.ok && data.hooks) ? data.hooks : [];

    const sel = document.getElementById('hookSelect');
    sel.innerHTML = '';

    if (!hooks.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No hooks yet (send one)';
      sel.appendChild(opt);
      return;
    }

    for (const h of hooks) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = '/' + h;
      sel.appendChild(opt);
    }

    const fromUrl = qs.get('hook');
    selectedHook = fromUrl && hooks.includes(fromUrl) ? fromUrl : (hooks[0] || null);
    sel.value = selectedHook || '';
    setHookPill(selectedHook);

    const qFromUrl = qs.get('q') || '';
    if (qFromUrl) document.getElementById('q').value = qFromUrl;

    sel.onchange = () => {
      selectedHook = sel.value;
      selectedId = null;
      setHookPill(selectedHook);
      const u = new URL(location.href);
      u.searchParams.set('hook', selectedHook);
      history.replaceState({}, '', u);
      updateDownloadLinks();
      load();
    };
  }

  let qTimer = null;
  function onSearchChanged(){
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const u = new URL(location.href);
      const q = getQ();
      if (q) u.searchParams.set('q', q);
      else u.searchParams.delete('q');
      history.replaceState({}, '', u);
      updateDownloadLinks();
      load();
    }, 250);
  }

  async function load() {
    if (!selectedHook) { setStatus('No hooks yet'); return; }

    const limit = Math.max(1, Math.min(200, Number(document.getElementById('limit').value || 50)));
    const q = getQ();

    setStatus('Refreshing…');

    const url = new URL('/api/hooks/' + encodeURIComponent(selectedHook), location.origin);
    url.searchParams.set('limit', String(limit));
    if (q) url.searchParams.set('q', q);

    const res = await fetch(url.toString(), { cache: 'no-store' });
    const data = await res.json();

    const list = document.getElementById('list');
    list.innerHTML = '';

    if (!data.ok || !data.items?.length) {
      list.innerHTML = '<div class="row"><div>No payloads for this webhook yet.</div><div class="muted">Autocab needs to POST to /' + selectedHook + '</div></div>';
      setCount('');
      setStatus('Ready');
      return;
    }

    setCount((data.count || 0) + ' match' + ((data.count || 0) === 1 ? '' : 'es') + (q ? ' (filtered)' : ''));

    for (const item of data.items) {
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.id = item.id;

      const keys = item.payload && typeof item.payload === 'object'
        ? Object.keys(item.payload).slice(0, 10).join(', ')
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
    setStatus('Last update: ' + new Date().toLocaleTimeString());
  }

  let currentSelectedJson = null;

  async function select(id) {
    selectedId = id;
    const res = await fetch('/api/hooks/' + encodeURIComponent(selectedHook) + '/' + encodeURIComponent(id), { cache: 'no-store' });
    const data = await res.json();
    const detail = document.getElementById('detail');
    if (!data.ok) { detail.textContent = 'Not found.'; currentSelectedJson = null; return; }
    currentSelectedJson = JSON.stringify(data.item, null, 2);
    detail.textContent = currentSelectedJson;
  }

  async function copySelected(){
    if (!currentSelectedJson) return alert('Nothing selected to copy yet.');
    try {
      await navigator.clipboard.writeText(currentSelectedJson);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = currentSelectedJson;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setStatus('Copied JSON to clipboard');
    setTimeout(() => setStatus('Last update: ' + new Date().toLocaleTimeString()), 900);
  }

  function setAuto(on) {
    auto = on;
    document.getElementById('auto').textContent = 'Auto: ' + (auto ? 'ON' : 'OFF');
    if (timer) clearInterval(timer);
    if (auto) timer = setInterval(load, 3000);
  }

  document.getElementById('refresh').onclick = load;
  document.getElementById('auto').onclick = () => setAuto(!auto);
  document.getElementById('q').addEventListener('input', onSearchChanged);
  document.getElementById('copyBtn').onclick = copySelected;

  (async function init(){
    await loadHooks();
    updateDownloadLinks();
    setAuto(true);
    await load();
  })();
</script>
</body>
</html>`);
});

// body parser errors (invalid JSON etc.)
app.use((err, req, res, next) => {
  console.error("[BODY ERROR]", err?.message || err);
  res.status(400).send("Bad Request");
});

app.listen(PORT, () => {
  console.log("Need-a-Cab Webhooks listening on", PORT);
});
