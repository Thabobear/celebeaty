import React, { useState, useEffect, useRef } from "react";

const WS_URL = "ws://localhost:8080"; // WebSocket Server
const BACKEND_URL = "http://localhost:3000";

function App() {
  const [role, setRole] = useState(null); // "sender" oder "receiver"
  const [token, setToken] = useState(null); // eigener Spotify Token
  const ws = useRef(null);

  // WebSocket Setup
  useEffect(() => {
    if (!role || !token) return;

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => console.log("WebSocket verbunden");
    ws.current.onclose = () => console.log("WebSocket getrennt");
    ws.current.onerror = (e) => console.error("WebSocket Fehler", e);

    if (role === "receiver") {
      ws.current.onmessage = async (event) => {
        const { trackId, progress_ms } = JSON.parse(event.data);
        console.log("Empfänger bekommt Song", trackId, progress_ms);
        await playTrackAtPosition(trackId, progress_ms, token);
      };
    }

    return () => {
      ws.current?.close();
    };
  }, [role, token]);

  // Sender: alle 5 Sekunden aktuell gespielten Track holen und senden
  useEffect(() => {
    if (role !== "sender" || !token) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(BACKEND_URL + "/currently-playing", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();

        if (data.is_playing && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(
            JSON.stringify({
              trackId: data.track.id,
              progress_ms: data.progress_ms,
            })
          );
          console.log("Sender sendet:", data.track.id, data.progress_ms);
        }
      } catch (e) {
        console.error("Fehler beim Holen des aktuell gespielten Songs:", e);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [role, token]);

  // OAuth Login-Link generieren
  const getLoginUrl = () => {
    const scope = "user-read-playback-state user-read-currently-playing user-modify-playback-state";
    const redirect_uri = BACKEND_URL + "/callback";
    const client_id = "DEIN_CLIENT_ID_HIER"; // im Frontend meist nicht ideal, eher im Backend
    return `https://accounts.spotify.com/authorize?response_type=code&client_id=${client_id}&scope=${encodeURIComponent(
      scope
    )}&redirect_uri=${encodeURIComponent(redirect_uri)}`;
  };

  // Token aus URL-Params holen (nach Login im Backend)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const access_token = params.get("access_token");
    if (access_token) {
      setToken(access_token);
      localStorage.setItem("spotify_token", access_token);
      // URL säubern
      window.history.replaceState({}, document.title, "/");
    } else {
      // Token ggf. aus localStorage laden
      const storedToken = localStorage.getItem("spotify_token");
      if (storedToken) setToken(storedToken);
    }
  }, []);

  async function playTrackAtPosition(trackId, progress_ms, token) {
    try {
      await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          uris: [`spotify:track:${trackId}`],
          position_ms: progress_ms,
        }),
      });
      console.log("Track abgespielt:", trackId, progress_ms);
    } catch (e) {
      console.error("Fehler beim Abspielen:", e);
    }
  }

  if (!role) {
    return (
      <div>
        <h2>Rolle auswählen</h2>
        <button onClick={() => setRole("sender")}>Sender (Teilt Song)</button>
        <button onClick={() => setRole("receiver")}>Empfänger (Spielt ab)</button>
      </div>
    );
  }

  if (!token) {
    return (
      <div>
        <h2>{role === "sender" ? "Sender" : "Empfänger"}: Spotify Login</h2>
        <a href={`${BACKEND_URL}/login`}>Hier klicken, um dich bei Spotify einzuloggen</a>
      </div>
    );
  }

  return (
    <div>
      <h2>Du bist der {role === "sender" ? "Sender" : "Empfänger"}</h2>
      <p>Token vorhanden, Verbindung läuft.</p>
      {role === "sender" && <p>Deine Musik wird geteilt.</p>}
      {role === "receiver" && <p>Warte auf Song von Sender...</p>}
      <button
        onClick={() => {
          setRole(null);
          setToken(null);
          localStorage.removeItem("spotify_token");
          ws.current?.close();
        }}
      >
        Rolle & Token zurücksetzen
      </button>
    </div>
  );
}

export default App;