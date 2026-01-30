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

// ---- UI field selector search ----
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

// Combined query matcher
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

function asCleanString(x) {
  if (x == null) return "";
  const s = String(x);
  return s.trim();
}

function buildSummary(evt) {
  const p = evt?.payload ?? {};
  const parts = [];
  const meta = {}; // client can render richer UI from this

  // ---- TRACKS (VehicleTracksChanged) special case ----
  const tracks = Array.isArray(p?.VehicleTracks) ? p.VehicleTracks : null;
  const isTracks =
    p?.EventType === "VehicleTracksChanged" ||
    p?.EventType === "VehicleTracksChangedEvent" ||
    (tracks && tracks.length > 0);

  if (isTracks) {
    const count = tracks ? tracks.length : 0;
    meta.kind = "tracks";
    meta.eventType = asCleanString(p?.EventType || "VehicleTracksChanged");
    meta.tracksCount = count;

    // pick a representative track for the compact summary (first item)
    const t0 = tracks && tracks.length ? tracks[0] : {};
    const cs =
      asCleanString(t0?.Vehicle?.Callsign) ||
      asCleanString(t0?.Driver?.Callsign);

    const vId = t0?.Vehicle?.Id ?? "";
    const dId = t0?.Driver?.Id ?? "";
    const status = asCleanString(t0?.VehicleStatus || p?.VehicleStatus);

    // also useful for pills
    meta.cs = cs;
    meta.vehicleId = vId === "" ? "" : Number(vId);
    meta.driverId = dId === "" ? "" : Number(dId);
    meta.status = status;

    parts.push(meta.eventType);
    parts.push(`Tracks: ${count}`);

    const rightBits = [];
    if (cs) rightBits.push(`CS#${cs}`);
    if (vId !== "" && vId != null) rightBits.push(`V#${vId}`);
    if (dId !== "" && dId != null) rightBits.push(`D#${dId}`);
    if (status) rightBits.push(status);

    if (rightBits.length) parts.push(rightBits.join(" "));
    return { summary: parts.join(" | "), meta };
  }

  // ---- Default (booking-ish) ----
  const id = p.Id ?? p.OriginalBookingId ?? "";
  const eventType = p.EventType ?? "";
  const bookingType = p.BookingType ?? "";
  const typeOfBooking = p.TypeOfBooking ?? "";

  const driverCs =
    p?.Driver?.Callsign ??
    p?.DriverDetails?.Driver?.Callsign ??
    "";
  const driverId =
    p?.Driver?.Id ??
    p?.DriverDetails?.Driver?.Id ??
    "";

  const vehCs =
    p?.Vehicle?.Callsign ??
    p?.VehicleDetails?.Vehicle?.Callsign ??
    "";
  const vehId =
    p?.Vehicle?.Id ??
    p?.VehicleDetails?.Vehicle?.Id ??
    "";
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
  if (driverCs) dv.push(`CS#${driverCs}`);
  if (vehCs && !driverCs) dv.push(`CS#${vehCs}`); // fallback if only vehicle callsign exists
  if (vehId !== "") dv.push(`V#${vehId}`);
  if (driverId !== "") dv.push(`D#${driverId}`);
  if (reg) dv.push(asCleanString(reg));
  if (plate) dv.push(`Plate ${asCleanString(plate)}`);
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

  meta.kind = "default";
  meta.eventType = asCleanString(eventType);
  meta.bookingId = id;
  return { summary: parts.join(" | "), meta };
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
    const { summary, meta } = buildSummary(evt);
    return { ...evt, _summary: summary, _summaryMeta: meta };
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

  filtered.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
  const sliced = limit === 0 ? filtered : filtered.slice(0, Math.min(5000, limit));

  const items = sliced.map((evt) => {
    const { summary, meta } = buildSummary(evt);
    return { ...evt, _summary: summary, _summaryMeta: meta };
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
  events.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
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
  events.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
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
    .grid{display:grid;grid-template-columns:560px 1fr;gap:14px}
    .card{background:#12161c;border:1px solid #202630;border-radius:16px;overflow:hidden}
    .card h3{margin:0;padding:12px 14px;border-bottom:1px solid #202630;font-size:14px;color:#9bb0c2;display:flex;justify-content:space-between;align-items:center;gap:10px}
    .list{max-height:72vh;overflow:auto}
    .row{padding:12px 14px;border-bottom:1px solid #202630;cursor:pointer}
    .row:hover{background:#0f1319}
    .row.active{outline:2px solid #2a3340; outline-offset:-2px}
    .muted{color:#9bb0c2;font-size:12px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    pre{margin:0}
    .detailWrap{padding:14px;max-height:72vh;overflow:auto}
    .topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    button,a.btn{background:#1b222c;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
    button:hover,a.btn:hover{background:#202836}
    input,select{background:#0f1319;border:1px solid #2a3340;color:#e9eef4;padding:8px 10px;border-radius:10px}
    input{width:140px}
    input.search{width:260px}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1b222c;border:1px solid #2a3340;font-size:12px;color:#cfe1f3}
    .pill.status{border-color:#2a3340}
    .pill.s-clear{background:rgba(30, 130, 90, .15);border-color:rgba(30, 130, 90, .35)}
    .pill.s-busy{background:rgba(220, 165, 35, .14);border-color:rgba(220, 165, 35, .35)}
    .pill.s-offered{background:rgba(70, 130, 220, .14);border-color:rgba(70, 130, 220, .35)}
    .pill.s-other{background:rgba(155, 176, 194, .10);border-color:rgba(155, 176, 194, .28)}
    .kv{display:flex;gap:8px;align-items:center}
    .kv label{font-size:12px;color:#9bb0c2}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .danger{border-color:#5a2a2a;background:#221416}
    .danger:hover{background:#2a171a}
    .tag{display:inline-flex;gap:6px;align-items:center}
    .tag b{color:#cfe1f3}
    .summary{margin-top:6px;color:#cfe1f3}
    .sub{margin-top:4px}
    .rightActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .tabs{display:flex;gap:8px;align-items:center}
    .tab{padding:6px 10px;border-radius:999px;border:1px solid #2a3340;background:#0f1319;color:#cfe1f3;font-size:12px;cursor:pointer}
    .tab.active{background:#1b222c}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #202630;padding:8px 6px;text-align:left;vertical-align:top}
    th{color:#9bb0c2;font-size:12px;font-weight:600;position:sticky;top:0;background:#12161c}
    td{font-size:13px}
    a{color:#cfe1f3}
    a:hover{text-decoration:underline}
    .delta{font-size:12px;color:#9bb0c2}
    @media (max-width: 980px){ .grid{grid-template-columns:1fr} .list,.detailWrap{max-height:45vh} input.search{width:100%} }
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
          <input id="limit" type="number" min="0" step="1" value="200" title="0 = unlimited (not recommended)"/>
        </div>

        <div class="rightActions">
          <button id="refresh">Refresh</button>
          <button id="auto">Auto: ON</button>
          <button id="pause">Pause: OFF</button>

          <a class="btn" id="dlNdjson" href="#" download>Download NDJSON</a>
          <a class="btn" id="dlCsv" href="#" download>Download CSV</a>

          <button class="danger" id="clearBtn">Clear</button>
        </div>
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
          <span>Selected</span>
          <span class="actions">
            <span class="tabs">
              <span class="tab active" id="tabTracks">Tracks</span>
              <span class="tab" id="tabJson">JSON</span>
            </span>
            <button id="copyBtn">Copy JSON</button>
          </span>
        </h3>
        <div class="detailWrap" id="detail">Select an event…</div>
      </div>
    </div>
  </div>

<script>
  let auto = true;
  let timer = null;
  let paused = false;

  let selectedHook = null; // "*" or actual hook
  let currentSelectedJson = null;
  let currentSelectedId = null;      // keep selection stable during refresh
  let currentSelectedHook = null;    // keep selection stable during refresh

  let viewMode = "tracks"; // tracks | json

  // Delta memory (browser-side): vehicleId -> last seen
  const lastByVehicleId = new Map();

  const qs = new URLSearchParams(location.search);

  function fmt(s){ try { return new Date(s).toLocaleString(); } catch { return s; } }
  function esc(s){ return String(s ?? "").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function setStatus(txt){ document.getElementById('status').textContent = txt; }
  function setCount(txt){ document.getElementById('count').textContent = txt || ''; }
  function setHookPill(h){ document.getElementById('hookPill').textContent = (h === '*') ? '* ALL' : '/' + (h || ''); }

  function getLimit(){ return Number(document.getElementById('limit').value || 0); }
  function getField(){ return document.getElementById('fieldSelect').value || 'any'; }
  function getValue(){ return (document.getElementById('value').value || '').trim(); }
  function getQ(){ return (document.getElementById('q').value || '').trim(); }

  function statusClass(status){
    const s = String(status || '').toLowerCase();
    if (!s) return "s-other";
    if (s === "clear") return "s-clear";
    if (s.includes("busy")) return "s-busy";
    if (s.includes("offered")) return "s-offered";
    if (s.includes("joboffered")) return "s-offered";
    return "s-other";
  }

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
      currentSelectedId = null;
      currentSelectedHook = null;
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
    }, 350);
  }

  function setPause(on){
    paused = on;
    document.getElementById('pause').textContent = 'Pause: ' + (paused ? 'ON' : 'OFF');
    if (paused) setStatus('Paused (not refreshing list)');
    else setStatus('Resuming…');
  }

  function setView(mode){
    viewMode = mode;
    document.getElementById('tabTracks').classList.toggle('active', viewMode === 'tracks');
    document.getElementById('tabJson').classList.toggle('active', viewMode === 'json');
    // re-render current selection
    if (currentSelectedJson) renderDetailFromCurrent();
  }

  function renderTracksDetail(item){
    const p = item?.payload || {};
    const tracks = Array.isArray(p.VehicleTracks) ? p.VehicleTracks : [];
    if (!tracks.length) {
      return '<div class="muted">No VehicleTracks array in this payload.</div>';
    }

    // Build rows + delta updates
    let html = '';
    html += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">';
    html += '<span class="pill">' + esc(p.EventType || 'VehicleTracksChanged') + '</span>';
    html += '<span class="pill">Tracks: ' + tracks.length + '</span>';
    html += '<span class="muted">Received: ' + esc(fmt(item.receivedAt)) + '</span>';
    html += '</div>';

    html += '<table>';
    html += '<thead><tr>';
    html += '<th>CS</th><th>V#</th><th>D#</th><th>Status</th><th>BookingId</th><th>Time</th><th>Loc</th><th>Δ</th>';
    html += '</tr></thead>';
    html += '<tbody>';

    for (const tr of tracks) {
      const cs = (tr?.Vehicle?.Callsign ?? tr?.Driver?.Callsign ?? '').toString().trim();
      const vId = tr?.Vehicle?.Id ?? '';
      const dId = tr?.Driver?.Id ?? '';
      const st = (tr?.VehicleStatus ?? '').toString().trim();
      const bId = (tr?.BookingId ?? '').toString().trim();
      const ts = (tr?.Timestamp ?? '').toString().trim();
      const lat = tr?.CurrentLocation?.Latitude;
      const lng = tr?.CurrentLocation?.Longitude;

      // Delta compare
      const key = vId !== '' && vId != null ? String(vId) : ('cs:' + cs);
      const prev = lastByVehicleId.get(key);
      const changes = [];
      if (prev) {
        if (String(prev.status || '') !== String(st || '')) changes.push('status');
        if (String(prev.bookingId || '') !== String(bId || '')) changes.push('booking');
        if (lat != null && lng != null) {
          const dLat = Math.abs((prev.lat ?? lat) - lat);
          const dLng = Math.abs((prev.lng ?? lng) - lng);
          if (dLat > 0.0003 || dLng > 0.0003) changes.push('moved');
        }
      } else {
        changes.push('new');
      }

      // update last seen
      lastByVehicleId.set(key, { status: st, bookingId: bId, lat, lng, ts });

      const mapsUrl =
        (lat != null && lng != null)
          ? ('https://www.google.com/maps?q=' + encodeURIComponent(lat + ',' + lng))
          : '';

      html += '<tr>';
      html += '<td><span class="pill">CS#' + esc(cs || '-') + '</span></td>';
      html += '<td>' + esc(vId === '' ? '-' : ('V#' + vId)) + '</td>';
      html += '<td>' + esc(dId === '' ? '-' : ('D#' + dId)) + '</td>';
      html += '<td><span class="pill status ' + statusClass(st) + '">' + esc(st || '-') + '</span></td>';
      html += '<td class="mono">' + esc(bId || '-') + '</td>';
      html += '<td class="muted">' + esc(ts || '-') + '</td>';
      html += '<td>' + (mapsUrl ? ('<a target="_blank" rel="noreferrer" href="' + mapsUrl + '">Map</a>') : '<span class="muted">-</span>') + '</td>';
      html += '<td class="delta">' + esc(changes.join(', ')) + '</td>';
      html += '</tr>';
    }

    html += '</tbody></table>';
    html += '<div class="muted" style="margin-top:10px">Δ compares each vehicle to the last seen state in this browser session.</div>';
    return html;
  }

  function renderJsonDetail(){
    return '<pre class="mono" style="white-space:pre-wrap;word-break:break-word;margin:0">' + esc(currentSelectedJson) + '</pre>';
  }

  function renderDetailFromCurrent(){
    try {
      const item = JSON.parse(currentSelectedJson);
      const isTracks = item?.payload && Array.isArray(item.payload.VehicleTracks);
      if (viewMode === "tracks" && isTracks) {
        document.getElementById('detail').innerHTML = renderTracksDetail(item);
      } else if (viewMode === "tracks" && !isTracks) {
        document.getElementById('detail').innerHTML =
          '<div class="muted">Not a tracks payload. Switch to JSON view.</div>';
      } else {
        document.getElementById('detail').innerHTML = renderJsonDetail();
      }
    } catch {
      document.getElementById('detail').innerHTML = renderJsonDetail();
    }
  }

  async function load() {
    if (paused) return;

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

    let firstItem = null;
    let selectedItem = null;

    for (const item of data.items) {
      if (!firstItem) firstItem = item;

      if (currentSelectedId && currentSelectedHook) {
        if (item.id === currentSelectedId && item.hook === currentSelectedHook) selectedItem = item;
      }

      const div = document.createElement('div');
      div.className = 'row';

      const keys = item.payload && typeof item.payload === 'object'
        ? Object.keys(item.payload).slice(0, 8).join(', ')
        : '(non-object payload)';

      const summary = item._summary || ('Keys: ' + (keys || '-'));
      const meta = item._summaryMeta || {};
      const isTracks = meta.kind === "tracks";

      // Add status pill for tracks in list
      let rightPills = '';
      if (isTracks) {
        const st = meta.status || '';
        if (st) rightPills += '<span class="pill status ' + statusClass(st) + '">' + esc(st) + '</span>';
      }

      div.innerHTML =
        '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">' +
          '<div>' +
            '<div class="tag"><b>' + esc(fmt(item.receivedAt)) + '</b>' +
              '<span class="pill" style="margin-left:8px">' + esc(item.hook ? ('/' + item.hook) : '') + '</span>' +
            '</div>' +
            '<div class="summary mono">' + esc(summary) + '</div>' +
            '<div class="muted sub">Keys: ' + esc(keys || '-') + '</div>' +
          '</div>' +
          '<div class="muted" style="text-align:right;min-width:140px">' +
            (rightPills ? ('<div style="margin-bottom:6px">' + rightPills + '</div>') : '') +
            '<div>' + esc(((item.meta?.ip || '').toString().slice(0, 30))) + '</div>' +
            '<div>' + esc((item.meta?.contentType || '')) + '</div>' +
          '</div>' +
        '</div>';

      div.onclick = () => select(item, div);
      list.appendChild(div);

      if (currentSelectedId && currentSelectedHook && item.id === currentSelectedId && item.hook === currentSelectedHook) {
        div.classList.add('active');
      }
    }

    // keep user selection stable; only auto-select if nothing selected yet
    if (currentSelectedId && currentSelectedHook && selectedItem) {
      // keep current selection
    } else if (!currentSelectedId && firstItem) {
      select(firstItem, list.firstChild);
    }

    setStatus('Last update: ' + new Date().toLocaleTimeString());
  }

  async function select(item, clickedDiv) {
    currentSelectedId = item.id;
    currentSelectedHook = item.hook;

    // set active row
    const list = document.getElementById('list');
    for (const el of list.children) el.classList.remove('active');
    if (clickedDiv) clickedDiv.classList.add('active');

    currentSelectedJson = JSON.stringify(item, null, 2);

    // If in single-hook mode, fetch canonical item
    if (selectedHook !== '*' && selectedHook) {
      try {
        const res = await fetch('/api/hooks/' + encodeURIComponent(selectedHook) + '/' + encodeURIComponent(item.id), { cache: 'no-store' });
        const data = await res.json();
        if (data.ok && data.item) {
          currentSelectedJson = JSON.stringify(data.item, null, 2);
        }
      } catch {}
    }

    renderDetailFromCurrent();
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

    currentSelectedId = null;
    currentSelectedHook = null;
    currentSelectedJson = null;

    document.getElementById('detail').innerHTML = 'Select an event…';
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
  document.getElementById('pause').onclick = () => setPause(!paused);

  document.getElementById('tabTracks').onclick = () => setView("tracks");
  document.getElementById('tabJson').onclick = () => setView("json");

  // reduce “slow typing” searches: only reload when you stop typing
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
    setPause(false);
    setView("tracks");
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
