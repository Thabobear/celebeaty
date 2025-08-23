/**
 * Celebeaty – Single‑Origin Backend (Express + WebSocket + React Build)
 * - Spotify OAuth (Authorization Code) mit httpOnly Cookies
 * - Auto-Refresh des Access Tokens
 * - API: /whoami, /currently-playing, /spotify/* (devices/transfer/play/pause)
 * - WebSocket unter /ws (stabil hinter Proxies wie Render/ngrok)
 * - React-Build aus /public (SPA-Fallback)
 *
 * ENV (Render / lokal .env):
 *   SPOTIFY_CLIENT_ID=...
 *   SPOTIFY_CLIENT_SECRET=...
 *   REDIRECT_URI=https://celebeaty.onrender.com/callback   (lokal: https://<ngrok>/callback)
 *   NODE_ENV=production|development
 * Optional:
 *   FRONTEND_URI=https://celebeaty.onrender.com            (Fallback-Redirect-Ziel)
 */

const express = require("express");
const axios = require("axios");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const app = express();

/* -------------------- Basics -------------------- */
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

/* -------------------- Helpers ------------------- */
function cookieBase(req) {
  // Ermittle HTTPS anhand der Proxy-Header; in prod unbedingt Secure + SameSite=None
  const xfproto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  const isHttps = xfproto.includes("https");
  const isProd = process.env.NODE_ENV === "production";
  const secure = isProd || isHttps;
  const sameSite = secure ? "none" : "lax";
  return { httpOnly: true, secure, sameSite, path: "/" };
}

function getSelfOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
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

  // Falls nur Refresh-Token vorhanden, frisch Access-Token holen
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

async function spotifyGet(url, token) {
  return axios.get(url, { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

async function spotifyPut(url, token, body = undefined) {
  return axios.put(url, body, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    validateStatus: () => true,
  });
}

/* -------------------- Health -------------------- */
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now(), env: process.env.NODE_ENV || "dev" }));

/* -------------------- Auth ---------------------- */
app.get("/login", (req, res) => res.redirect(buildAuthUrl({ forceDialog: false })));
app.get("/force-login", (req, res) => res.redirect(buildAuthUrl({ forceDialog: true })));

/* -------------------- Callback ------------------ */
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing 'code'");

  try {
    // 1) Token holen
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
    if (!access_token) {
      return res.status(500).json({ error: "No access_token from Spotify", details: tokenRes.data });
    }

    // 2) Cookies setzen (httpOnly, SameSite passend, Secure wenn https)
    const base = cookieBase(req);
    res.cookie("sp_at", access_token, { ...base, maxAge: Math.max(1, (expires_in || 3600) - 30) * 1000 });
    if (refresh_token) {
      res.cookie("sp_rt", refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
    }

    // 3) „Zur App zurück“-Seite (robust für WhatsApp/Instagram WebViews)
    const front = (process.env.FRONTEND_URI || getSelfOrigin(req)).replace(/\/+$/, "");
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Spotify Login abgeschlossen</title>
  <style>
    :root{color-scheme:light dark}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0f1115;color:#e7eaf0;
         margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
    .card{max-width:560px;width:100%;background:#161a22;border:1px solid #2a3040;border-radius:14px;
          padding:22px;box-shadow:0 12px 30px rgba(0,0,0,.35)}
    h1{margin:0 0 8px 0;font-size:20px}
    p{margin:0 0 14px 0;color:#9fb0c5}
    a.btn{display:inline-block;background:#1DB954;color:#062;font-weight:800; padding:10px 14px;
          border-radius:10px;text-decoration:none;border:1px solid #19a64b}
    .hint{font-size:13px;color:#9fb0c5;margin-top:10px;line-height:1.35}
  </style>
</head>
<body>
  <div class="card">
    <h1>Login erfolgreich</h1>
    <p>Du wirst gleich zu <strong>Celebeaty</strong> zurückgeleitet.</p>
    <p><a class="btn" href="${front}/">Zur App zurück</a></p>
    <div class="hint">
      Falls du aus WhatsApp/Instagram geöffnet hast und nichts passiert:
      bitte oben „In Safari öffnen“ wählen und dann den Button nutzen.
    </div>
  </div>
  <script>
    // Auto-Weiterleitung (falls der WebView es zulässt)
    setTimeout(function(){ try{ window.location.replace("${front}/"); }catch(e){} }, 1200);
  </script>
</body>
</html>`);
  } catch (err) {
    console.error("Token exchange failed:", err.response?.data || err.message);
    return res.status(500).json({ error: "Token exchange failed", details: err.response?.data || err.message });
  }
});


/* -------------------- API ----------------------- */
// Wer bin ich
app.get("/whoami", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    let r = await spotifyGet("https://api.spotify.com/v1/me", t.accessToken);

    if (r.status === 401 && req.cookies.sp_rt) {
      const rr = await refreshAccessToken(req.cookies.sp_rt);
      if (rr.status === 200) {
        const at = rr.data.access_token;
        const expires_in = rr.data.expires_in || 3600;
        const base = cookieBase(req);
        res.cookie("sp_at", at, { ...base, maxAge: (expires_in - 30) * 1000 });
        if (rr.data.refresh_token) res.cookie("sp_rt", rr.data.refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
        r = await spotifyGet("https://api.spotify.com/v1/me", at);
      }
    }

    if (r.status === 429) {
      const retry = Number(r.headers["retry-after"] || 1);
      res.set("Retry-After", String(retry));
      return res.status(429).json({ error: "rate_limited", retry_after: retry });
    }
    if (r.status >= 400) return res.status(r.status).json({ error: "spotify_error", details: r.data });

    const j = r.data || {};
    return res.json({
      id: j.id,
      display_name: j.display_name || j.id || null,
      email: j.email || null,
      country: j.country || null,
      product: j.product || null,
    });
  } catch (e) {
    console.error("whoami error:", e.message);
    return res.status(500).json({ error: "whoami_failed" });
  }
});

// Aktuell gespielter Track
app.get("/currently-playing", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    let r = await spotifyGet("https://api.spotify.com/v1/me/player/currently-playing", t.accessToken);

    if (r.status === 401 && req.cookies.sp_rt) {
      const rr = await refreshAccessToken(req.cookies.sp_rt);
      if (rr.status === 200) {
        const at = rr.data.access_token;
        const expires_in = rr.data.expires_in || 3600;
        const base = cookieBase(req);
        res.cookie("sp_at", at, { ...base, maxAge: (expires_in - 30) * 1000 });
        if (rr.data.refresh_token) res.cookie("sp_rt", rr.data.refresh_token, { ...base, maxAge: 30 * 24 * 3600 * 1000 });
        r = await spotifyGet("https://api.spotify.com/v1/me/player/currently-playing", at);
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

/* ------ Spotify Control Proxys (Receiver nutzt diese) ------ */
// Geräte abrufen
app.get("/spotify/devices", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    const r = await spotifyGet("https://api.spotify.com/v1/me/player/devices", t.accessToken);
    return res.status(r.status).send(r.data);
  } catch (e) {
    return res.status(500).json({ error: "devices_failed" });
  }
});

// Wiedergabe auf Gerät transferieren
app.put("/spotify/transfer", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    const { device_ids, play = true } = req.body || {};
    const r = await spotifyPut(
      "https://api.spotify.com/v1/me/player",
      t.accessToken,
      { device_ids, play }
    );
    return res.status(r.status).send(r.data);
  } catch (e) {
    return res.status(500).json({ error: "transfer_failed" });
  }
});

// Play
app.put("/spotify/play", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    const r = await spotifyPut("https://api.spotify.com/v1/me/player/play", t.accessToken, req.body || {});
    return res.status(r.status).send(r.data);
  } catch (e) {
    return res.status(500).json({ error: "play_failed" });
  }
});

// Pause
app.put("/spotify/pause", async (req, res) => {
  try {
    const t = await withValidAccessToken(req, res);
    if (t.error) return res.status(t.error.status).json(t.error.body);

    const r = await spotifyPut("https://api.spotify.com/v1/me/player/pause", t.accessToken, {});
    return res.status(r.status).send(r.data);
  } catch (e) {
    return res.status(500).json({ error: "pause_failed" });
  }
});

/* -------------------- Static + SPA -------------------- */
// Statisches Frontend aus /public (hier liegt der React-Build)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { extensions: ["html"] }));

// SPA-Fallback: alles Nicht-API/WS auf index.html
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path.startsWith("/health")) {
    return next();
  }
  const indexFile = path.join(publicDir, "index.html");
  res.sendFile(indexFile, (err) => {
    if (err) {
      // Kleiner Hinweis, falls noch kein Build kopiert wurde
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`
        <html>
          <head><title>Celebeaty API</title>
          <style>body{font-family:system-ui;background:#0f1115;color:#e7eaf0;padding:40px}</style></head>
          <body>
            <h1>🚀 Celebeaty API läuft</h1>
            <p>Build nicht gefunden. Bitte <code>cd frontend && npm run build</code> und Output nach <code>/public</code> kopieren.</p>
            <p>Health: <code>/health</code></p>
          </body>
        </html>
      `);
    }
  });
});

/* ------------------ HTTP + WebSocket ------------------ */
const server = http.createServer(app);

// WS unter /ws terminieren (stabil hinter Render/ngrok)
const wss = new WebSocket.Server({ noServer: true });

function isWsOriginAllowed(req) {
  const origin = req.headers.origin;                 // z.B. https://<dein-ngrok>.ngrok-free.app
  const self = (req.headers["x-forwarded-proto"] || req.protocol || "https")
                + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
  if (!origin) return true;                          // einige Browser schicken kein Origin bei WS
  if (origin === self) return true;                  // gleiche Origin (Render, ngrok, Dev)
  if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) return true;
  return false;
}



server.on("upgrade", (req, socket, head) => {
  try {
    const { url = "", headers = {} } = req;
    if (!url.startsWith("/ws") || !isWsOriginAllowed(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

// Simple Broadcast-Hub: Presence + Track-Events
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    // An alle außer den Sender weiterleiten
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
});
