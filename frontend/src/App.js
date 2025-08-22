import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * BACKEND ableiten:
 * - Single-Origin (bgrok/Prod): BACKEND_URL leer lassen → gleiche Origin
 * - Lokal getrennt: per REACT_APP_BACKEND_URL setzen
 */
// Ganz oben in src/App.js
const BACKEND_URL =
  (typeof process !== "undefined" && process.env && process.env.REACT_APP_BACKEND_URL) ||
  (window.location.hostname.endsWith("vercel.app") ? "https://celebeaty.onrender.com" : "");


// WebSocket-URL aus Backend/Origin bauen
const WS_BASE = (BACKEND_URL || window.location.origin).replace(
  /^http(s?):/,
  (m, s) => (s ? "wss:" : "ws:")
);
const WS_URL = WS_BASE.replace(/\/+$/, "") + "/ws";

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
const baseOrigin = window.location.origin;
function buildFollowLink(senderId) {
  return `${baseOrigin}/?follow=${encodeURIComponent(senderId)}`;
}

// Snapshot des Senders bauen (für sofortigen Einstieg)
function buildSenderSnapshot(me, senderNow) {
  if (!senderNow) return null;
  return {
    type: senderNow.is_playing ? "track" : "pause",
    user: { id: me.id, name: me.display_name },
    trackId: senderNow.id || senderNow.trackId,
    progress_ms: senderNow.progress_ms || 0,
    name: senderNow.name,
    artists: senderNow.artists || [],
    image: senderNow.image || null,
    is_playing: !!senderNow.is_playing,
    ts: nowTs(),
  };
}

// ---------- Playback via Backend-Proxys ----------
async function getDevices() {
  const r = await fetch(`${BACKEND_URL}/spotify/devices`, { credentials: "include" });
  if (!r.ok) return { devices: [] };
  return r.json();
}
async function transferToDevice(deviceId, autoPlay = true) {
  const r = await fetch(`${BACKEND_URL}/spotify/transfer`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [deviceId], play: autoPlay }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Transfer-Fehler ${r.status}:\n${t.slice(0, 400)}`);
  }
}
async function backendPlay({ uris, position_ms }) {
  const r = await fetch(`${BACKEND_URL}/spotify/play`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris, position_ms }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Play-Fehler ${r.status}:\n${t.slice(0, 400)}`);
  }
}
async function backendPause() {
  try {
    await fetch(`${BACKEND_URL}/spotify/pause`, { method: "PUT", credentials: "include" });
  } catch {}
}

async function ensurePlaybackAndPlay(trackId, leaderPositionMs, leaderSentAt, setHint) {
  try {
    const devJson = await getDevices();
    const devices = devJson.devices || [];
    if (!devices.length) {
      setHint?.("Kein Spotify‑Gerät verfügbar. Öffne Spotify beim Empfänger.");
      return;
    }
    let device =
      devices.find((d) => d.is_active) || devices.find((d) => !d.is_restricted) || devices[0];
    if (!device?.id) {
      setHint?.("Kein geeignetes Gerät. Öffne Spotify einmal aktiv.");
      return;
    }
    if (!device.is_active) {
      await transferToDevice(device.id, true);
      await new Promise((r) => setTimeout(r, 250));
    }
    const now = Date.now();
    const desired = Math.max(0, (leaderPositionMs || 0) + (now - (leaderSentAt || now)));
    await backendPlay({ uris: [`spotify:track:${trackId}`], position_ms: desired });
    setHint?.("");
  } catch (e) {
    setHint?.("Fehler beim Starten der Wiedergabe. Öffne Spotify beim Empfänger.");
    console.warn(e);
  }
}

export default function App() {
  // Auth + User
  const [me, setMe] = useState(null); // {id, display_name}

  // Mode: "idle" | "sender" | "receiver"
  const [mode, setMode] = useState("idle");

  // Sender state
  const [isSharing, setIsSharing] = useState(false);
  const [senderNow, setSenderNow] = useState(null); // {id,name,artists[],image,progress_ms,is_playing}

  // Receiver state
  const [followingUserId, setFollowingUserId] = useState(null);
  const prevFollowingRef = useRef(null);
  const [recvNow, setRecvNow] = useState(null); // {id,...,_leaderTs,is_playing}

  // Lobby presence (+ lastTrack)
  const [liveMap, setLiveMap] = useState(new Map());
  // Followers: targetUserId -> Map<followerId, {id,name,ts}>
  const [followers, setFollowers] = useState(new Map());

  // UI state
  const [hint, setHint] = useState("");
  const [showMenu, setShowMenu] = useState(false);

  // Refs
  const ws = useRef(null);
  const shareTimer = useRef(null);

  // —— Anti-Ruckel + Initial‑Snapshot ——
  const lastBroadcastRef = useRef({
    trackId: null,
    is_playing: null,
    progress_ms: 0,
    sentAt: 0,
  });
  const lastPresencePingRef = useRef(0);
  const hasSentInitialRef = useRef(false);

  // Name des aktuellen Senders (für Receiver-Texte)
  const senderDisplay = useMemo(() => {
    if (!followingUserId) return "dem Sender";
    const u = liveMap.get(followingUserId);
    return u?.name || "dem Sender";
  }, [followingUserId, liveMap]);

  // ===== 1) URL params (follow) =====
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const follow = qs.get("follow");
    if (follow) setFollowingUserId(follow);
  }, []);

  // ===== 2) whoami (Cookies) =====
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/whoami`, {
          credentials: "include",
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
  }, []);

  // ===== 3) WebSocket =====
  useEffect(() => {
    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      if (me?.id) {
        ws.current.send(
          JSON.stringify({ type: "hello", userId: me.id, name: me.display_name, ts: nowTs() })
        );
      }
      if (me?.id && followingUserId && mode === "idle") {
        setMode("receiver");
        setHint(""); // keine alte Meldung
        ws.current.send(
          JSON.stringify({
            type: "follow",
            targetUserId: followingUserId,
            user: { id: me.id, name: me.display_name },
            ts: nowTs(),
          })
        );
        ws.current.send(
          JSON.stringify({
            type: "req_snapshot",
            targetUserId: followingUserId,
            user: { id: me.id, name: me.display_name },
            ts: nowTs(),
          })
        );
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
          const uid = data.user.id;
          if (data.action === "start") {
            copy.set(uid, {
              id: uid,
              name: data.user.name,
              since: data.ts || nowTs(),
              lastSeen: data.ts || nowTs(),
              lastTrack: copy.get(uid)?.lastTrack,
            });
          } else if (data.action === "stop") {
            copy.delete(uid);
            setFollowers((prevF) => {
              const fcopy = new Map(prevF);
              fcopy.delete(uid);
              return fcopy;
            });
          } else if (data.action === "ping") {
            const ex = copy.get(uid);
            if (ex) ex.lastSeen = data.ts || nowTs();
          }
          return copy;
        });
        return;
      }

      // Snapshot anfordern → Sender antwortet sofort
      if (data.type === "req_snapshot") {
        if (mode === "sender" && me?.id && data.targetUserId === me.id && senderNow) {
          const snap = buildSenderSnapshot(me, senderNow);
          if (snap && ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(snap));
            lastBroadcastRef.current = {
              trackId: snap.trackId,
              is_playing: snap.is_playing,
              progress_ms: snap.progress_ms,
              sentAt: Date.now(),
            };
          }
        }
        return;
      }

      // Track / Pause-Events
      if (data.type === "track" || data.type === "pause") {
        const { user, trackId, progress_ms, name, artists, image, ts, is_playing } = data;

        // Lobby-Preview aktualisieren
        if (user?.id) {
          setLiveMap((prev) => {
            const copy = new Map(prev);
            const ex = copy.get(user.id) || {
              id: user.id,
              name: user.name,
              since: ts || nowTs(),
              lastSeen: ts || nowTs(),
            };
            ex.lastSeen = ts || nowTs();
            ex.lastTrack = {
              trackId,
              name: name || trackId,
              artists: artists || [],
              image: image || null,
              atTs: ts || nowTs(),
              progress_ms: progress_ms || 0,
              is_playing: !!is_playing,
            };
            copy.set(user.id, ex);
            return copy;
          });
        }

        // Receiver synchronisieren – nur wenn ich diesem Sender folge
        if (mode === "receiver" && followingUserId && user?.id === followingUserId) {
          if (data.type === "pause" || is_playing === false) {
            await backendPause().catch(() => {});
            setRecvNow((prev) => ({
              ...(prev || {}),
              id: trackId,
              name: name || trackId,
              artists: artists || [],
              image: image || null,
              progress_ms: progress_ms || 0,
              _leaderTs: ts || nowTs(),
              is_playing: false,
            }));
          } else {
            setRecvNow({
              id: trackId,
              name: name || trackId,
              artists: artists || [],
              progress_ms: progress_ms || 0,
              image: image || null,
              _leaderTs: ts || nowTs(),
              is_playing: true,
            });
            await ensurePlaybackAndPlay(trackId, progress_ms || 0, ts, setHint);
          }
        }
        return;
      }

      // Follow/Unfollow – Zuhörer zählen
      if (data.type === "follow" && data.targetUserId && data.user?.id) {
        setFollowers((prev) => {
          const copy = new Map(prev);
          const inner = new Map(copy.get(data.targetUserId) || new Map());
          inner.set(data.user.id, {
            id: data.user.id,
            name: data.user.name || data.user.id,
            ts: data.ts || nowTs(),
          });
          copy.set(data.targetUserId, inner);
          return copy;
        });

        // Wenn ich der Sender bin und jemand mir folgt → sofort Snapshot senden
        if (mode === "sender" && me?.id && data.targetUserId === me.id && senderNow) {
          const snapshot = buildSenderSnapshot(me, senderNow);
          try {
            ws.current?.readyState === WebSocket.OPEN &&
              ws.current.send(JSON.stringify(snapshot));
            lastBroadcastRef.current = {
              trackId: snapshot.trackId,
              is_playing: snapshot.is_playing,
              progress_ms: snapshot.progress_ms,
              sentAt: Date.now(),
            };
          } catch {}
        }
        return;
      }

      if (data.type === "unfollow" && data.targetUserId && data.user?.id) {
        setFollowers((prev) => {
          const copy = new Map(prev);
          const inner = new Map(copy.get(data.targetUserId) || new Map());
          inner.delete(data.user.id);
          copy.set(data.targetUserId, inner);
          return copy;
        });
        return;
      }
    };

    ws.current.onclose = () => {};
    ws.current.onerror = (e) => console.warn("WS error", e);

    return () => ws.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, followingUserId, mode, senderNow?.id, senderNow?.is_playing, senderNow?.progress_ms]);

  // ===== 4) Receiver Follow/Unfollow automatisch melden =====
  useEffect(() => {
    const prev = prevFollowingRef.current;
    if (prev && prev !== followingUserId && me?.id && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(
        JSON.stringify({
          type: "unfollow",
          targetUserId: prev,
          user: { id: me.id, name: me.display_name },
          ts: nowTs(),
        })
      );
    }
    if (followingUserId && me?.id && ws.current?.readyState === WebSocket.OPEN && mode === "receiver") {
      ws.current.send(
        JSON.stringify({
          type: "follow",
          targetUserId: followingUserId,
          user: { id: me.id, name: me.display_name },
          ts: nowTs(),
        })
      );
      // gezielt Snapshot anfordern
      ws.current.send(
        JSON.stringify({
          type: "req_snapshot",
          targetUserId: followingUserId,
          user: { id: me.id, name: me.display_name },
          ts: nowTs(),
        })
      );
    }
    prevFollowingRef.current = followingUserId;
  }, [followingUserId, mode, me?.id]);

  // ===== 5) Sender ticker — nur Events broadcasten (+ Initial‑Snapshot) =====
  useEffect(() => {
    if (mode !== "sender" || !isSharing) {
      if (shareTimer.current) {
        clearInterval(shareTimer.current);
        shareTimer.current = null;
      }
      hasSentInitialRef.current = false;
      return;
    }

    // Presence start
    if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
      ws.current.send(
        JSON.stringify({
          type: "presence",
          action: "start",
          user: { id: me.id, name: me.display_name },
          ts: nowTs(),
        })
      );
    }
    lastPresencePingRef.current = Date.now();
    hasSentInitialRef.current = false;

    const DRIFT_MS = 2000;  // ab ~2s = Seek
    const POLL_MS  = 2000;  // Spotify Poll
    const PING_MS  = 12000; // Präsenz-Ping

    const tick = async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/currently-playing`, {
          credentials: "include",
        });
        const data = await r.json();

        // Heartbeat (Lobby sichtbar halten)
        const now = Date.now();
        if (ws.current?.readyState === WebSocket.OPEN && now - lastPresencePingRef.current > PING_MS && me?.id) {
          ws.current.send(JSON.stringify({
            type: "presence",
            action: "ping",
            user: { id: me.id, name: me.display_name },
            ts: nowTs(),
          }));
          lastPresencePingRef.current = now;
        }

        // Kein Item: Werbung / keine Quelle / private Session
        if (!data?.track?.id) {
          setSenderNow(null);
          setHint(data?.message || "Kein Song/kein Gerät.");
          return;
        }

        const image = data.track?.album?.images?.[0]?.url || null;
        const curr = {
          trackId: data.track.id,
          is_playing: !!data.is_playing,
          progress_ms: data.progress_ms || 0,
          name: data.track.name,
          artists: data.track.artists || [],
          image,
        };

        // UI lokal
        setSenderNow({
          id: curr.trackId,
          name: curr.name,
          artists: curr.artists,
          image: curr.image,
          progress_ms: curr.progress_ms,
          is_playing: curr.is_playing,
        });
        setHint(curr.is_playing ? "" : "Pausiert.");

        // Initialer Snapshot sofort senden
        if (!hasSentInitialRef.current && ws.current?.readyState === WebSocket.OPEN && me?.id) {
          const initialMsg = {
            type: curr.is_playing ? "track" : "pause",
            user: { id: me.id, name: me.display_name },
            trackId: curr.trackId,
            progress_ms: curr.progress_ms,
            name: curr.name,
            artists: curr.artists,
            image: curr.image,
            is_playing: curr.is_playing,
            ts: nowTs(),
          };
          ws.current.send(JSON.stringify(initialMsg));
          lastBroadcastRef.current = {
            trackId: curr.trackId,
            is_playing: curr.is_playing,
            progress_ms: curr.progress_ms,
            sentAt: Date.now(),
          };
          hasSentInitialRef.current = true;
          return;
        }

        // Danach: Nur bei Events broadcasten
        const prev = lastBroadcastRef.current;
        let shouldBroadcast = false;
        let eventType = "track"; // oder "pause"

        if (prev.trackId !== curr.trackId) {
          shouldBroadcast = true; // Trackwechsel
          eventType = curr.is_playing ? "track" : "pause";
        } else if (prev.is_playing !== curr.is_playing) {
          shouldBroadcast = true; // Play/Pause-Wechsel
          eventType = curr.is_playing ? "track" : "pause";
        } else {
          // Seek-Detektion über Drift
          const expected = prev.is_playing
            ? prev.progress_ms + (now - (prev.sentAt || now))
            : prev.progress_ms;
          const drift = Math.abs(curr.progress_ms - expected);
          if (drift > DRIFT_MS) {
            shouldBroadcast = true; // Seek
            eventType = curr.is_playing ? "track" : "pause";
          }
        }

        if (shouldBroadcast && ws.current?.readyState === WebSocket.OPEN && me?.id) {
          const msg = {
            type: eventType,
            user: { id: me.id, name: me.display_name },
            trackId: curr.trackId,
            progress_ms: curr.progress_ms,
            name: curr.name,
            artists: curr.artists,
            image: curr.image,
            is_playing: curr.is_playing,
            ts: nowTs(),
          };
          ws.current.send(JSON.stringify(msg));
          lastBroadcastRef.current = {
            trackId: curr.trackId,
            is_playing: curr.is_playing,
            progress_ms: curr.progress_ms,
            sentAt: Date.now(),
          };
        }
      } catch (e) {
        console.warn("currently-playing fetch error:", e);
        setHint("Konnte aktuell gespielten Song nicht abrufen.");
      }
    };

    tick();
    shareTimer.current = setInterval(tick, POLL_MS);
    return () => {
      clearInterval(shareTimer.current);
      shareTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isSharing, me?.id]);

  // ===== 6) LiveList (inkl. Track-Preview) =====
  const liveList = useMemo(() => {
    const arr = Array.from(liveMap.values());
    const cutoff = Date.now() - 15000;
    return arr
      .filter((x) => (x.lastSeen || x.since || 0) > cutoff)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }, [liveMap]);

  // ===== UI =====
  if (!me) {
    return (
      <div className="layout">
        <Header me={null} onOpenMenu={() => {}} menuOpen={false} />
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
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const myFollowersMap = followers.get(me?.id) || new Map();
  const myFollowersArr = Array.from(myFollowersMap.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const myFollowersCount = myFollowersArr.length;

  return (
    <div className="layout">
      <Header me={me} onOpenMenu={() => setShowMenu((v) => !v)} menuOpen={showMenu} />

      <main className="main">
        {hint && <div className="hint">{hint}</div>}

        {/* Sender view */}
        {mode === "sender" && (
          <div className="grid2">
            <div className="card">
              <div className="liveBadge">LIVE</div>
              <h2>Du teilst gerade Musik</h2>
              {!senderNow && <p>Warte auf laufenden Song…</p>}
              {senderNow && (
                <>
                  <NowPlayingBox
                    title={senderNow.is_playing ? "Gerade beim Sender" : "Pausiert beim Sender"}
                    track={senderNow}
                    live={false}
                    leaderTs={null}
                  />
                  {!senderNow.is_playing && (
                    <div style={{ color: "var(--sub)", marginTop: 8 }}>
                      Du hast pausiert – Hörer bleiben verbunden.
                    </div>
                  )}
                </>
              )}
              <div className="row" style={{ marginTop: 8 }}>
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
                    hasSentInitialRef.current = false;
                  }}
                >
                  Teilen stoppen
                </button>
              </div>
            </div>

            {/* Zuhörer-Card */}
            <div className="card">
              <h3>Deine Zuhörer</h3>
              <p style={{ marginTop: 4, color: "var(--sub)" }}>
                Aktuell hören <b>{myFollowersCount}</b> {myFollowersCount === 1 ? "Person" : "Personen"} mit.
              </p>
              {myFollowersCount > 0 ? (
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {myFollowersArr.slice(0, 6).map((f) => (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div className="avatar">{(f.name || "?").slice(0, 1)}</div>
                      <div style={{ fontWeight: 600 }}>{f.name || f.id}</div>
                    </div>
                  ))}
                  {myFollowersCount > 6 && (
                    <div style={{ color: "var(--sub)", fontSize: 13 }}>
                      +{myFollowersCount - 6} weitere…
                    </div>
                  )}
                </div>
              ) : (
                <div className="card muted" style={{ marginTop: 8 }}>
                  <p>Noch niemand dabei – teile einfach weiter deine Musik.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Receiver view */}
        {mode === "receiver" && (
          <div className="card">
            {!recvNow ? (
              <>
                <h2>Du hörst mit</h2>
                <p>Du hörst gleich bei <b>{senderDisplay}</b> mit! Beim nächsten Song bist du dabei!</p>
              </>
            ) : (
              <>
                <h2>Du und <b>{senderDisplay}</b> hört gerade:</h2>
                <NowPlayingBox
                  title={recvNow.is_playing ? "Gerade beim Empfänger" : "Pausiert beim Empfänger"}
                  track={recvNow}
                  live={true}
                  leaderTs={recvNow._leaderTs}
                />
                {!recvNow.is_playing && (
                  <div style={{ color: "var(--sub)", marginTop: 8 }}>
                    Sender hat pausiert – wir bleiben synchron.
                  </div>
                )}
              </>
            )}
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  if (followingUserId && me?.id && ws.current?.readyState === WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                      type: "unfollow",
                      targetUserId: followingUserId,
                      user: { id: me.id, name: me.display_name },
                      ts: nowTs(),
                    }));
                  }
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

                    {/* Track Preview */}
                    {u.lastTrack ? (
                      <div className="npBody" style={{ marginTop: 8 }}>
                        {u.lastTrack.image && <img className="cover" src={u.lastTrack.image} alt="Album" />}
                        <div className="meta">
                          <div className="title">
                            {u.lastTrack.name} {u.lastTrack.is_playing === false ? " • (Pausiert)" : ""}
                          </div>
                          <div className="artist">{(u.lastTrack.artists || []).join(", ")}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="meta" style={{ marginTop: 8, color: "var(--sub)" }}>
                        Kein Track‑Preview (noch).
                      </div>
                    )}

                    <div className="roomActions">
                      {followingUserId === u.id ? (
                        <>
                          <button className="btn" disabled>Du hörst zu</button>
                          <button
                            className="btn"
                            onClick={() => {
                              if (u.id && me?.id && ws.current?.readyState === WebSocket.OPEN) {
                                ws.current.send(JSON.stringify({
                                  type: "unfollow",
                                  targetUserId: u.id,
                                  user: { id: me.id, name: me.display_name },
                                  ts: nowTs(),
                                }));
                              }
                              setFollowingUserId(null);
                              setMode("idle");
                              setRecvNow(null);
                            }}
                          >
                            Verlassen
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (followingUserId && me?.id && ws.current?.readyState === WebSocket.OPEN) {
                                ws.current.send(JSON.stringify({
                                  type: "unfollow",
                                  targetUserId: followingUserId,
                                  user: { id: me.id, name: me.display_name },
                                  ts: nowTs(),
                                }));
                              }
                              const newId = u.id;
                              setFollowingUserId(newId);
                              setMode("receiver");
                              setHint("");

                              if (me?.id && ws.current?.readyState === WebSocket.OPEN) {
                                // follow
                                ws.current.send(JSON.stringify({
                                  type: "follow",
                                  targetUserId: newId,
                                  user: { id: me.id, name: me.display_name },
                                  ts: nowTs(),
                                }));
                                // gezielt Snapshot anfordern
                                ws.current.send(JSON.stringify({
                                  type: "req_snapshot",
                                  targetUserId: newId,
                                  user: { id: me.id, name: me.display_name },
                                  ts: nowTs(),
                                }));
                              }
                            }}
                          >
                            Mithören
                          </button>
                          <button
                            className="btn"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(buildFollowLink(u.id));
                                setHint("Join-Link kopiert.");
                              } catch {}
                            }}
                          >
                            Link kopieren
                          </button>
                        </>
                      )}
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
                      setHint("Teilen aktiv. Öffne Spotify und spiele (oder pausiere) einen Song.");
                      if (ws.current?.readyState === WebSocket.OPEN && me?.id) {
                        ws.current.send(JSON.stringify({
                          type: "presence",
                          action: "start",
                          user: { id: me.id, name: me.display_name },
                          ts: nowTs(),
                        }));
                      }
                      hasSentInitialRef.current = false;
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
    </div>
  );
}

// ---------- UI Components ----------

function Header({ me, onOpenMenu, menuOpen }) {
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
          <button className="btn ghost" onClick={onOpenMenu}>
            {menuOpen ? "Schließen" : "Optionen"}
          </button>
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

/**
 * NowPlayingBox
 * - Wenn live=true und leaderTs gesetzt & track.is_playing, wird die Zeit
 *   clientseitig alle 500ms hochgezählt (ohne neue Events).
 */
function NowPlayingBox({ title, track, live = false, leaderTs = null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!live || !track?.is_playing) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [live, track?.is_playing, track?.id]);

  // Fortschritt berechnen (Basis + verstrichene Zeit)
  const progress = Math.max(
    0,
    (track?.progress_ms || 0) +
      (live && track?.is_playing && leaderTs ? now - leaderTs : 0)
  );

  return (
    <div className="np">
      <div className="npHead"><h3>{title}</h3></div>
      <div className="npBody">
        {track?.image && <img className="cover" src={track.image} alt="Album" />}
        <div className="meta">
          <div className="title">{track?.name || "Unbekannter Titel"}</div>
          <div className="artist">{(track?.artists || []).join(", ")}</div>
          <div className="time">{msToMMSS(progress)}</div>
        </div>
      </div>
    </div>
  );
}

// ---------- Logos ----------
function LogoMark() {
  return (
    <svg viewBox="0 0 140 140" width="72" height="72" role="img" aria-label="CB Logo">
      <defs>
        <linearGradient id="champ" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#E9DCCB" />
          <stop offset="100%" stopColor="#D9C4A1" />
        </linearGradient>
        <radialGradient id="gloss" cx="30%" cy="20%" r="60%">
          <stop offset="0%" stopColor="rgba(255,255,255,.65)" />
          <stop offset="60%" stopColor="rgba(255,255,255,.15)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <filter id="softShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="6" stdDeviation="6" floodOpacity="0.18" />
        </filter>
      </defs>

      <circle cx="70" cy="70" r="64" fill="url(#champ)" stroke="#FFFFFF" strokeOpacity=".4" strokeWidth="2" filter="url(#softShadow)"/>
      <circle cx="70" cy="70" r="50" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="1.25" />
      <circle cx="70" cy="70" r="64" fill="url(#gloss)" />
      <text className="logoMark" x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" fontSize="54">CB</text>
    </svg>
  );
}
function LogoWord() {
  return (
    <div className="logoLarge">
      <svg viewBox="0 0 480 100" width="360" height="88" aria-hidden>
        <defs>
          <linearGradient id="champ2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#D2B48C" />
            <stop offset="100%" stopColor="#A67C52" />
          </linearGradient>
        </defs>
        <text x="50%" y="68" textAnchor="middle" fontFamily="Inter, ui-sans-serif" fontSize="66" fontWeight="900" fill="url(#champ2)">
          Celebeaty
        </text>
      </svg>
    </div>
  );
}
