import React, { useEffect, useRef, useState } from "react";

// === Backend/WS aus Env (Vercel/Vite) ===
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3001";
const WS_URL = BACKEND_URL.replace(/^http/, "ws");

// === Poll/Thresholds ===
const POLL_MS = 1500;
const SEEK_EVENT_MS = 3000;

// Utils
function msToMMSS(ms = 0) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function genRoomId() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

export default function App() {
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [lives, setLives] = useState([]);

  const [role, setRole] = useState(null); // "sender" | "receiver"
  const [isSharing, setIsSharing] = useState(false);

  const [senderNow, setSenderNow] = useState(null);
  const [recvNow, setRecvNow] = useState(null);
  const [hint, setHint] = useState("");
  const [joinInfo, setJoinInfo] = useState("");

  const ws = useRef(null);
  const lastSyncRef = useRef(null);
  const lastSyncTsRef = useRef(0);
  const recvTickerRef = useRef(null);
  const pauseCooldownUntilRef = useRef(0);
  const pausedTargetRef = useRef(null);

  // Token aus URL oder localStorage
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

  // Profil für Lobby
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/whoami`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "ngrok-skip-browser-warning": "true",
          },
        });
        if (r.ok) setMe(await r.json());
      } catch {}
    })();
  }, [token]);

  // WebSocket
  useEffect(() => {
    if (!token) return;
    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("✅ WS verbunden");
      if (me) ws.current.send(JSON.stringify({ type: "identify", user: me }));
      if (roomId) ws.current.send(JSON.stringify({ type: "join", roomId }));
    };
    ws.current.onclose = () => console.log("❌ WS getrennt");
    ws.current.onerror = (e) => console.error("⚠️ WS Fehler", e);

    ws.current.onmessage = async (event) => {
      let data; try { data = JSON.parse(event.data); } catch { return; }

      // Directory
      if (data?.type === "directory" && Array.isArray(data.lives)) {
        setLives(data.lives);
        return;
      }

      // Sender reagiert auf Snapshot-Request (Backend leitet nur weiter)
      if (data?.type === "snapshot_request" && role === "sender" && isSharing) {
        try {
          const r = await fetch(`${BACKEND_URL}/currently-playing`, {
            headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
          });
          const d = await r.json();
          if (d?.track?.id && ws.current?.readyState === WebSocket.OPEN) {
            const now = Date.now();
            ws.current.send(JSON.stringify({
              type: "sync",
              trackId: d.track.id,
              progress_ms: d.progress_ms || 0,
              is_playing: !!d.is_playing,
              name: d.track.name,
              artists: d.track.artists || [],
              image: d.track.album?.images?.[0]?.url || null,
              sentAt: now,
              is_seek: false,
              is_snapshot: true,
            }));
            console.log("📡 Sofort‑Snapshot an Empfänger gesendet");
          }
        } catch {}
        return;
      }

      // Playback-Events nur für Empfänger
      if (role !== "receiver") return;
      const isSync = data?.type === "sync";
      const isLegacy = data?.type === "track";
      if (!isSync && !isLegacy) return;

      const {
        trackId, progress_ms, is_playing = true, name, artists, image, sentAt, is_seek = false,
      } = data;

      lastSyncRef.current = {
        trackId, basePos: progress_ms || 0, sentAt: sentAt || Date.now(), is_playing: !!is_playing,
      };
      lastSyncTsRef.current = Date.now();
      setJoinInfo("");

      const now = Date.now();
      const desiredPos = Math.max(0, (progress_ms || 0) + (now - (sentAt || now)));

      setRecvNow({
        id: trackId,
        name: name || trackId,
        artists: artists || [],
        progress_ms: desiredPos,
        image: image || null,
        is_playing: !!is_playing,
      });

      await applyRemoteEvent(trackId, desiredPos, !!is_playing, is_seek);
    };

    return () => ws.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, me, roomId, role, isSharing]);

  // Empfänger kosmetische Anzeige
  useEffect(() => {
    if (role !== "receiver") return;
    if (recvTickerRef.current) { clearInterval(recvTickerRef.current); recvTickerRef.current = null; }
    recvTickerRef.current = setInterval(() => {
      setRecvNow(prev => (!prev || !prev.is_playing) ? prev : { ...prev, progress_ms: (prev.progress_ms || 0) + 500 });
    }, 500);
    return () => { if (recvTickerRef.current) clearInterval(recvTickerRef.current); recvTickerRef.current = null; };
  }, [role]);

  // Empfänger Watchdog
  useEffect(() => {
    if (role !== "receiver") return;
    const id = setInterval(() => {
      const since = Date.now() - (lastSyncTsRef.current || 0);
      if (since > 25000) {
        ws.current?.send(JSON.stringify({ type: "snapshot_request" }));
        setJoinInfo("🔄 Verbindung schwach – versuche Neu‑Sync…");
        lastSyncTsRef.current = Date.now();
      }
    }, 10000);
    return () => clearInterval(id);
  }, [role]);

  // Sender: Event-only Poll
  useEffect(() => {
    if (role !== "sender" || !token || !isSharing) return;
    let last = null;

    const tick = async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/currently-playing`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        const data = await r.json();

        // Nichts senden wenn kein Track
        if (!data?.track && data?.reason) {
          if (data.reason === "ad") setHint("🎧 Werbung läuft – warte bis ein Song startet.");
          else if (data.reason === "no_active_device") setHint("🚫 Kein aktives Gerät. Öffne Spotify & spiele kurz etwas ab.");
          else if (data.reason === "no_item") setHint("ℹ️ Kein Song‑Item. Prüfe Private Session und spiele einen Song.");
          else setHint("ℹ️ " + (data.message || "Warte auf einen Song…"));
          return;
        }
        if (!data?.track?.id) { setHint(data?.message || "Kein Song / kein aktives Gerät."); return; }

        const image = data.track?.album?.images?.[0]?.url || null;
        const curr = {
          trackId: data.track.id,
          name: data.track.name,
          artists: data.track.artists || [],
          image,
          progress_ms: data.progress_ms || 0,
          is_playing: !!data.is_playing,
        };

        setSenderNow({
          id: curr.trackId, name: curr.name, artists: curr.artists,
          progress_ms: curr.progress_ms, image: curr.image, is_playing: curr.is_playing,
        });
        setHint("");

        const now = Date.now();
        let shouldSend = false, isSeek = false;

        if (!last) {
          shouldSend = true;
        } else {
          const expected = last.basePos + (now - last.baseTs);
          const delta = Math.abs(curr.progress_ms - expected);
          if (curr.trackId !== last.trackId) shouldSend = true;
          else if (curr.is_playing !== last.is_playing) {
            shouldSend = true;
            if (!curr.is_playing) pauseCooldownUntilRef.current = now + 1500;
          } else if (now > pauseCooldownUntilRef.current && delta > SEEK_EVENT_MS) {
            shouldSend = true; isSeek = true;
          }
        }

        if (shouldSend && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            type: "sync", roomId,
            trackId: curr.trackId, progress_ms: curr.progress_ms, is_playing: curr.is_playing,
            name: curr.name, artists: curr.artists, image: curr.image,
            sentAt: now, is_seek: isSeek,
          }));
          console.log("📡 Sync gesendet", curr.trackId, curr.is_playing, curr.progress_ms, isSeek ? "(SEEK)" : "");
          last = { trackId: curr.trackId, is_playing: curr.is_playing, basePos: curr.progress_ms, baseTs: now };
        } else if (!last) {
          last = { trackId: curr.trackId, is_playing: curr.is_playing, basePos: curr.progress_ms, baseTs: now };
        }
      } catch (e) {
        console.error("Sender tick error:", e);
        setHint("Konnte aktuell gespielten Song nicht abrufen.");
      }
    };

    const interval = setInterval(tick, POLL_MS);
    tick();
    return () => clearInterval(interval);
  }, [role, token, isSharing, roomId]);

  // Sender: regelmäßiger Snapshot alle 45s
  useEffect(() => {
    if (role !== "sender" || !token || !isSharing) return;
    let stop = false;
    async function sendSnapshot() {
      try {
        const r = await fetch(`${BACKEND_URL}/currently-playing`, {
          headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
        });
        const d = await r.json();
        if (!d?.track?.id || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        ws.current.send(JSON.stringify({
          type: "sync",
          trackId: d.track.id,
          progress_ms: d.progress_ms || 0,
          is_playing: !!d.is_playing,
          name: d.track.name,
          artists: d.track.artists || [],
          image: d.track.album?.images?.[0]?.url || null,
          sentAt: now,
          is_seek: false,
          is_snapshot: true,
        }));
        console.log("📡 Snapshot‑Sync gesendet");
      } catch {}
    }
    const id = setInterval(() => { if (!stop) sendSnapshot(); }, 45000);
    return () => { stop = true; clearInterval(id); };
  }, [role, token, isSharing]);

  // Empfänger: Event-Reaktion
  async function applyRemoteEvent(trackId, desiredPosMs, remoteIsPlaying, isSeek) {
    if (!token) return;
    try {
      const devRes = await fetch("https://api.spotify.com/v1/me/player/devices", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const devJson = devRes.ok ? await devRes.json() : { devices: [] };
      const devices = devJson.devices || [];
      if (!devices.length) { setHint("Kein Spotify‑Gerät verfügbar. Öffne Spotify am Empfänger."); return; }

      let device = devices.find(d => d.is_active) || devices.find(d => !d.is_restricted) || devices[0];

      if (!device.is_active) {
        await fetch("https://api.spotify.com/v1/me/player", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ device_ids: [device.id], play: remoteIsPlaying }),
        });
        await new Promise(r => setTimeout(r, 250));
      }

      if (!remoteIsPlaying) {
        await fetch("https://api.spotify.com/v1/me/player/pause", { method: "PUT", headers: { Authorization: `Bearer ${token}` } });
        pausedTargetRef.current = { trackId, desiredPosMs };
        setRecvNow(prev => (prev ? { ...prev, is_playing: false } : prev));
        setHint("");
        return;
      }

      if (pausedTargetRef.current) {
        const target = pausedTargetRef.current; pausedTargetRef.current = null;
        await fetch("https://api.spotify.com/v1/me/player/play", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [`spotify:track:${target.trackId}`], position_ms: target.desiredPosMs }),
        });
        setHint("");
        return;
      }

      if (!recvNow || recvNow.id !== trackId) {
        await fetch("https://api.spotify.com/v1/me/player/play", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: [`spotify:track:${trackId}`], position_ms: Math.max(0, desiredPosMs) }),
        });
        setHint("");
        return;
      }

      if (isSeek) {
        await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${Math.max(0, desiredPosMs)}`, {
          method: "PUT", headers: { Authorization: `Bearer ${token}` },
        });
        setRecvNow(prev => (prev ? { ...prev, progress_ms: desiredPosMs } : prev));
        setHint("");
        return;
      }

      setHint("");
    } catch (e) {
      console.error("applyRemoteEvent error:", e);
      setHint("Fehler bei der Synchronisierung. Öffne Spotify am Empfänger.");
    }
  }

  // Debug (Sender)
  async function fetchCurrentOnce() {
    if (!token) return alert("❌ Kein Token – bitte erst einloggen.");
    try {
      const r = await fetch(`${BACKEND_URL}/currently-playing`, {
        headers: { Authorization: `Bearer ${token}`, "ngrok-skip-browser-warning": "true" },
      });
      const data = await r.json();
      if (!r.ok) return alert(`Fehler ${r.status}:\n${JSON.stringify(data).slice(0, 500)}`);
      if (!data.is_playing || !data.track?.id) {
        setHint(data.message || "Kein Song läuft (oder kein aktives Gerät).");
        setSenderNow(null); return;
      }
      const image = data.track?.album?.images?.[0]?.url || null;
      setHint("");
      setSenderNow({
        id: data.track.id, name: data.track.name, artists: data.track.artists || [],
        progress_ms: data.progress_ms || 0, image, is_playing: !!data.is_playing,
      });
      alert(`🎵 Läuft:\n${data.track.name} – ${(data.track.artists || []).join(", ")}`);
    } catch (e) {
      console.error(e); alert("Fetch-Fehler: " + e.message);
    }
  }

  // Receiver tools
  async function getDevices() {
    const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const body = ct.includes("application/json") ? await r.json() : await r.text();
      throw new Error(`Devices-Fehler ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    const j = ct.includes("application/json") ? await r.json() : { devices: [] };
    return j.devices || [];
  }
  async function transferToDevice(deviceId, autoPlay = true) {
    const r = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: autoPlay }),
    });
    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      const body = ct.includes("application/json") ? await r.json() : await r.text();
      throw new Error(`Transfer-Fehler ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
  }
  async function replayReceived() {
    const ls = lastSyncRef.current;
    let trackId, desiredPos;
    if (ls?.trackId) {
      trackId = ls.trackId;
      desiredPos = Math.max(0, (ls.basePos || 0) + (Date.now() - (ls.sentAt || Date.now())));
    } else if (recvNow?.id) {
      trackId = recvNow.id;
      desiredPos = recvNow.progress_ms || 0;
    } else {
      return alert("Noch kein Track empfangen.");
    }
    const r = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`], position_ms: desiredPos }),
    });
    if (!r.ok) {
      const ct = r.headers.get("content-type") || "";
      const body = ct.includes("application/json") ? await r.json() : await r.text();
      alert(`Play-Fehler ${r.status}:\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`);
      return;
    }
    setRecvNow(prev => (prev && prev.id === trackId ? { ...prev, progress_ms: desiredPos, is_playing: true } : prev));
  }

  // LOBBY
  if (!token) {
    return (
      <div style={{ maxWidth: 800, margin: "40px auto", padding: 16 }}>
        <h2>Spotify Login</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a href={`${BACKEND_URL}/login`}><button>➡️ Login mit Spotify</button></a>
          <a href={`${BACKEND_URL}/force-login`}><button>👤 Mit anderem Spotify-Account einloggen</button></a>
        </div>
      </div>
    );
  }

  if (!role) {
    return (
      <div style={{ maxWidth: 900, margin: "40px auto", padding: 16 }}>
        <h2>Willkommen{me ? `, ${me.name}` : ""}</h2>

        <div style={{ marginTop: 16 }}>
          <h3>🔴 Gerade live</h3>
          {lives.length === 0 ? (
            <p>Niemand teilt gerade – starte selbst oder warte auf eine Einladung.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
              {lives.map((live) => (
                <div key={live.roomId} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {live.host?.avatar ? (
                      <img src={live.host.avatar} alt="" style={{ width: 32, height: 32, borderRadius: "50%" }} />
                    ) : (
                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#eee",
                                    display: "flex", alignItems: "center", justifyContent: "center" }}>🎵</div>
                    )}
                    <div>
                      <div style={{ fontWeight: 700 }}>{live.host?.name || "Unbekannt"}</div>
                      <div style={{ fontSize: 12, color: "#666" }}>Raum: {live.roomId}</div>
                    </div>
                  </div>
                  <button
                    style={{ marginTop: 10 }}
                    onClick={() => {
                      setRoomId(live.roomId);
                      setRole("receiver");
                      ws.current?.send(JSON.stringify({ type: "join", roomId: live.roomId }));
                      setHint(`Beigetreten zu Raum ${live.roomId}. Warte auf Ereignisse…`);
                      setJoinInfo("🔔 Beim nächsten Song bist du dabei.");
                      setTimeout(() => {
                        if (!lastSyncRef.current) {
                          setJoinInfo("🔔 Beim nächsten Song bist du dabei. Oder klicke „Jetzt einsteigen“.");
                        }
                      }, 3000);
                    }}
                  >
                    ▶️ Mitspielen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 24, borderTop: "1px solid #eee", paddingTop: 16 }}>
          <h3>Selbst live gehen</h3>
          <button
            onClick={() => {
              const r = genRoomId();
              setRoomId(r);
              setRole("sender");
              setIsSharing(true);
              ws.current?.send(JSON.stringify({ type: "join", roomId: r }));
              ws.current?.send(JSON.stringify({ type: "go_live", roomId: r, host: me || { name: "Unbekannt" } }));
              setHint(`Du bist live in Raum ${r}.`);
            }}
          >
            🎵 Live teilen starten
          </button>
        </div>

        <div style={{ marginTop: 24, borderTop: "1px solid #eee", paddingTop: 16 }}>
          <h3>Oder klassisch Rolle wählen</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button onClick={() => setRole("sender")}>🎵 Sender</button>
            <button onClick={() => setRole("receiver")}>🎧 Empfänger</button>
          </div>
        </div>
      </div>
    );
  }

  // APP UI
  return (
    <div style={{ maxWidth: 820, margin: "40px auto", padding: 16 }}>
      <h2>Du bist der {role === "sender" ? "Sender" : "Empfänger"} {roomId ? `– Raum ${roomId}` : ""}</h2>
      {hint && <p style={{ color: "#a86e00" }}>💡 {hint}</p>}

      {role === "sender" && (
        <div style={{ marginTop: 12 }}>
          <p>{isSharing ? "📤 Live-Teilen aktiv" : "⏸ Noch nicht geteilt"}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => {
                const next = !isSharing;
                setIsSharing(next);
                if (!next && roomId) ws.current?.send(JSON.stringify({ type: "go_offline", roomId }));
              }}
            >
              {isSharing ? "🛑 Stoppen" : "🎵 Song teilen starten"}
            </button>
            <button onClick={fetchCurrentOnce}>🔎 Jetzt laufenden Song anzeigen</button>
          </div>

          {senderNow && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Gerade geteilt (Sender)</div>
              {senderNow.image && (
                <img alt="Album Cover" src={senderNow.image}
                     style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, marginBottom: 8 }} />
              )}
              <div><b>Titel:</b> {senderNow.name}</div>
              <div><b>Artist(s):</b> {(senderNow.artists || []).join(", ")}</div>
              <div><b>Position:</b> {msToMMSS(senderNow.progress_ms)}</div>
              <div><b>Status:</b> {senderNow.is_playing ? "▶️ playing" : "⏸ paused"}</div>
            </div>
          )}
        </div>
      )}

      {role === "receiver" && (
        <div style={{ marginTop: 12 }}>
          <p>📥 Wartet auf Ereignisse (Trackwechsel, Play/Pause, Seek)…</p>

          {joinInfo && (
            <div style={{ margin: "8px 0", padding: "8px 12px", background:"#fffbe6", border:"1px solid #ffe58f", borderRadius:6 }}>
              {joinInfo}
              <div>
                <button
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    ws.current?.send(JSON.stringify({ type: "snapshot_request" }));
                    setJoinInfo("⏳ Einsteige‑Anfrage gesendet…");
                  }}
                >
                  ⚡ Jetzt einsteigen
                </button>
              </div>
            </div>
          )}

          <div style={{ margin: "8px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={async () => {
                try {
                  const devices = await getDevices();
                  if (!devices.length) return alert("Kein Spotify‑Gerät gefunden. Öffne Spotify‑App/Webplayer.");
                  const list = devices.map(d =>
                    `${d.name}  ${d.type}${d.is_active ? " (aktiv)" : ""}${d.is_restricted ? " [restricted]" : ""}`
                  ).join("\n");
                  const pick = prompt(`Geräte (Name / Type):\n${list}\n\nGib den exakten Gerätenamen ein:`);
                  const dev = devices.find(d => d.name === pick) || devices[0];
                  await transferToDevice(dev.id, !!recvNow?.is_playing);
                  alert(`Auf Gerät „${dev.name}“ gewechselt.`);
                  await replayReceived();
                } catch (e) {
                  alert(e.message);
                }
              }}
            >
              🎯 Gerät wählen & hierher wechseln
            </button>
            <button onClick={replayReceived}>▶️ Erneut abspielen</button>
          </div>

          {recvNow && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
              {recvNow.image && (
                <img alt="Album Cover" src={recvNow.image}
                     style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, marginBottom: 8 }} />
              )}
              <div><b>Titel:</b> {recvNow.name}</div>
              <div><b>Artist(s):</b> {(recvNow.artists || []).join(", ")}</div>
              <div><b>Position:</b> {msToMMSS(recvNow.progress_ms)}</div>
              <div><b>Status:</b> {recvNow.is_playing ? "▶️ playing" : "⏸ paused"}</div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            if (role === "sender" && roomId) ws.current?.send(JSON.stringify({ type: "go_offline", roomId }));
            setRole(null); setIsSharing(false); setSenderNow(null); setRecvNow(null);
            setHint(""); setJoinInfo(""); setRoomId(null);
          }}
        >
          🔄 Rolle zurücksetzen
        </button>
        <button
          onClick={() => {
            if (role === "sender" && roomId) ws.current?.send(JSON.stringify({ type: "go_offline", roomId }));
            setRole(null); setIsSharing(false); setSenderNow(null); setRecvNow(null);
            setHint(""); setJoinInfo(""); setRoomId(null);
            setToken(null); localStorage.removeItem("spotify_token");
            ws.current?.close();
          }}
        >
          🚪 Voll abmelden (Token löschen)
        </button>
      </div>
    </div>
  );
}
