/**
 * Celebeaty Backend (Express + WebSocket)
 * - OAuth Login zu Spotify (Authorization Code)
 * - /callback tauscht Code -> Access Token, leitet mit ?access_token=... ins Frontend
 * - /whoami ruft Spotify /me ab (mit erweiterten Scopes)
 * - /currently-playing ruft aktuell gespielten Track ab
 * - WebSocket broadcastet Presence & Track-Events
 *
 * ENV (Render / lokal .env):
 *   SPOTIFY_CLIENT_ID=...
 *   SPOTIFY_CLIENT_SECRET=...
 *   REDIRECT_URI=https://celebeaty.onrender.com/callback   (oder ngrok)
 *   FRONTEND_URI=https://<deine-frontend-domain>           (vercel oder localhost)
 *   CORS_ORIGIN=https://<deine-frontend-domain>[,https://weitere.domain]
 *   PORT=3001  (lokal; Render setzt selbst)
 *   NODE_ENV=production|development
 */

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const app = express();

// ---------- CORS ----------
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // z.B. Curl/Postman
      if (corsOrigins.length === 0) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin ${origin}`));
    },
    credentials: false, // wir setzen aktuell keine Cookies
  })
);

app.use(express.json());

// Optional: statische Dateien (falls du ein kleines Landing im /public hast)
app.use(express.static(path.join(__dirname, "public")));

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------- Spotify Login ----------
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

  if (forceDialog) {
    params.set("show_dialog", "true");
  }

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

app.get("/login", (req, res) => {
  res.redirect(buildAuthUrl({ forceDialog: false }));
});

// Expliziter Account-Wechsel (zeigt Login-Auswahl)
app.get("/force-login", (req, res) => {
  res.redirect(buildAuthUrl({ forceDialog: true }));
});

// ---------- Spotify Callback: Code -> Token ----------
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
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token /*, refresh_token, expires_in */ } = tokenRes.data || {};
    if (!access_token) {
      return res.status(500).json({ error: "No access_token from Spotify", details: tokenRes.data });
    }

    // Redirect ins Frontend – Access Token in Query
    const front = process.env.FRONTEND_URI || "http://localhost:3000";
    const redirectTo = `${front.replace(/\/+$/, "")}/?access_token=${encodeURIComponent(access_token)}`;
    return res.redirect(redirectTo);
  } catch (err) {
    console.error("Token exchange failed:", err.response?.data || err.message);
    return res
      .status(500)
      .json({ error: "Token exchange failed", details: err.response?.data || err.message });
  }
});

// ---------- Helper: Spotify API Call ----------
async function spotifyGet(url, token) {
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  return r;
}

// ---------- Who am I ----------
app.get("/whoami", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const r = await spotifyGet("https://api.spotify.com/v1/me", token);
    if (r.status === 401) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (r.status >= 400) {
      return res.status(r.status).json({ error: "spotify_error", details: r.data });
    }
    const j = r.data || {};
    return res.json({
      id: j.id,
      display_name: j.display_name || null,
      email: j.email || null,
      country: j.country || null,
      product: j.product || null,
    });
  } catch (e) {
    console.error("whoami error:", e.message);
    return res.status(500).json({ error: "whoami_failed" });
  }
});

// ---------- Currently Playing ----------
app.get("/currently-playing", async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const r = await spotifyGet("https://api.spotify.com/v1/me/player/currently-playing", token);

    if (r.status === 204 || !r.data) {
      return res.json({ message: "Kein Song wird gerade gespielt.", reason: "no_item" });
    }
    if (r.status === 200 && r.data) {
      const data = r.data;
      const item = data.item;

      if (!item) {
        // Werbung / Private Session usw.
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

    // Andere Fehler-Codes von Spotify
    return res.status(r.status).json({ error: "spotify_error", details: r.data });
  } catch (e) {
    console.error("currently-playing error:", e.response?.data || e.message);
    return res.status(500).json({ error: "currently_playing_failed" });
  }
});

// ---------- Catch-all (optional, falls du ohne eigenes Frontend-Hosting testen willst) ----------
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>Celebeaty API</title>
      <style>body{font-family:system-ui;background:#0f1115;color:#e7eaf0;padding:40px}</style>
      </head>
      <body>
        <h1>🚀 Celebeaty API läuft</h1>
        <p>Login: <a style="color:#1DB954" href="/login">/login</a></p>
        <p>Force-Login: <a style="color:#1DB954" href="/force-login">/force-login</a></p>
        <p>Health: <code>/health</code></p>
      </body>
    </html>
  `);
});

// ---------- WS-Server ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Simple Broadcast-Hub: Presence + Track-Events
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    // An alle außer Sender weiterleiten
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ Celebeaty API listening on :${PORT}`);
});
