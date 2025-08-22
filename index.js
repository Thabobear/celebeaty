/**
 * Celebeaty Backend (Express + WebSocket) — Single-Origin Version
 * - OAuth Login zu Spotify (Authorization Code)
 * - /callback setzt httpOnly Cookies (sp_at, sp_rt) und leitet ins Frontend
 * - /whoami & /currently-playing mit Auto-Refresh
 * - /spotify/* Proxys (devices/transfer/play/pause) für Empfänger-Steuerung
 * - /logout löscht Cookies
 * - WebSocket: Presence + Track/Pause Events
 * - NEU: Liefert den React-Prod-Build (frontend/build) aus  → Single-Origin
 *
 * ENV (Backend):
 *   SPOTIFY_CLIENT_ID=...
 *   SPOTIFY_CLIENT_SECRET=...
 *   REDIRECT_URI=https://<bgrok>/callback
 *   FRONTEND_URI=https://<bgrok>
 *   CORS_ORIGIN=https://<bgrok>
 *   PORT=3001
 *   NODE_ENV=development|production
 */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const app = express();

/* -------------------- CORS + Basics -------------------- */

const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin || corsOrigins.length === 0) return true;
  try {
    const o = new URL(origin);
    const originStr = `${o.protocol}//${o.host}`;
    return corsOrigins.some((allowed) => {
      const a = (allowed || "").trim();
      if (!a) return false;
      if (a.includes("*")) {
        const re = new RegExp("^" + a.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
        return re.test(originStr);
      }
      return originStr === a;
    });
  } catch {
    return false;
  }
}

app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => (isAllowedOrigin(origin) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`))),
    credentials: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    optionsSuccessStatus: 204,
  })
);

app.use(cookieParser());
app.use(express.json());

/* --------------------- Utilities ----------------------- */
function cookieBase(req) {
  const xfproto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  const isHttps = xfproto.includes("https");
  const isProd = process.env.NODE_ENV === "production";
  const secure = isProd || isHttps;
  const sameSite = secure ? "none" : "lax";
  return { httpOnly: true, secure, sameSite, path: "/" };
}

function buildAuthUrl({ forceDialog = false } = {}) {
  const scope = [
    "user-read-playback-state",
    "user-read-currently-playing",
    "user-modify-playback-state",
    "user-read-email",
    "user-read-private",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: process.env.REDIRECT_URI,
  });
  if (forceDialog) params.set("show_dialog", "true");
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function refreshAccessToken(refreshToken) {
  return axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.SPOTIFY_CLIENT_ID,
      client_secret: process.env.SPOTIFY_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, validateStatus: () => true }
  );
}

async function withValidAccessToken(req, res) {
  let accessToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.cookies.sp_at;
  const refreshTokenCookie = req.cookies.sp_rt;

  if (!accessToken && !refreshTokenCookie) {
    return { error: { status: 401, body: { error: "no_token" } } };
  }

  if (!accessToken && refreshTokenCookie) {
    const rr = await refreshAccessToken(refreshTokenCookie);
    if (rr.status !== 200) return { error: { status: rr.status, body: rr.data || { error: "refresh_failed" } } };
    accessToken = rr.data.access_token;
    const expires_in = rr.data.expires_in || 3600;
    const base = cookieBase(req);
    res.cookie("sp_at", accessToken, { ...base, maxAge: (expires_in - 30) * 1000 });
    if (rr.data.refresh_token) {
      res.cookie("sp_rt", rr.data.refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
    }
  }

  return { accessToken };
}

async function sGet(url, token) {
  return axios.get(url, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}
async function sPut(url, token, body) {
  return axios.put(url, body, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
}

/* ---------------------- Health ------------------------- */
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || "dev" }));

/* ---------------------- Login -------------------------- */
app.get("/login", (req, res) => res.redirect(buildAuthUrl({ forceDialog: false })));
app.get("/force-login", (req, res) => res.redirect(buildAuthUrl({ forceDialog: true })));

/* --------------------- Callback ------------------------ */
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing 'code'");
  try {
    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data || {};
    if (!access_token) return res.status(500).json({ error: "No access_token from Spotify", details: tokenRes.data });

    const base = cookieBase(req);
    res.cookie("sp_at", access_token, { ...base, maxAge: Math.max(1, (expires_in || 3600) - 30) * 1000 });
    if (refresh_token) res.cookie("sp_rt", refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });

    // Single-Origin: zurück auf dieselbe Domain (FRONTEND_URI zeigt auf bgrok)
    const front = (process.env.FRONTEND_URI || "").replace(/\/+$/, "");
    return res.redirect(front || "/");
  } catch (err) {
    console.error("Token exchange failed:", err.response?.data || err.message);
    return res.status(500).json({ error: "Token exchange failed", details: err.response?.data || err.message });
  }
});

/* ---------------------- Who am I ----------------------- */
app.get("/whoami", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    let r = await sGet("https://api.spotify.com/v1/me", t.accessToken);
    if (r.status === 401 && req.cookies.sp_rt) {
      const rr = await refreshAccessToken(req.cookies.sp_rt);
      if (rr.status === 200) {
        const at = rr.data.access_token;
        const expires_in = rr.data.expires_in || 3600;
        const base = cookieBase(req);
        res.cookie("sp_at", at, { ...base, maxAge: (expires_in - 30) * 1000 });
        if (rr.data.refresh_token) res.cookie("sp_rt", rr.data.refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
        r = await sGet("https://api.spotify.com/v1/me", at);
      }
    }

    if (r.status === 429) {
      const retry = Number(r.headers["retry-after"] || 1);
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: "rate_limited", retry_after: retry });
    }
    if (r.status >= 400) return res.status(r.status).json({ error: "spotify_error", details: r.data });

    const j = r.data || {};
    // ---- Fallback-Displayname bauen ----
    let dn = j.display_name;
    if (!dn) {
      if (j.email) {
        const local = String(j.email).split("@")[0].replace(/[._-]+/g, " ").trim();
        dn = local
          .split(" ")
          .filter(Boolean)
          .map(s => s.charAt(0).toUpperCase() + s.slice(1))
          .join(" ");
      } else {
        dn = j.id || null;
      }
    }

    return res.json({
      id: j.id,
      display_name: dn,
      email: j.email || null,
      country: j.country || null,
      product: j.product || null,
    });
  } catch (e) {
    console.error("whoami error:", e.message);
    return res.status(500).json({ error: "whoami_failed" });
  }
});

/* ----------------- Currently Playing ------------------- */
app.get("/currently-playing", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    let r = await sGet("https://api.spotify.com/v1/me/player/currently-playing", t.accessToken);

    if (r.status === 401 && req.cookies.sp_rt) {
      const rr = await refreshAccessToken(req.cookies.sp_rt);
      if (rr.status === 200) {
        const at = rr.data.access_token;
        const expires_in = rr.data.expires_in || 3600;
        const base = cookieBase(req);
        res.cookie("sp_at", at, { ...base, maxAge: (expires_in - 30) * 1000 });
        if (rr.data.refresh_token) res.cookie("sp_rt", rr.data.refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
        r = await sGet("https://api.spotify.com/v1/me/player/currently-playing", at);
      }
    }

    if (r.status === 429) {
      const retry = Number(r.headers["retry-after"] || 1);
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: "rate_limited", retry_after: retry });
    }

    if (r.status === 204 || !r.data) return res.json({ message: "Kein Song wird gerade gespielt.", reason: "no_item" });

    if (r.status === 200 && r.data) {
      const data = r.data;
      const item = data.item;
      if (!item) {
        return res.json({
          message: "Kein item. Evtl. Werbung oder private session.",
          reason: data.currently_playing_type || "no_item",
        });
      }
      return res.json({
        is_playing: !!data.is_playing,
        progress_ms: data.progress_ms || 0,
        track: {
          id: item.id,
          name: item.name,
          artists: (item.artists || []).map((a) => a.name),
          album: {
            name: item.album?.name,
            images: item.album?.images || [],
            spotify_url: item.album?.external_urls?.spotify || null,
          },
          spotify_url: item.external_urls?.spotify || null,
          duration_ms: item.duration_ms || 0,
        },
      });
    }

    return res.status(r.status).json({ error: "spotify_error", details: r.data });
  } catch (e) {
    console.error("currently-playing error:", e.response?.data || e.message);
    return res.status(500).json({ error: "currently_playing_failed" });
  }
});

/* ----------------- Spotify Control Proxys ----------------- */
// Devices
app.get("/spotify/devices", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const r = await axios.get("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${t.accessToken}` },
      validateStatus: () => true,
    });
    if (r.status >= 400) return res.status(r.status).json(r.data || { error: "spotify_error" });
    return res.json(r.data);
  } catch (e) {
    return res.status(500).json({ error: "devices_failed" });
  }
});

// Transfer playback
app.put("/spotify/transfer", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const body = req.body || {};
    const r = await axios.put("https://api.spotify.com/v1/me/player", body, {
      headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" },
      validateStatus: () => true,
    });
    if (r.status >= 400) return res.status(r.status).json(r.data || { error: "spotify_error" });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ error: "transfer_failed" });
  }
});

// Play
app.put("/spotify/play", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const body = req.body || {};
    const r = await axios.put("https://api.spotify.com/v1/me/player/play", body, {
      headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" },
      validateStatus: () => true,
    });
    if (r.status >= 400) return res.status(r.status).json(r.data || { error: "spotify_error" });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ error: "play_failed" });
  }
});

// Pause
app.put("/spotify/pause", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const r = await axios.put("https://api.spotify.com/v1/me/player/pause", {}, {
      headers: { Authorization: `Bearer ${t.accessToken}` },
      validateStatus: () => true,
    });
    if (r.status >= 400) return res.status(r.status).json(r.data || { error: "spotify_error" });
    return res.status(204).send();
  } catch (e) {
    return res.status(500).json({ error: "pause_failed" });
  }
});





/* ---------------- Spotify Control Proxys ---------------- */
app.get("/spotify/devices", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    let r = await sGet("https://api.spotify.com/v1/me/player/devices", t.accessToken);
    if (r.status === 401 && req.cookies.sp_rt) {
      const rr = await refreshAccessToken(req.cookies.sp_rt);
      if (rr.status === 200) r = await sGet("https://api.spotify.com/v1/me/player/devices", rr.data.access_token);
    }
    return res.status(r.status).json(r.data ?? {});
  } catch (e) {
    console.error("devices error:", e.message);
    return res.status(500).json({ error: "devices_failed" });
  }
});

app.put("/spotify/transfer", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const body = {
      device_ids: Array.isArray(req.body?.device_ids) ? req.body.device_ids : [],
      play: !!req.body?.play,
    };
    const r = await sPut("https://api.spotify.com/v1/me/player", t.accessToken, body);
    return res.status(r.status).send(r.data ?? {});
  } catch (e) {
    console.error("transfer error:", e.message);
    return res.status(500).json({ error: "transfer_failed" });
  }
});

app.put("/spotify/play", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const body = {
      uris: req.body?.uris || undefined,
      position_ms: typeof req.body?.position_ms === "number" ? req.body.position_ms : undefined,
      context_uri: req.body?.context_uri || undefined,
      offset: req.body?.offset || undefined,
    };
    const r = await sPut("https://api.spotify.com/v1/me/player/play", t.accessToken, body);
    return res.status(r.status).send(r.data ?? {});
  } catch (e) {
    console.error("play error:", e.message);
    return res.status(500).json({ error: "play_failed" });
  }
});

app.put("/spotify/pause", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);
    const r = await sPut("https://api.spotify.com/v1/me/player/pause", t.accessToken, {});
    return res.status(r.status).send(r.data ?? {});
  } catch (e) {
    console.error("pause error:", e.message);
    return res.status(500).json({ error: "pause_failed" });
  }
});

/* ---------------------- Logout ------------------------- */
app.post("/logout", (req, res) => {
  const base = cookieBase(req);
  res.clearCookie("sp_at", base);
  res.clearCookie("sp_rt", base);
  res.json({ ok: true });
});

/* -------------- React Build ausliefern (NEU) ----------- */
/** Wir unterstützen beide Projekt-Layouts:
 *  - Backend-Root + ./frontend/build
 *  - Backend-Root + ./build (falls du den Build in Root kopiert hast)
 */
function resolveClientBuild() {
  const p1 = path.join(__dirname, "frontend", "build");
  const p2 = path.join(__dirname, "build");
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  return null;
}

const clientBuildPath = resolveClientBuild();
if (clientBuildPath) {
  // Statische Dateien (JS/CSS/Assets)
  app.use(express.static(clientBuildPath));
  // Catch‑all: alles was keine API/WS-Route war → index.html
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
} else {
  // Fallback: kleine Info-Seite, falls noch kein Build existiert
  app.get("/", (_, res) => {
    res.send(`
      <html>
        <head><title>Celebeaty API</title>
        <style>body{font-family:system-ui;background:#0f1115;color:#e7eaf0;padding:40px}</style></head>
        <body>
          <h1>🚀 Celebeaty API läuft</h1>
          <p>Build nicht gefunden. Bitte <code>cd frontend && npm run build</code> ausführen.</p>
          <p>Health: <code>/health</code></p>
        </body>
      </html>
    `);
  });
}

/* -------------------- WebSocket ------------------------ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    // Einfaches Broadcast-Relay
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });
});

/* ---------------------- Start -------------------------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Celebeaty API listening on :${PORT}`);
  if (clientBuildPath) {
    console.log(`🗂️  Serving React build from: ${clientBuildPath}`);
  }
});
