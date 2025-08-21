import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * CRA: Backend-URL aus ENV
 * Prod (Vercel): REACT_APP_BACKEND_URL=https://celebeaty.onrender.com
 * Lokal:         REACT_APP_BACKEND_URL=http://localhost:3001  (oder ngrok)
 */
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";
const WS_URL = BACKEND_URL.replace(/^http/, "ws"); // https->wss, http->ws

// ---------- Helpers ----------
function msToMMSS(ms = 0) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function nowTs() {
  return Date.now();
}

// Deep link to follow sender
function buildFollowLink(senderId) {
  const base = window.location.origin;
  return `${base}/?follow=${encodeURIComponent(senderId)}`;
}

// Lightweight QR image url (keine zusätzliche Lib)
function qrUrl(text) {
  const size = "220x220";
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}&data=${encodeURIComponent(text)}`;
}

export default function App() {
  // Auth + User
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null); // {id, display_name}

  // Mode: "idle" | "sender" | "receiver"
  const [mode, setMode] = useState("idle");

  // Sender state
  const [isSharing, setIsSharing] = useState(false);
  const [senderNow, setSenderNow] = useState(null);

  // Receiver state
  const [followingUserId, setFollowingUserId] = useState(null);
  const [recvNow, setRecvNow] = useState(null);

  // Lobby presence
  const [liveMap, setLiveMap] = useState(new Map()); // userId -> {id,name,since,lastSeen}

  // UI state
  const [hint, setHint] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showQR, setShowQR] = useState(false);

  // Refs
  const ws = useRef(null);
  const shareTimer = useRef(null);

  // ===== 1) URL params (access_token, follow) / localStorage token =====
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const t = qs.get("access_token");
    const follow = qs.get("follow");

    if (t) {
      setToken(t);
      localStorage.setItem("spotify_token", t);
      // URL säubern, follow erhalten falls gesetzt
      const cleanUrl = follow ? `/?follow=${encodeURIComponent(follow)}` : "/";
      window.history.replaceState({}, document.title, cleanUrl);
    } else {
      const stored = localStorage.getItem("spotify_token");
      if (stored) setToken(stored);
    }

    if (follow) {
      setFollowingUserId(follow);
    }
  }, []);

  // ===== 2) whoami =====
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/whoami`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        if (!r.ok) throw new Error(`whoami status ${r.status}`);
        const j = await r.json();
        const display = j.display_name || j.id || "Unbekannt";
        setMe({ id: j.id, display_name: display });
      } catch (e) {
        console.warn("whoami error:", e);
        setMe(null);
      }
    })();
  }, [token]);

  // ===== 3) WebSocket =====
  useEffect(() => {
    if (!token) return;

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      if (me?.id) {
        ws.current.send(JSON.stringify({ type: "hello", userId: me.id, name: me.display_name, ts: nowTs() }));
      }
      // Auto-enter receiver bei deep link
      if (me?.id && followingUserId && mode === "idle") {
        setMode("receiver");
        setHint("Beim nächsten Ereignis starten wir automatisch.");
      }
    };

    ws.current.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!data?.type) return;

      // Presence
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
            const ex = copy.get(data.user.id);
            if (ex) ex.lastSeen = data.ts || nowTs();
          }
          return copy;
        });
        return;
      }

      // Track event
      if (data.type === "track") {
        // keep sender alive in lobby
        if (data.user?.id) {
          setLiveMap((prev) => {
            const copy = new Map(prev);
            const ex = copy.get(data.user.id);
            if (ex) ex.lastSeen = data.ts || nowTs();
            return copy;
          });
        }

        // nur anwenden, wenn Receiver und ich folge diesem Sender
        if (mode !== "receiver") return;
        if (followingUserId && data.user?.id !== followingUserId) return;

        const { trackId, progress_ms, name, artists, image } = data;
        setRecvNow({
          id: trackId,
          name: name || trackId,
          artists: artists || [],
          progress_ms: progress_ms || 0,
          image: image || null,
        });
        await ensurePlaybackAndPlay(token, trackId, progress_ms || 0, setHint);
      }
    };

    ws.current.onclose = () => {};
    ws.current.onerror = (e) => console.warn("WS error", e);

    return () => ws.current?.close();
  }, [token, me?.id, followingUserId, mode]);

  // ===== 4) Sender ticker =====
  useEffect(() => {
    if (!token) return;
    if (mode !== "sender" || !isSharing) {
      if (shareTimer.current) {
        clearInterval(shareTimer.current);
        shareTimer.current = null;
      }
      return;
    }

    // Presence start
    if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
      ws.current.send(JSON.stringify({
        type: "presence",
        action: "start",
        user: { id: me.id, name: me.display_name },
        ts: nowTs(),
      }));
    }

    const tick = async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/currently-playing`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        const data = await r.json();

        if (!data?.is_playing || !data?.track?.id) {
          setSenderNow(null);
          setHint(data?.message || "Kein Song läuft oder kein aktives Gerät.");
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

  // ===== 5) LiveList =====
  const liveList = useMemo(() => {
    const arr = Array.from(liveMap.values());
    const cutoff = Date.now() - 15000;
    return arr
      .filter((x) => (x.lastSeen || x.since || 0) > cutoff)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }, [liveMap]);

  // ===== UI =====
  if (!token) {
    return (
      <div className="layout">
        <Header />
        <main className="main">
          <div className="hero">
            <LogoWord />
            <p className="heroSub">Der exklusive Club, um live mit deinen Idolen mitzuhören.</p>
          </div>
          <div className="ctaCard card">
            <h2>Login mit Spotify</h2>
            <p>Sieh, wer gerade teilt – oder starte deine eigene Live‑Session.</p>
            <div className="row">
              <a className="btn primary" href={`${BACKEND_URL}/login`}>Login</a>
              <a className="btn" href={`${BACKEND_URL}/force-login`}>Mit anderem Account</a>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const inviteLink = me?.id ? buildFollowLink(me.id) : "";

  return (
    <div className="layout">
      <Header
        me={me}
        onLogout={() => {
          setMode("idle");
          setIsSharing(false);
          setSenderNow(null);
          setRecvNow(null);
          setFollowingUserId(null);
          setHint("");
          setMe(null);
          localStorage.removeItem("spotify_token");
          window.location.href = "/";
        }}
        onOpenMenu={() => setShowMenu((v) => !v)}
        menuOpen={showMenu}
      />

      <main className="main">
        {hint && <div className="hint">{hint}</div>}

        {/* Sender view */}
        {mode === "sender" && (
          <div className="grid2">
            <div className="card">
              <div className="liveBadge">LIVE</div>
              <h2>Du teilst gerade Musik</h2>
              {!senderNow && <p>Warte auf laufenden Song…</p>}
              {senderNow && <NowPlayingBox title="Gerade beim Sender" track={senderNow} />}
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
                  Teilen stoppen
                </button>
                <button className="btn" onClick={() => setShowInvite(true)}>
                  Einladen
                </button>
              </div>
            </div>

            <div className="card">
              <h3>Einladung</h3>
              <p>Teile deinen persönlichen Link – Freunde joinen mit einem Klick.</p>
              <div className="inviteRow">
                <code className="inviteLink">{inviteLink}</code>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inviteLink);
                      setHint("Einladungslink kopiert.");
                    } catch {
                      setHint("Konnte Link nicht kopieren.");
                    }
                  }}
                >
                  Link kopieren
                </button>
              </div>
              <div className="row">
                <button className="btn" onClick={() => setShowQR(true)}>
                  QR anzeigen
                </button>
                {"share" in navigator && (
                  <button
                    className="btn"
                    onClick={() => {
                      navigator
                        .share({
                          title: "Celebeaty – hör mit",
                          text: "Join my live session on Celebeaty",
                          url: inviteLink,
                        })
                        .catch(() => {});
                    }}
                  >
                    Systemteilen
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Receiver view */}
        {mode === "receiver" && (
          <div className="card">
            <h2>Du hörst mit</h2>
            {!recvNow && <p>Warte auf Song vom Sender…</p>}
            {recvNow && <NowPlayingBox title="Gerade beim Empfänger" track={recvNow} />}
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
                Erneut abspielen
              </button>
              <button
                className="btn"
                onClick={() => {
                  setMode("idle");
                  setRecvNow(null);
                  setFollowingUserId(null);
                }}
              >
                Verlassen
              </button>
            </div>
          </div>
        )}

        {/* Lobby */}
        {mode === "idle" && (
          <>
            <section className="section">
              <div className="sectionHead">
                <h2>Gerade live</h2>
                <small>{liveList.length} {liveList.length === 1 ? "Sender" : "Sender"}</small>
              </div>

              {liveList.length === 0 && (
                <div className="card muted">
                  <p>Niemand teilt gerade – starte selbst oder warte auf eine Einladung.</p>
                </div>
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
                          setHint("Beim nächsten Ereignis starten wir automatisch.");
                        }}
                      >
                        Mitspielen
                      </button>
                      <button
                        className="btn"
                        onClick={async () => {
                          const link = buildFollowLink(u.id);
                          try {
                            await navigator.clipboard.writeText(link);
                            setHint("Join-Link kopiert.");
                          } catch {}
                        }}
                      >
                        Link kopieren
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="section">
              <div className="card">
                <h2>Selbst teilen</h2>
                <p>Starte deine Live‑Session. Deine Freunde können in „Gerade live“ beitreten.</p>
                <div className="row">
                  <button
                    className="btn primary"
                    onClick={() => {
                      setMode("sender");
                      setIsSharing(true);
                      setHint("Teilen aktiv. Öffne Spotify und spiele einen Song.");
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
                    Live teilen starten
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </main>

      <Footer />

      {/* ---- Menü (Header) ---- */}
      {showMenu && (
        <Menu onClose={() => setShowMenu(false)}>
          <button className="menuItem" onClick={() => { window.location.href = `${BACKEND_URL}/force-login`; }}>
            Mit anderem Account
          </button>
          <button className="menuItem" onClick={() => { setShowMenu(false); alert("Support: hello@celebeaty.com"); }}>
            Support
          </button>
          <button
            className="menuItem danger"
            onClick={() => {
              setShowMenu(false);
              // Hard logout
              setMode("idle");
              setIsSharing(false);
              setSenderNow(null);
              setRecvNow(null);
              setFollowingUserId(null);
              setHint("");
              setMe(null);
              localStorage.removeItem("spotify_token");
              window.location.href = "/";
            }}
          >
            Abmelden
          </button>
        </Menu>
      )}

      {/* ---- Invite Modal ---- */}
      {showInvite && (
        <Modal onClose={() => setShowInvite(false)} title="Freunde einladen">
          <p>Teile diesen Link, damit Freunde direkt deiner Session folgen:</p>
          <div className="inviteRow">
            <code className="inviteLink">{inviteLink}</code>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(inviteLink);
                  setHint("Einladungslink kopiert.");
                } catch {}
              }}
            >
              Link kopieren
            </button>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setShowQR(true)}>QR anzeigen</button>
            {"share" in navigator && (
              <button
                className="btn"
                onClick={() => {
                  navigator.share({ title: "Celebeaty – hör mit", url: inviteLink }).catch(() => {});
                }}
              >
                Systemteilen
              </button>
            )}
          </div>
        </Modal>
      )}

      {/* ---- QR Modal ---- */}
      {showQR && (
        <Modal onClose={() => setShowQR(false)} title="QR‑Code">
          <div className="qrWrap">
            <img className="qrImg" src={qrUrl(inviteLink)} alt="QR" />
          </div>
          <p className="qrHint">Freunde scannen – sie joinen direkt deiner Session.</p>
        </Modal>
      )}
    </div>
  );
}

// ---------- UI Components ----------

function Header({ me, onLogout, onOpenMenu, menuOpen }) {
  return (
    <header className="header">
      <div className="brand">
        <LogoMark />
        <span>Celebeaty</span>
      </div>
      <div className="spacer" />
      {me ? (
        <div className="user">
          <div className="avatar">{(me.display_name || "?").slice(0, 1)}</div>
          <span className="userName">{me.display_name}</span>
          <button className="btn ghost" onClick={onOpenMenu}>{menuOpen ? "Schließen" : "Optionen"}</button>
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
      <span>Celebeaty</span>
    </footer>
  );
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

function Menu({ children, onClose }) {
  useEffect(() => {
    const onEsc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <div className="menuOverlay" onClick={onClose}>
      <div className="menuSheet" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  useEffect(() => {
    const onEsc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <h3>{title}</h3>
          <button className="btn ghost" onClick={onClose}>Schließen</button>
        </div>
        <div className="modalBody">{children}</div>
      </div>
    </div>
  );
}

// ---------- Logos (Ivory Luxe) ----------

function LogoMark() {
  return (
    <svg
      viewBox="0 0 140 140"
      width="72"
      height="72"
      role="img"
      aria-label="CB Logo"
    >
      <defs>
        {/* Champagne-Gradient wie im UI */}
        <linearGradient id="champ" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#E9DCCB" />
          <stop offset="100%" stopColor="#D9C4A1" />
        </linearGradient>

        {/* zarter Glanz */}
        <radialGradient id="gloss" cx="30%" cy="20%" r="60%">
          <stop offset="0%" stopColor="rgba(255,255,255,.65)" />
          <stop offset="60%" stopColor="rgba(255,255,255,.15)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>

        {/* sanfter Schatten */}
        <filter id="softShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="6" stdDeviation="6" floodOpacity="0.18" />
        </filter>
      </defs>

      {/* Hintergrundkreis */}
      <circle
        cx="70"
        cy="70"
        r="64"
        fill="url(#champ)"
        stroke="#FFFFFF"
        strokeOpacity=".4"
        strokeWidth="2"
        filter="url(#softShadow)"
      />

      {/* zarte Innenkante */}
      <circle
        cx="70"
        cy="70"
        r="50"
        fill="none"
        stroke="rgba(255,255,255,.35)"
        strokeWidth="1.25"
      />

      {/* Glanz oben links */}
      <circle cx="70" cy="70" r="64" fill="url(#gloss)" />

      {/* Initialen CB */}
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        fontFamily="'Roboto Condensed', Helvetica, Arial, sans-serif"
        fontSize="54"
        fontWeight="700"
        letterSpacing="1.5"
        fill="#2B2A27"
      >
        CB
      </text>
    </svg>
  );
}



function LogoWord() {
  return (
    <div className="logoLarge">
      <svg viewBox="0 0 480 100" width="360" height="88" aria-hidden>
        <defs>
          <linearGradient id="champ2" x1="0" y1="0" x2="1" y2="1">
            {/* kräftiger, dunklerer Gold-Verlauf */}
            <stop offset="0%" stopColor="#D2B48C"/>
            <stop offset="100%" stopColor="#A67C52"/>
          </linearGradient>
        </defs>
        <text
          x="50%"
          y="68"
          textAnchor="middle"
          fontFamily="Inter, ui-sans-serif"
          fontSize="66"
          fontWeight="900"
          fill="url(#champ2)"
        >
          Celebeaty
        </text>
      </svg>
    </div>
  );
}


// ---------- Playback Helpers (Receiver) ----------
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
        setHint?.("Playback nicht möglich. Öffne Spotify und starte kurz manuell.");
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
    body: JSON.stringify({ uris: [`spotify:track:${recvNow.id}`], position_ms: recvNow.progress_ms || 0 }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Play-Fehler ${r.status}:\n${t.slice(0, 400)}`);
  }
}
