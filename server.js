import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config ----
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const MAX_RECENT_PER_HOOK = Number(process.env.MAX_RECENT_PER_HOOK || 500);
const MAX_EXPORT = Number(process.env.MAX_EXPORT || 20000);

// Optional allowlist: comma-separated hook names, e.g. "tracks,modify,cancel"
const HOOK_ALLOWLIST = (process.env.HOOK_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isHookAllowed(hook) {
  if (!hook) return false;
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(hook)) return false;
  if (HOOK_ALLOWLIST.length === 0) return true;
  return HOOK_ALLOWLIST.includes(hook);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Request logging ----
app.use((req, res, next) => {
  console.log(
    `[REQ] ${req.method} ${req.originalUrl} ct=${req.headers["content-type"] || ""}`
  );
  next();
});

// ---- Body parsing ----
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

// ---- Storage ----
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

// ---- Utilities ----
function stringifySafe(x) {
  try {
    if (typeof x === "string") return x;
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function normalizeQ(q) {
  const s = (q || "").toString().trim();
  return s.length ? s : "";
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---- Field-aware token parsing (kept for power users) ----
function tokenizeQuery(q) {
  const tokens = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i])) i++;
    if (i >= q.length) break;

    let start = i;
    let inQuotes = false;
    let quoteChar = null;

    while (i < q.length) {
      const ch = q[i];
      if (!inQuotes && (ch === '"' || ch === "'")) {
        inQuotes = true;
        quoteChar = ch;
        i++;
        continue;
      }
      if (inQuotes && ch === quoteChar) {
        inQuotes = false;
        quoteChar = null;
        i++;
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) break;
      i++;
    }

    const raw = q.slice(start, i).trim();
    if (raw) tokens.push(raw);
  }
  return tokens;
}

function parseTokens(q) {
  const tokens = tokenizeQuery(q);
  const fieldTokens = [];
  const textTokens = [];

  for (const t of tokens) {
    const idx = t.indexOf(":");
    if (idx > 0) {
      const key = t.slice(0, idx).trim();
      let value = t.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && value) {
        fieldTokens.push({ key: key.toLowerCase(), value: value.toLowerCase() });
        continue;
      }
    }

    let v = t.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) textTokens.push(v.toLowerCase());
  }

  return { fieldTokens, textTokens };
}

function deepAny(obj, predicate) {
  const stack = [{ value: obj, key: null }];
  while (stack.length) {
    const { value, key } = stack.pop();
    if (predicate(key, value)) return true;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push({ value: value[i], key });
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) stack.push({ value: v, key: k });
    }
  }
  return false;
}

function eventMatchesFieldToken(evt, keyLower, valueLower) {
  return deepAny(evt, (field, val) => {
    if (!field) return false;
    if (String(field).toLowerCase() !== keyLower) return false;
    return stringifySafe(val).toLowerCase().includes(valueLower);
  });
}

function eventMatchesTextToken(evt, tokenLower) {
  return stringifySafe(evt).toLowerCase().includes(tokenLower);
}

// ---- Path helper for dropdown field search ----
// Supports selecting "payload.Driver.Callsign" etc
function getByPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  const parts = pathStr.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// ---- New: UI field selector search ----
// field="any" => search anywhere in the event
// field="fulltext" => also search anywhere (same behaviour)
// otherwise field is a JSON path like "payload.Driver.Callsign"
function eventMatchesSelectedField(evt, fieldPath, value) {
  const v = (value || "").toString().trim().toLowerCase();
  if (!v) return true;

  const f = (fieldPath || "").toString().trim();
  if (!f || f === "any" || f === "fulltext") {
    return stringifySafe(evt).toLowerCase().includes(v);
  }

  const got = getByPath(evt, f);
  return stringifySafe(got).toLowerCase().includes(v);
}

// Combined query matcher:
// - supports dropdown field + value
// - also supports old q tokens (key:value + free text) for power users
function eventMatches(evt, { q, field, value }) {
  if (value && value.trim()) {
    if (!eventMatchesSelectedField(evt, field, value)) return false;
  }

  const qq = normalizeQ(q);
  if (!qq) return true;

  const { fieldTokens, textTokens } = parseTokens(qq);
  for (const ft of fieldTokens) {
    if (!eventMatchesFieldToken(evt, ft.key, ft.value)) return false;
  }
  for (const tt of textTokens) {
    if (!eventMatchesTextToken(evt, tt)) return false;
  }
  return true;
}

// ---- Summary extraction for list rows ----
// Updated for Autocab payloads (PascalCase + nested Driver/Vehicle/Pickup/Destination)
const COMMON_FIELDS = [
  { label: "Booking Id (payload.Id)", path: "payload.Id" },
  { label: "OriginalBookingId", path: "payload.OriginalBookingId" },
  { label: "EventType", path: "payload.EventType" },
  { label: "BookingType", path: "payload.BookingType" },
  { label: "TypeOfBooking", path: "payload.TypeOfBooking" },

  { label: "Driver Callsign", path: "payload.Driver.Callsign" },
  { label: "Driver Id", path: "payload.Driver.Id" },
  { label: "Driver Forename", path: "payload.Driver.Forename" },
  { label: "Driver Surname", path: "payload.Driver.Surname" },

  { label: "Vehicle Callsign", path: "payload.Vehicle.Callsign" },
  { label: "Vehicle Id", path: "payload.Vehicle.Id" },
  { label: "Vehicle Registration", path: "payload.Vehicle.Registration" },
  { label: "Vehicle PlateNumber", path: "payload.Vehicle.PlateNumber" },

  { label: "Pickup Address", path: "payload.Pickup.Address" },
  { label: "Pickup Zone", path: "payload.Pickup.Zone.Name" },
  { label: "Destination Address", path: "payload.Destination.Address" },
  { label: "Destination Zone", path: "payload.Destination.Zone.Name" },

  { label: "PaymentType", path: "payload.PaymentType" },
  { label: "Pricing Cost", path: "payload.Pricing.Cost" },
  { label: "Pricing Price", path: "payload.Pricing.Price" },
  { label: "Distance", path: "payload.Distance" },
  { label: "BookingSource", path: "payload.BookingSource" },

  { label: "CabExchangeAgentBookingRef", path: "payload.CabExchangeAgentBookingRef" },
];

function short(s, n = 80) {
  const t = (s ?? "").toString();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function buildSummary(evt) {
  const p = evt?.payload ?? {};
  const parts = [];

  const id = p.Id ?? p.OriginalBookingId ?? "";
  const eventType = p.EventType ?? "";
  const bookingType = p.BookingType ?? "";
  const typeOfBooking = p.TypeOfBooking ?? "";

  const driverCs = p?.Driver?.Callsign ?? p?.DriverDetails?.Driver?.Callsign ?? "";
  const driverId = p?.Driver?.Id ?? p?.DriverDetails?.Driver?.Id ?? "";

  const vehCs = p?.Vehicle?.Callsign ?? p?.VehicleDetails?.Vehicle?.Callsign ?? "";
  const vehId = p?.Vehicle?.Id ?? p?.VehicleDetails?.Vehicle?.Id ?? "";
  const reg = p?.Vehicle?.Registration ?? "";
  const plate = p?.Vehicle?.PlateNumber ?? "";

  const pickupZone = p?.Pickup?.Zone?.Name ?? p?.Pickup?.Zone?.Descriptor ?? "";
  const pickupAddr = p?.Pickup?.Address ?? "";
  const destZone = p?.Destination?.Zone?.Name ?? p?.Destination?.Zone?.Descriptor ?? "";
  const destAddr = p?.Destination?.Address ?? "";

  const pay = p?.PaymentType ?? "";
  const cost = p?.Pricing?.Cost ?? "";
  const price = p?.Pricing?.Price ?? "";
  const dist = p?.Distance ?? p?.SystemDistance ?? "";

  const eta = p?.EstimatedPickupTime ?? "";
  const arrived = p?.VehicleArrivedAtTime ?? "";
  const dispatched = p?.DispatchedAtTime ?? "";

  if (id) parts.push(`Booking ${id}`);
  if (eventType) parts.push(eventType);
  if (bookingType) parts.push(bookingType);
  if (typeOfBooking) parts.push(typeOfBooking);

  const dv = [];
  if (driverCs) dv.push(`D CS ${driverCs}`);
  if (driverId !== "") dv.push(`D#${driverId}`);
  if (vehCs) dv.push(`V CS ${vehCs}`);
  if (vehId !== "") dv.push(`V#${vehId}`);
  if (reg) dv.push(reg);
  if (plate) dv.push(`Plate ${plate}`);
  if (dv.length) parts.push(dv.join(" "));

  if (pickupAddr || destAddr) {
    const leg =
      `${pickupZone ? pickupZone + ": " : ""}${short(pickupAddr, 46)} → ` +
      `${destZone ? destZone + ": " : ""}${short(destAddr, 46)}`;
    parts.push(leg);
  }

  const money = [];
  if (pay) money.push(pay);
  if (cost !== "") money.push(`Cost ${cost}`);
  if (price !== "") money.push(`Price ${price}`);
  if (dist !== "") money.push(`${dist}mi`);
  if (money.length) parts.push(money.join(" · "));
  const times = [];
  if (dispatched) times.push(`Disp ${dispatched}`);
  if (arrived) times.push(`Arr ${arrived}`);
  if (eta) times.push(`ETA ${eta}`);
  if (times.length) parts.push(times.join(" · "));

  if (!parts.length && p && typeof p === "object") {
    const keys = Object.keys(p).slice(0, 8);
    parts.push(`Keys: ${keys.join(", ")}`);
  }

  return { summary: parts.join(" | ") };
}

// ---- Helpers: limits ----
// limit=0 => unlimited
function parseLimit(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.floor(n);
}

// ---- Webhook receiver ----
app.post("/:hook", (req, res) => {
  const hook = (req.params.hook || "").trim();

  // prevent collisions with internal routes
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
  res.json({ ok: true, hooks: ["*"].concat(hooks) });
});

// Provide list of common fields for dropdown (UI)
app.get("/api/fields", (req, res) => {
  res.json({
    ok: true,
    fields: [
      { label: "Any field (recommended)", value: "any" },
      { label: "Full text (entire JSON)", value: "fulltext" },
      ...COMMON_FIELDS.map((f) => ({ label: f.label, value: f.path })),
    ],
  });
});

// one hook events
app.get("/api/hooks/:hook", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).json({ ok: false, error: "Not found" });

  const q = normalizeQ(req.query.q);
  const field = (req.query.field || "").toString();
  const value = (req.query.value || "").toString();
  const limit = parseLimit(req.query.limit);

  const arr = ensureHookLoaded(hook);
  let filtered = arr;

  if (q || (value && value.trim())) {
    filtered = arr.filter((evt) => eventMatches(evt, { q, field, value }));
  }

  const items = (limit === 0 ? filtered : filtered.slice(0, Math.min(5000, limit))).map((evt) => {
    const { summary } = buildSummary(evt);
    return { ...evt, _summary: summary };
  });

  res.json({
    ok: true,
    scope: hook,
    q,
    field,
    value,
    count: filtered.length,
    items,
  });
});

app.get("/api/hooks/:hook/:id", (req, res) => {
  const hook = (req.params.hook || "").trim();
  if (!isHookAllowed(hook)) return res.status(404).json({ ok: false, error: "Not found" });

  const arr = ensureHookLoaded(hook);
  const item = arr.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, item });
});

// all hooks combined
app.get("/api/events", (req, res) => {
  const q = normalizeQ(req.query.q);
  const field = (req.query.field || "").toString();
  const value = (req.query.value || "").toString();
  const limit = parseLimit(req.query.limit);

  const hooks = listHooksOnDisk();
  const combined = [];
  for (const h of hooks) {
    const arr = ensureHookLoaded(h);
    for (const evt of arr) combined.push(evt);
  }

  let filtered = combined;
  if (q || (value && value.trim())) {
    filtered = combined.filter((evt) => eventMatches(evt, { q, field, value }));
  }

  filtered.sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0
  );
  const sliced = limit === 0 ? filtered : filtered.slice(0, Math.min(5000, limit));

  const items = sliced.map((evt) => {
    const { summary } = buildSummary(evt);
    return { ...evt, _summary: summary };
  });

  res.json({
    ok: true,
    scope: "*",
    q,
    field,
    value,
    count: filtered.length,
    items,
  });
});

// exports (all or one hook) respecting filters
app.get("/api/export.ndjson", (req, res) => {
  const scope = (req.query.hook || "*").trim();
  const q = normalizeQ(req.query.q);
  const field = (req.query.field || "").toString();
  const value = (req.query.value || "").toString();

  let events = [];
  if (scope === "*") {
    const hooks = listHooksOnDisk();
    for (const h of hooks) events = events.concat(ensureHookLoaded(h));
  } else {
    if (!isHookAllowed(scope)) return res.status(404).send("Not found");
    events = ensureHookLoaded(scope);
  }

  if (q || (value && value.trim())) events = events.filter((evt) => eventMatches(evt, { q, field, value }));
  events.sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0
  );
  if (events.length > MAX_EXPORT) events = events.slice(0, MAX_EXPORT);

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${scope === "*" ? "all-hooks" : scope}${(q || value) ? "-filtered" : ""}.ndjson"`
  );
  res.send(events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
});

app.get("/api/export.csv", (req, res) => {
  const scope = (req.query.hook || "*").trim();
  const q = normalizeQ(req.query.q);
  const field = (req.query.field || "").toString();
  const value = (req.query.value || "").toString();

  let events = [];
  if (scope === "*") {
    const hooks = listHooksOnDisk();
    for (const h of hooks) events = events.concat(ensureHookLoaded(h));
  } else {
    if (!isHookAllowed(scope)) return res.status(404).send("Not found");
    events = ensureHookLoaded(scope);
  }

  if (q || (value && value.trim())) events = events.filter((evt) => eventMatches(evt, { q, field, value }));
  events.sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0
  );
  if (events.length > MAX_EXPORT) events = events.slice(0, MAX_EXPORT);

  const header = ["receivedAt", "id", "hook", "ip", "contentType", "userAgent", "payloadJson"];
  const rows = [header.join(",")];

  for (const e of events) {
    rows.push(
      [
        csvEscape(e.receivedAt),
        csvEscape(e.id),
        csvEscape(e.hook),
        csvEscape(e.meta?.ip || ""),
        csvEscape(e.meta?.contentType || ""),
        csvEscape(e.meta?.userAgent || ""),
        csvEscape(stringifySafe(e.payload ?? {})),
      ].join(",")
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${scope === "*" ? "all-hooks" : scope}${(q || value) ? "-filtered" : ""}.csv"`
  );
  res.send(rows.join("\n") + "\n");
});

// CLEAR endpoint
app.post("/api/clear", (req, res) => {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const hook = (body?.hook || "*").toString().trim();

  if (hook === "*") {
    recentByHook.clear();
    const hooks = listHooksOnDisk();
    for (const h of hooks) {
      const file = hookFile(h);
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
    return res.json({ ok: true, cleared: "*", hooksCleared: hooks.length });
  }

  if (!isHookAllowed(hook)) return res.status(404).json({ ok: false, error: "Not found" });

  recentByHook.delete(hook);
  const file = hookFile(hook);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}

  res.json({ ok: true, cleared: hook });
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
    .wrap{max-width:1600px;margin:0 auto;padding:16px}
    .grid{display:grid;grid-template-columns:520px 1fr;gap:14px}
    .card{background:#12161c;border:1px solid #202630;border-radius:16px;overflow:hidden}
    .card h3{margin:0;padding:12px 14px;border-bottom:1px solid #202630;font-size:14px;color:#9bb0c2;display:flex;justify-content:space-between;align-items:center;gap:10px}
    .list{max-height:72vh;overflow:auto}
    .row{padding:12px 14px;border-bottom:1px solid #202630;cursor:pointer}
    .row:hover{background:#0f1319}
    .muted{color:#9bb0c2;font-size:12px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    pre{margin:0;padding:14px;max-height:72vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    button,a.btn{background:#1b222c;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    button:hover,a.btn:hover{background:#202836}
    input,select{background:#0f1319;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px}
    input{width:140px}
    input.search{width:260px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1b222c;border:1px solid #2a3340;font-size:12px;color:#cfe1f3}
    .kv{display:flex;gap:8px;align-items:center}
    .kv label{font-size:12px;color:#9bb0c2}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .danger{border-color:#5a2a2a;background:#221416}
    .danger:hover{background:#2a171a}
    .tag{display:inline-flex;gap:6px;align-items:center}
    .tag b{color:#cfe1f3}
    .summary{margin-top:6px;color:#cfe1f3}
    .sub{margin-top:4px}
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
          <label>Field</label>
          <select id="fieldSelect"></select>
        </div>

        <div class="kv">
          <label>Value</label>
          <input id="value" class="search" type="text" placeholder="e.g. 51"/>
        </div>

        <div class="kv">
          <label>Advanced</label>
          <input id="q" class="search" type="text" placeholder='Optional: driverId:57 pickup:"Market Ave"'/>
        </div>

        <div class="kv">
          <label>Limit</label>
          <input id="limit" type="number" min="0" step="1" value="0" title="0 = unlimited"/>
        </div>

        <button id="refresh">Refresh</button>
        <button id="auto">Auto: ON</button>

        <a class="btn" id="dlNdjson" href="#" download>Download NDJSON</a>
        <a class="btn" id="dlCsv" href="#" download>Download CSV</a>

        <button class="danger" id="clearBtn">Clear</button>
      </div>

      <div class="muted" style="margin-top:8px">
        Field dropdown searches the selected JSON path (e.g. payload.Driver.Callsign). Advanced supports tokens like
        <span class="pill">Id:12798732</span> <span class="pill">Callsign:51</span> <span class="pill">Pickup:"Market Ave"</span>
      </div>
    </div>
  </header>

  <div class="wrap">
    <div class="grid">
      <div class="card">
        <h3>
          <span>Latest events</span>
          <span class="muted" id="count"></span>
        </h3>
        <div class="list" id="list"></div>
      </div>

      <div class="card">
        <h3>
          <span>Selected payload</span>
          <span class="actions">
            <button id="copyBtn">Copy JSON</button>
          </span>
        </h3>
        <pre id="detail" class="muted">Select an event…</pre>
      </div>
    </div>
  </div>

<script>
  let auto = true;
  let timer = null;
  let selectedHook = null; // "*" or actual hook
  let currentSelectedJson = null;

  const qs = new URLSearchParams(location.search);

  function fmt(s){ try { return new Date(s).toLocaleString(); } catch { return s; } }
  function setStatus(txt){ document.getElementById('status').textContent = txt; }
  function setCount(txt){ document.getElementById('count').textContent = txt || ''; }
  function setHookPill(h){ document.getElementById('hookPill').textContent = (h === '*') ? '* ALL' : '/' + (h || ''); }

  function getLimit(){ return Number(document.getElementById('limit').value || 0); }
  function getField(){ return document.getElementById('fieldSelect').value || 'any'; }
  function getValue(){ return (document.getElementById('value').value || '').trim(); }
  function getQ(){ return (document.getElementById('q').value || '').trim(); }

  function updateUrl(){
    const u = new URL(location.href);
    if (selectedHook) u.searchParams.set('hook', selectedHook);
    const field = getField();
    const value = getValue();
    const q = getQ();
    const limit = getLimit();

    if (field) u.searchParams.set('field', field); else u.searchParams.delete('field');
    if (value) u.searchParams.set('value', value); else u.searchParams.delete('value');
    if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
    u.searchParams.set('limit', String(limit || 0));
    history.replaceState({}, '', u);
  }

  function updateDownloadLinks(){
    const hook = selectedHook || '*';
    const field = getField();
    const value = getValue();
    const q = getQ();

    const nd = new URL('/api/export.ndjson', location.origin);
    nd.searchParams.set('hook', hook);
    if (field) nd.searchParams.set('field', field);
    if (value) nd.searchParams.set('value', value);
    if (q) nd.searchParams.set('q', q);

    const cs = new URL('/api/export.csv', location.origin);
    cs.searchParams.set('hook', hook);
    if (field) cs.searchParams.set('field', field);
    if (value) cs.searchParams.set('value', value);
    if (q) cs.searchParams.set('q', q);

    document.getElementById('dlNdjson').href = nd.toString();
    document.getElementById('dlCsv').href = cs.toString();
  }

  async function loadHooks() {
    const res = await fetch('/api/hooks', { cache: 'no-store' });
    const data = await res.json();
    const hooks = (data && data.ok && data.hooks) ? data.hooks : ["*"];

    const sel = document.getElementById('hookSelect');
    sel.innerHTML = '';
    for (const h of hooks) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = (h === "*") ? "* ALL" : ("/" + h);
      sel.appendChild(opt);
    }

    const fromUrl = qs.get('hook');
    selectedHook = fromUrl && hooks.includes(fromUrl) ? fromUrl : (hooks[0] || "*");
    sel.value = selectedHook;
    setHookPill(selectedHook);

    sel.onchange = async () => {
      selectedHook = sel.value;
      setHookPill(selectedHook);
      updateUrl();
      updateDownloadLinks();
      await load();
    };
  }

  async function loadFields(){
    const res = await fetch('/api/fields', { cache: 'no-store' });
    const data = await res.json();
    const fields = (data && data.ok && data.fields) ? data.fields : [{label:'Any',value:'any'}];

    const sel = document.getElementById('fieldSelect');
    sel.innerHTML = '';
    for (const f of fields) {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      sel.appendChild(opt);
    }

    const fromUrl = qs.get('field');
    if (fromUrl) sel.value = fromUrl;
    else sel.value = 'any';
  }

  function hydrateFromUrl(){
    const value = qs.get('value');
    const q = qs.get('q');
    const limit = qs.get('limit');

    if (value) document.getElementById('value').value = value;
    if (q) document.getElementById('q').value = q;
    if (limit != null) document.getElementById('limit').value = limit;
  }

  let t = null;
  function scheduleReload(){
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      updateUrl();
      updateDownloadLinks();
      load();
    }, 250);
  }

  async function load() {
    const field = getField();
    const value = getValue();
    const q = getQ();
    const limit = getLimit();

    setStatus('Refreshing…');

    let url;
    if (selectedHook === '*') url = new URL('/api/events', location.origin);
    else url = new URL('/api/hooks/' + encodeURIComponent(selectedHook), location.origin);

    url.searchParams.set('limit', String(limit || 0));
    if (field) url.searchParams.set('field', field);
    if (value) url.searchParams.set('value', value);
    if (q) url.searchParams.set('q', q);

    const res = await fetch(url.toString(), { cache: 'no-store' });
    const data = await res.json();

    const list = document.getElementById('list');
    list.innerHTML = '';

    if (!data.ok || !data.items?.length) {
      list.innerHTML = '<div class="row"><div>No events found.</div><div class="muted">Try * ALL, or clear filters.</div></div>';
      setCount('');
      setStatus('Ready');
      return;
    }

    setCount((data.count || 0) + ' match' + ((data.count || 0) === 1 ? '' : 'es'));

    for (const item of data.items) {
      const div = document.createElement('div');
      div.className = 'row';

      const keys = item.payload && typeof item.payload === 'object'
        ? Object.keys(item.payload).slice(0, 8).join(', ')
        : '(non-object payload)';

      const summary = item._summary || ('Keys: ' + (keys || '-'));

      div.innerHTML =
        '<div style="display:flex;justify-content:space-between;gap:10px">' +
          '<div>' +
            '<div class="tag"><b>' + fmt(item.receivedAt) + '</b>' +
              '<span class="pill" style="margin-left:8px">' + (item.hook ? ('/' + item.hook) : '') + '</span>' +
            '</div>' +
            '<div class="summary mono">' + summary.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>' +
            '<div class="muted sub">Keys: ' + (keys || '-') + '</div>' +
          '</div>' +
          '<div class="muted" style="text-align:right">' +
            '<div>' + ((item.meta?.ip || '').toString().slice(0, 30)) + '</div>' +
            '<div>' + (item.meta?.contentType || '') + '</div>' +
          '</div>' +
        '</div>';

      div.onclick = () => select(item);
      list.appendChild(div);
    }

    select(data.items[0]);
    setStatus('Last update: ' + new Date().toLocaleTimeString());
  }

  async function select(item) {
    currentSelectedJson = JSON.stringify(item, null, 2);
    document.getElementById('detail').textContent = currentSelectedJson;

    if (selectedHook !== '*' && selectedHook) {
      try {
        const res = await fetch('/api/hooks/' + encodeURIComponent(selectedHook) + '/' + encodeURIComponent(item.id), { cache: 'no-store' });
        const data = await res.json();
        if (data.ok && data.item) {
          currentSelectedJson = JSON.stringify(data.item, null, 2);
          document.getElementById('detail').textContent = currentSelectedJson;
        }
      } catch {}
    }
  }

  async function copySelected(){
    if (!currentSelectedJson) return alert('Nothing selected yet.');
    try {
      await navigator.clipboard.writeText(currentSelectedJson);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = currentSelectedJson;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setStatus('Copied JSON');
    setTimeout(() => setStatus('Last update: ' + new Date().toLocaleTimeString()), 800);
  }

  async function clearData(){
    const hook = selectedHook || '*';
    const label = (hook === '*') ? 'ALL hooks' : ('/' + hook);
    if (!confirm('Clear stored events for ' + label + '? This deletes NDJSON file(s).')) return;

    const res = await fetch('/api/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook })
    });
    const data = await res.json();
    if (!data.ok) return alert('Clear failed');
    document.getElementById('detail').textContent = 'Select an event…';
    setStatus('Cleared ' + label);

    await loadHooks();
    updateUrl();
    updateDownloadLinks();
    await load();
  }

  function setAuto(on) {
    auto = on;
    document.getElementById('auto').textContent = 'Auto: ' + (auto ? 'ON' : 'OFF');
    if (timer) clearInterval(timer);
    if (auto) timer = setInterval(load, 3000);
  }

  document.getElementById('refresh').onclick = load;
  document.getElementById('auto').onclick = () => setAuto(!auto);
  document.getElementById('fieldSelect').onchange = scheduleReload;
  document.getElementById('value').addEventListener('input', scheduleReload);
  document.getElementById('q').addEventListener('input', scheduleReload);
  document.getElementById('limit').addEventListener('input', scheduleReload);
  document.getElementById('copyBtn').onclick = copySelected;
  document.getElementById('clearBtn').onclick = clearData;

  (async function init(){
    hydrateFromUrl();
    await loadHooks();
    await loadFields();
    updateUrl();
    updateDownloadLinks();
    setAuto(true);
    await load();
  })();
</script>
</body>
</html>`);
});

// body parser errors
app.use((err, req, res, next) => {
  console.error("[BODY ERROR]", err?.message || err);
  res.status(400).send("Bad Request");
});

app.listen(PORT, () => {
  console.log("Need-a-Cab Webhooks listening on", PORT);
});
