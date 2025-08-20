// index.js — Backend (Render-ready, Port aus Env; robust + Directory + WS keepalive)
require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch"); // npm i node-fetch@2
const cors = require("cors");
const cookieParser = require("cookie-parser");
const querystring = require("querystring");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();

// --- CORS: Prod eng, Dev weit ---
const allow = process.env.CORS_ORIGIN?.split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: allow && allow.length ? allow : "*"}));

app.use(express.json());
app.use(cookieParser());

// --- Mini-Logger ---
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ===== Spotify Config =====
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;      // e.g. https://api.celebeaty.com/callback
const FRONTEND_URI = process.env.FRONTEND_URI || "http://localhost:5173";

// ===== Helpers =====
function rand(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const parseJsonSafe = (txt) => {
  if (!txt || !txt.trim()) return null;
  try { return JSON.parse(txt); } catch { return null; }
};

// ===== Auth Flows =====
app.get("/login", (req, res) => {
  const state = rand(16);
  res.cookie("spotify_auth_state", state);
  const scope = "user-read-playback-state user-read-currently-playing user-modify-playback-state";
  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    querystring.stringify({
      response_type: "code",
      client_id: CLIENT_ID,
      scope,
      redirect_uri: REDIRECT_URI,
      state,
    });
  res.redirect(authUrl);
});

app.get("/force-login", (_req, res) => {
  res.clearCookie("spotify_auth_state");
  res.redirect("/login");
});

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
      body: querystring.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.error) {
      console.error("Token Error:", tokenJson);
      return res.status(400).json(tokenJson);
    }
    const url =
      FRONTEND_URI +
      "/?access_token=" +
      encodeURIComponent(tokenJson.access_token) +
      (tokenJson.refresh_token ? "&refresh_token=" + encodeURIComponent(tokenJson.refresh_token) : "");
    res.redirect(url);
  } catch (e) {
    console.error("Callback error:", e);
    res.status(500).json({ error: "callback_error" });
  }
});

app.get("/refresh_token", async (req, res) => {
  const refresh_token = req.query.refresh_token;
  if (!refresh_token) return res.status(400).json({ error: "no_refresh_token" });
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
      body: querystring.stringify({
        grant_type: "refresh_token",
        refresh_token,
      }),
    });
    const tokenJson = await tokenRes.json();
    res.json(tokenJson);
  } catch (e) {
    console.error("refresh_token error:", e);
    res.status(500).json({ error: "refresh_error" });
  }
});

// ===== WhoAmI =====
app.get("/whoami", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const r = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: "Bearer " + token },
    });
    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      console.error("whoami fail:", r.status, txt);
      return res.status(r.status).json({ error: "whoami_failed", status: r.status, body: txt });
    }
    const j = parseJsonSafe(txt);
    res.json({
      id: j?.id,
      name: j?.display_name || j?.id || "Unbekannt",
      avatar: (j?.images && j.images[0]?.url) || null,
    });
  } catch (e) {
    console.error("whoami exception:", e);
    res.status(500).json({ error: "whoami_exception", details: String(e) });
  }
});

// ===== Currently Playing (robust) =====
app.get("/currently-playing", async (req, res) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(400).json({ error: "No token provided" });

  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };

  try {
    const r = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing?market=from_token&additional_types=track,episode",
      { headers }
    );

    if (r.status === 204) {
      const r2 = await fetch("https://api.spotify.com/v1/me/player", { headers });
      const txt2 = await r2.text().catch(() => "");
      const j2 = parseJsonSafe(txt2);
      const hasDevice = !!(j2?.device || (Array.isArray(j2?.devices) && j2.devices.length));
      return res.json({
        is_playing: false,
        reason: hasDevice ? "no_item" : "no_active_device",
        message: hasDevice ? "Kein Song läuft (204)." : "Kein aktives Gerät. Öffne Spotify am Sender.",
      });
    }

    const txt = await r.text().catch(() => "");
    const j = parseJsonSafe(txt);

    if (!j) {
      const r2 = await fetch("https://api.spotify.com/v1/me/player", { headers });
      const txt2 = await r2.text().catch(() => "");
      const j2 = parseJsonSafe(txt2);
      return res.json({
        is_playing: !!j2?.is_playing,
        reason: "empty_response",
        message: "Leere Antwort von currently-playing – erneut versuchen.",
        device_active: !!j2?.device,
      });
    }

    if (!j.item) {
      const type = j.currently_playing_type || "unknown";
      return res.json({
        is_playing: !!j.is_playing,
        reason: type === "ad" ? "ad" : "no_item",
        message: type === "ad"
          ? "Werbung läuft – warte bis ein Song startet."
          : "Kein item. Evtl. Private Session aktiv oder Werbung.",
        type,
      });
    }

    const type = j.currently_playing_type;
    const base = {
      is_playing: !!j.is_playing,
      progress_ms: j.progress_ms ?? 0,
      type,
    };

    if (type === "track") {
      const it = j.item;
      return res.json({
        ...base,
        track: {
          id: it.id,
          name: it.name,
          artists: it.artists?.map((a) => a.name) || [],
          album: {
            name: it.album?.name,
            images: it.album?.images || [],
            spotify_url: it.album?.external_urls?.spotify,
          },
          spotify_url: it.external_urls?.spotify,
          duration_ms: it.duration_ms,
        },
      });
    }

    if (type === "episode") {
      const ep = j.item;
      return res.json({
        ...base,
        track: {
          id: ep.id,
          name: ep.name,
          artists: [ep.show?.publisher || ep.show?.name || "Podcast"],
          album: {
            name: ep.show?.name,
            images: ep.images || ep.show?.images || [],
            spotify_url: ep.external_urls?.spotify,
          },
          spotify_url: ep.external_urls?.spotify,
          duration_ms: ep.duration_ms,
        },
      });
    }

    return res.json({
      ...base,
      reason: "unsupported_type",
      message: `Nicht unterstützter Typ: ${type || "unbekannt"}`,
    });
  } catch (e) {
    console.error("currently-playing error (caught):", e);
    res.status(200).json({
      is_playing: false,
      reason: "fetch_error",
      message: "Spotify antwortete nicht sauber. Bitte erneut versuchen.",
    });
  }
});

// ===== HTTP + WS =====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Directory & Rooms
const rooms = new Map();      // roomId -> Set(ws)
const directory = new Map();  // roomId -> { roomId, host:{id,name,avatar}, since:number }

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}
function broadcastToAll(data) {
  const payload = JSON.stringify(data);
  let n = 0;
  wss.clients.forEach((c) => {
    if (c.readyState === 1) { c.send(payload); n++; }
  });
  console.log(`WS broadcastAll type=${data?.type} to ${n} client(s)`);
}
function broadcastRoom(roomId, data, except) {
  const payload = JSON.stringify(data);
  const set = rooms.get(roomId);
  if (!set) return;
  let n = 0;
  for (const c of set) {
    if (c.readyState === 1 && c !== except) { c.send(payload); n++; }
  }
  console.log(`WS broadcastRoom room=${roomId} type=${data?.type} to ${n} client(s)`);
}
function sendDirectorySnapshot(ws) {
  const lives = Array.from(directory.values());
  ws.send(JSON.stringify({ type: "directory", lives }));
  console.log(`WS sent directory snapshot (${lives.length} live)`);
}

// Heartbeat (Ping/Pong)
function heartbeat() { this.isAlive = true; }
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.meta = { roomId: null, user: null };
  sendDirectorySnapshot(ws);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "identify" && msg.user) {
      ws.meta.user = msg.user;
      return;
    }

    if (msg.type === "join" && msg.roomId) {
      const prev = ws.meta.roomId;
      if (prev && rooms.has(prev)) rooms.get(prev).delete(ws);
      ws.meta.roomId = msg.roomId;
      ensureRoom(msg.roomId).add(ws);
      console.log(`WS join room=${msg.roomId}`);
      return;
    }

    if (msg.type === "go_live" && msg.roomId && msg.host) {
      ws.meta.roomId = msg.roomId;
      ensureRoom(msg.roomId).add(ws);
      directory.set(msg.roomId, { roomId: msg.roomId, host: msg.host, since: Date.now() });
      broadcastToAll({ type: "directory", lives: Array.from(directory.values()) });
      console.log(`WS go_live room=${msg.roomId} host=${msg.host?.name || "?"}`);
      return;
    }

    if (msg.type === "go_offline" && msg.roomId) {
      directory.delete(msg.roomId);
      broadcastToAll({ type: "directory", lives: Array.from(directory.values()) });
      console.log(`WS go_offline room=${msg.roomId}`);
      return;
    }

    // Relay: sync / track (legacy) / snapshot_request
    if ((msg.type === "sync" || msg.type === "track" || msg.type === "snapshot_request") && ws.meta.roomId) {
      broadcastRoom(ws.meta.roomId, msg, ws);
      return;
    }
  });

  ws.on("close", () => {
    const r = ws.meta.roomId;
    if (r && rooms.has(r)) rooms.get(r).delete(ws);
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 25000);
wss.on("close", () => clearInterval(pingInterval));

// Error-Handler
app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ error: "internal_error", details: String(err?.stack || err) });
});

// Start
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Backend läuft auf Port ${PORT}`);
});
