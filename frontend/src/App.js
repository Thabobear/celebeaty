import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Backend/WS aus ENV (CRA: REACT_APP_*)
 * In Vercel: REACT_APP_BACKEND_URL=https://celebeaty.onrender.com
 * Lokal:     REACT_APP_BACKEND_URL=http://localhost:3001  (oder ngrok)
 */
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";
const WS_URL = BACKEND_URL.replace(/^http/, "ws"); // https->wss, http->ws

// --- Helfer ---
function msToMMSS(ms = 0) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// Präsenz läuft über WebSocket rein (sehr simples Presence-Modell)
function nowTs() {
  return Date.now();
}

export default function App() {
  // Auth + Nutzer
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null); // {id, display_name}

  // Modus: "idle" | "sender" | "receiver"
  const [mode, setMode] = useState("idle");

  // Sender-Zustand
  const [isSharing, setIsSharing] = useState(false);
  const [senderNow, setSenderNow] = useState(null); // {id,name,artists[],progress_ms,image}

  // Receiver-Zustand
  const [followingUserId, setFollowingUserId] = useState(null);
  const [recvNow, setRecvNow] = useState(null); // letzter empfangener Track

  // Lobby / Live-Liste
  const [liveMap, setLiveMap] = useState(new Map()); // userId -> {id,name,since,lastSeen}

  // Hints/Fehler
  const [hint, setHint] = useState("");

  // WS & Interval Refs
  const ws = useRef(null);
  const shareTimer = useRef(null);

  // ===== 1) Token aus URL oder localStorage =====
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const t = qs.get("access_token");
    if (t) {
      setToken(t);
      localStorage.setItem("spotify_token", t);
      window.history.replaceState({}, document.title, "/");
    } else {
      const stored = localStorage.getItem("spotify_token");
      if (stored) setToken(stored);
    }
  }, []);

  // ===== 2) Wer bin ich? =====
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/whoami`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        if (!r.ok) throw new Error(`whoami status ${r.status}`);
        const j = await r.json();
        setMe({ id: j.id, display_name: j.display_name || "Unbekannt" });
      } catch (e) {
        console.warn("whoami error:", e);
      }
    })();
  }, [token]);

  // ===== 3) WebSocket verbinden =====
  useEffect(() => {
    if (!token) return;

    ws.current = new WebSocket(WS_URL);
    ws.current.onopen = () => {
      // leichte Präsenzmeldung beim Connect
      if (me?.id) {
        ws.current.send(JSON.stringify({ type: "hello", userId: me.id, name: me.display_name, ts: nowTs() }));
      }
    };
    ws.current.onclose = () => {};
    ws.current.onerror = (e) => console.warn("WS error", e);

    ws.current.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!data?.type) return;

      // Presence-Start/Stop aus Lobby verarbeiten
      if (data.type === "presence" && data.action && data.user) {
        setLiveMap((prev) => {
          const copy = new Map(prev);
          if (data.action === "start") {
            copy.set(data.user.id, {
              id: data.user.id,
              name: data.user.name,
              since: data.ts || nowTs(),
              lastSeen: data.ts || nowTs(),
            });
          } else if (data.action === "stop") {
            copy.delete(data.user.id);
          } else if (data.action === "ping") {
            const existing = copy.get(data.user.id);
            if (existing) existing.lastSeen = data.ts || nowTs();
          }
          return copy;
        });
        return;
      }

      // Track-Events vom Sender → nur relevant, wenn ich Receiver bin und diesem User folge
      if (data.type === "track") {
        // Lobby „alive halten“
        if (data.user && data.user.id) {
          setLiveMap((prev) => {
            const copy = new Map(prev);
            const existing = copy.get(data.user.id);
            if (existing) existing.lastSeen = data.ts || nowTs();
            return copy;
          });
        }

        if (mode !== "receiver") return;
        if (followingUserId && data.user?.id !== followingUserId) return;

        const { trackId, progress_ms, name, artists, image } = data;

        // UI sofort aktualisieren
        setRecvNow({
          id: trackId,
          name: name || trackId,
          artists: artists || [],
          progress_ms: progress_ms || 0,
          image: image || null,
        });

        // Playback am Empfänger anstoßen (mit sanfter Gerätewahl)
        await ensurePlaybackAndPlay(token, trackId, progress_ms || 0, setHint);
      }
    };

    return () => {
      ws.current?.close();
    };
  }, [token, me?.id, mode, followingUserId]);

  // ===== 4) Sender: periodisch senden, wenn isSharing true =====
  useEffect(() => {
    if (!token) return;
    if (mode !== "sender" || !isSharing) {
      if (shareTimer.current) {
        clearInterval(shareTimer.current);
        shareTimer.current = null;
      }
      return;
    }

    // Präsenz-Start
    if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
      ws.current.send(JSON.stringify({
        type: "presence",
        action: "start",
        user: { id: me.id, name: me.display_name },
        ts: nowTs(),
      }));
    }

    // Ticker: alle 2000ms aktuellen Track holen & an alle schicken
    const tick = async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/currently-playing`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        const data = await r.json();

        if (!data?.is_playing || !data?.track?.id) {
          setSenderNow(null);
          setHint(data?.message || "Kein Song läuft (oder kein aktives Gerät).");
          // Präsenz-Ping ohne Track – hält Lobby am Leben
          if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
            ws.current.send(JSON.stringify({
              type: "presence",
              action: "ping",
              user: { id: me.id, name: me.display_name },
              ts: nowTs(),
            }));
          }
          return;
        }

        const image = data.track?.album?.images?.[0]?.url || null;
        setHint("");
        setSenderNow({
          id: data.track.id,
          name: data.track.name,
          artists: data.track.artists || [],
          progress_ms: data.progress_ms || 0,
          image,
        });

        if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
          ws.current.send(JSON.stringify({
            type: "track",
            user: { id: me.id, name: me.display_name },
            trackId: data.track.id,
            progress_ms: data.progress_ms || 0,
            name: data.track.name,
            artists: data.track.artists || [],
            image,
            ts: nowTs(),
          }));
        }
      } catch (e) {
        console.warn("currently-playing fetch error:", e);
        setHint("Konnte aktuell gespielten Song nicht abrufen.");
      }
    };

    tick();
    shareTimer.current = setInterval(tick, 2000);
    return () => {
      clearInterval(shareTimer.current);
      shareTimer.current = null;
    };
  }, [mode, isSharing, token, me?.id]);

  // ===== 5) Lobby-Ansicht berechnet (Array aus Map) =====
  const liveList = useMemo(() => {
    const arr = Array.from(liveMap.values());
    // inaktive Einträge (kein Ping > 15s) rausfiltern
    const cutoff = Date.now() - 15000;
    return arr
      .filter((x) => (x.lastSeen || x.since || 0) > cutoff)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }, [liveMap]);

  // ===== 6) UI =====
  if (!token) {
    return (
      <div className="layout">
        <Header />
        <main className="main">
          <Card>
            <h2>Login mit Spotify</h2>
            <p>Verbinde dich, um zu sehen, wer gerade teilt – oder starte selbst.</p>
            <div className="row">
              <a className="btn primary" href={`${BACKEND_URL}/login`}>➡️ Login</a>
              <a className="btn" href={`${BACKEND_URL}/force-login`}>👤 Mit anderem Account</a>
            </div>
          </Card>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="layout">
      <Header me={me} onLogout={() => {
        setMode("idle");
        setIsSharing(false);
        setSenderNow(null);
        setRecvNow(null);
        setFollowingUserId(null);
        setHint("");
        setMe(null);
        localStorage.removeItem("spotify_token");
        window.location.href = "/";
      }} />
      <main className="main">

        {/* Hints */}
        {hint && <div className="hint">💡 {hint}</div>}

        {/* Wenn ich gerade sende */}
        {mode === "sender" && (
          <Card>
            <div className="liveBadge">LIVE</div>
            <h2>Du teilst gerade Musik</h2>
            {!senderNow && <p>Warte auf laufenden Song…</p>}
            {senderNow && (
              <NowPlayingBox
                title="Gerade beim Sender"
                track={senderNow}
              />
            )}
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  setIsSharing(false);
                  setMode("idle");
                  if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
                    ws.current.send(JSON.stringify({
                      type: "presence",
                      action: "stop",
                      user: { id: me.id, name: me.display_name },
                      ts: nowTs(),
                    }));
                  }
                }}
              >
                ⏹️ Teilen stoppen
              </button>
            </div>
          </Card>
        )}

        {/* Wenn ich gerade zuhöre */}
        {mode === "receiver" && (
          <Card>
            <h2>Du hörst mit</h2>
            {!recvNow && <p>Warte auf Song vom Sender…</p>}
            {recvNow && (
              <NowPlayingBox
                title="Gerade beim Empfänger"
                track={recvNow}
              />
            )}
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  if (!recvNow?.id) return alert("Noch kein Track empfangen.");
                  try {
                    await replayReceived(token, recvNow);
                  } catch (e) {
                    alert(e.message);
                  }
                }}
              >
                ▶️ Erneut abspielen
              </button>
              <button
                className="btn"
                onClick={() => {
                  setMode("idle");
                  setRecvNow(null);
                  setFollowingUserId(null);
                }}
              >
                ✖️ Verlassen
              </button>
            </div>
          </Card>
        )}

        {/* Lobby – Standardansicht */}
        {mode === "idle" && (
          <>
            <section className="section">
              <div className="sectionHead">
                <h2>Gerade live</h2>
                <small>{liveList.length} {liveList.length === 1 ? "Sender" : "Sender"}</small>
              </div>

              {liveList.length === 0 && (
                <Card muted>
                  <p>Niemand teilt gerade – starte selbst oder warte auf eine Einladung.</p>
                </Card>
              )}

              <div className="grid">
                {liveList.map((u) => (
                  <div key={u.id} className="roomCard">
                    <div className="roomHeader">
                      <div className="avatar">{(u.name || "?").slice(0, 1)}</div>
                      <div className="roomMeta">
                        <div className="roomName">{u.name || "Unbekannt"}</div>
                        <div className="roomSince">seit {new Date(u.since).toLocaleTimeString()}</div>
                      </div>
                      <div className="dot live" />
                    </div>
                    <div className="roomActions">
                      <button
                        className="btn primary"
                        onClick={() => {
                          setFollowingUserId(u.id);
                          setMode("receiver");
                          setHint("Beim nächsten Event starten wir automatisch.");
                        }}
                      >
                        ▶️ Mitspielen
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="section">
              <Card>
                <h2>Selbst teilen</h2>
                <p>Starte deine Live‑Session. Deine Freunde können in „Gerade live“ beitreten.</p>
                <div className="row">
                  <button
                    className="btn primary"
                    onClick={() => {
                      setMode("sender");
                      setIsSharing(true);
                      setHint("Teilen aktiv. Öffne Spotify und spiel einen Song.");
                      // Präsenz sofort melden
                      if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
                        ws.current.send(JSON.stringify({
                          type: "presence",
                          action: "start",
                          user: { id: me.id, name: me.display_name },
                          ts: nowTs(),
                        }));
                      }
                    }}
                  >
                    🎵 Live teilen starten
                  </button>
                </div>
              </Card>
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

// ====== UI Bausteine ======
function Header({ me, onLogout }) {
  return (
    <header className="header">
      <div className="brand">
        <div className="logoDot" />
        <span>Celebeaty</span>
      </div>
      <div className="spacer" />
      {me ? (
        <div className="user">
          <div className="avatar">{(me.display_name || "?").slice(0, 1)}</div>
          <span className="userName">{me.display_name}</span>
          <button className="btn ghost" onClick={onLogout}>🚪 Abmelden</button>
        </div>
      ) : (
        <a className="btn ghost" href={`${BACKEND_URL}/login`}>Login</a>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span>Made with 🎧</span>
    </footer>
  );
}

function Card({ children, muted }) {
  return <div className={`card ${muted ? "muted" : ""}`}>{children}</div>;
}

function NowPlayingBox({ title, track }) {
  return (
    <div className="np">
      <div className="npHead">
        <h3>{title}</h3>
      </div>
      <div className="npBody">
        {track?.image && <img className="cover" src={track.image} alt="Album" />}
        <div className="meta">
          <div className="title">{track?.name || "Unbekannter Titel"}</div>
          <div className="artist">{(track?.artists || []).join(", ")}</div>
          <div className="time">{msToMMSS(track?.progress_ms || 0)}</div>
        </div>
      </div>
    </div>
  );
}

// ====== Playback Helpers (Receiver) ======
async function getDevices(token) {
  const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { devices: [] };
  return r.json();
}

async function transferToDevice(token, deviceId, autoPlay = true) {
  const r = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [deviceId], play: autoPlay }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Transfer-Fehler ${r.status}:\n${t.slice(0, 400)}`);
  }
}

async function ensurePlaybackAndPlay(token, trackId, positionMs, setHint) {
  try {
    const devJson = await getDevices(token);
    const devices = devJson.devices || [];
    if (!devices.length) {
      setHint?.("Kein Spotify‑Gerät verfügbar. Öffne Spotify beim Empfänger.");
      return;
    }
    // best device wählen
    let device = devices.find((d) => d.is_active) || devices.find((d) => !d.is_restricted) || devices[0];

    if (!device.is_active) {
      await transferToDevice(token, device.id, true);
      await new Promise((r) => setTimeout(r, 250));
    }

    const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`], position_ms: positionMs }),
    });
    if (!playRes.ok) {
      const t = await playRes.text();
      if (playRes.status === 403 || playRes.status === 404) {
        setHint?.("Playback nicht möglich. Öffne Spotify & starte kurz manuell.");
      } else {
        setHint?.(`Playback-Fehler ${playRes.status}:\n${t.slice(0, 200)}`);
      }
    } else {
      setHint?.("");
    }
  } catch (e) {
    setHint?.("Fehler beim Starten der Wiedergabe. Öffne Spotify am Empfänger.");
    console.warn(e);
  }
}

async function replayReceived(token, recvNow) {
  const r = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      uris: [`spotify:track:${recvNow.id}`],
      position_ms: recvNow.progress_ms || 0,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Play-Fehler ${r.status}:\n${t.slice(0, 400)}`);
  }
}
