import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  Activity, Bell, Camera, Film, Headphones, LayoutDashboard, LogOut, Menu, QrCode,
  Settings, ShieldCheck, Smartphone, Video, HardDrive, X, LockKeyhole, UserRound
} from "lucide-react";
import { api } from "./api.js";
import { listRecordings, saveRecording } from "./recordings.js";
import { AudioPage, DevicesPage, LivePage, OverviewPage, PairingPage, RecordingsPage, SettingsPage, StoragePage, NotificationsPage } from "./views.jsx";
import DeviceConnector from "./DeviceConnector.jsx";

const navigation = [
  ["overview", "Overview", LayoutDashboard], ["live", "Live cameras", Video],
  ["devices", "Connected devices", Smartphone], ["pairing", "QR pairing", QrCode],
  ["recordings", "Recordings", Film], ["audio", "Audio monitoring", Headphones],
  ["storage", "Storage management", HardDrive], ["notifications", "Notifications", Bell],
  ["settings", "Settings", Settings], ["profile", "User profile", UserRound]
];

export default function App() {
  return window.location.pathname === "/device/connect" ? <DeviceConnector /> : <OwnerApp />;
}

function OwnerApp() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState("");
  const [page, setPage] = useState("overview");
  const [devices, setDevices] = useState([]);
  const [sessions, setSessions] = useState({});
  const [pending, setPending] = useState({});
  const [socketConnected, setSocketConnected] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [recordings, setRecordings] = useState([]);
  const [recordingByDevice, setRecordingByDevice] = useState({});
  const [recordingPending, setRecordingPending] = useState({});
  const [layout, setLayout] = useState(4);
  const [recordingQuality, setRecordingQuality] = useState(() => localStorage.getItem("smartvision-recording-quality") === "high" ? "high" : "standard");
  const [menuOpen, setMenuOpen] = useState(false);
  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const socketDevicesRef = useRef(new Map());
  const candidatesRef = useRef(new Map());
  const recordersRef = useRef(new Map());
  const qualityTimersRef = useRef(new Map());
  const pendingTimersRef = useRef(new Map());
  const recordingRequestsRef = useRef(new Map());
  const recordingTimersRef = useRef(new Map());
  const devicesRef = useRef([]);
  const recordingQualityRef = useRef(recordingQuality);
  const sessionsRef = useRef({});

  useEffect(() => {
    api("/auth/me")
      .then(({ user: current }) => setUser(current))
      .catch((requestError) => {
        setUser(null);
        if (requestError.message !== "Sign in to continue.") setAuthError(`Dashboard service unavailable: ${requestError.message}`);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const { devices: list } = await api("/devices");
      setDevices(list);
      list.forEach((device) => {
        if (device.socketId) socketDevicesRef.current.set(device.socketId, device.id);
      });
    } catch (requestError) { setError(requestError.message); }
  }, []);

  const refreshRecordings = useCallback(async () => {
    try { setRecordings(await listRecordings()); }
    catch (requestError) { setError(`Could not read local recordings: ${requestError.message}`); }
  }, []);

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { recordingQualityRef.current = recordingQuality; }, [recordingQuality]);

  const closeSession = useCallback((deviceId, state = "ended") => {
    clearInterval(qualityTimersRef.current.get(deviceId));
    qualityTimersRef.current.delete(deviceId);
    clearTimeout(pendingTimersRef.current.get(deviceId));
    pendingTimersRef.current.delete(deviceId);
    clearTimeout(recordingTimersRef.current.get(deviceId));
    recordingTimersRef.current.delete(deviceId);
    recordingRequestsRef.current.delete(deviceId);
    setRecordingPending((items) => ({ ...items, [deviceId]: false }));
    const peer = peersRef.current.get(deviceId);
    if (peer && peer.connectionState !== "closed") peer.close();
    peersRef.current.delete(deviceId);
    candidatesRef.current.delete(deviceId);
    setSessions((current) => ({ ...current, [deviceId]: { state, stream: null, peer: null } }));
    const recorder = recordersRef.current.get(deviceId);
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const socket = io(import.meta.env.VITE_SIGNALING_URL || undefined, {
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setSocketConnected(true);
      setError((current) => current.startsWith("Secure signaling unavailable:") ? "" : current);
      refreshDevices();
    });
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("connect_error", (e) => setError(`Secure signaling unavailable: ${e.message}`));
    socket.on("device:status", ({ deviceId, online, socketId }) => {
      if (online && socketId) socketDevicesRef.current.set(socketId, deviceId);
      setDevices((items) => items.map((item) => item.id === deviceId ? { ...item, online, socketId: online ? socketId : null } : item));
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        const name = devicesRef.current.find((item) => item.id === deviceId)?.name || "Paired device";
        try { new Notification(`${name} ${online ? "connected" : "disconnected"}`); }
        catch (notificationError) { setError(`Could not show browser notification: ${notificationError.message}`); }
      }
      if (!online) {
        for (const [id, mapped] of socketDevicesRef.current) if (mapped === deviceId) socketDevicesRef.current.delete(id);
        closeSession(deviceId, "offline");
        setPending((items) => ({ ...items, [deviceId]: false }));
      }
    });
    socket.on("device:metadata", ({ deviceId, batteryLevel, charging, camera, microphone }) => {
      setDevices((items) => items.map((item) => item.id === deviceId ? {
        ...item,
        battery: batteryLevel === undefined ? item.battery : { level: batteryLevel, charging },
        permissions: { camera, microphone }
      } : item));
    });
    socket.on("session:approved", async ({ deviceId, deviceSocketId }) => {
      setPending((items) => ({ ...items, [deviceId]: false }));
      clearTimeout(pendingTimersRef.current.get(deviceId));
      pendingTimersRef.current.delete(deviceId);
      if (deviceSocketId) socketDevicesRef.current.set(deviceSocketId, deviceId);
      try {
        const { iceServers } = await api("/config");
        const peer = new RTCPeerConnection({ iceServers });
        peersRef.current.get(deviceId)?.close();
        peersRef.current.set(deviceId, peer);
        candidatesRef.current.set(deviceId, []);
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addTransceiver("audio", { direction: "recvonly" });
        peer.onicecandidate = (event) => {
          if (event.candidate) socket.emit("signal", { to: deviceSocketId, type: "ice", payload: event.candidate });
        };
        peer.ontrack = (event) => setSessions((items) => ({
          ...items, [deviceId]: { state: peer.connectionState === "connected" ? "connected" : "connecting", stream: event.streams[0], peer }
        }));
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === "connected") {
            setSessions((items) => ({ ...items, [deviceId]: { ...items[deviceId], state: "connected", peer } }));
            if (!qualityTimersRef.current.has(deviceId)) {
              const timer = setInterval(async () => {
                try {
                  const stats = await peer.getStats();
                  const pair = [...stats.values()].find((item) =>
                    item.type === "candidate-pair" && item.state === "succeeded" && (item.selected || item.nominated)
                  );
                  if (pair?.currentRoundTripTime !== undefined) {
                    const rtt = pair.currentRoundTripTime * 1000;
                    const quality = rtt < 100 ? "Good" : rtt < 250 ? "Fair" : "Weak";
                    setSessions((items) => ({ ...items, [deviceId]: { ...items[deviceId], quality: `${quality} · ${Math.round(rtt)} ms` } }));
                  }
                } catch (statsError) {
                  clearInterval(timer);
                  qualityTimersRef.current.delete(deviceId);
                  setError(`Could not read WebRTC connection quality: ${statsError.message}`);
                }
              }, 5000);
              qualityTimersRef.current.set(deviceId, timer);
            }
          } else if (["failed", "disconnected"].includes(peer.connectionState)) {
            clearInterval(qualityTimersRef.current.get(deviceId));
            qualityTimersRef.current.delete(deviceId);
            setSessions((items) => ({ ...items, [deviceId]: { ...items[deviceId], state: peer.connectionState } }));
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("signal", { to: deviceSocketId, type: "offer", payload: peer.localDescription });
        setSessions((items) => ({ ...items, [deviceId]: { state: "connecting", stream: null, peer } }));
      } catch (e) { setError(`Could not start camera session: ${e.message}`); }
    });
    socket.on("session:denied", ({ deviceId }) => {
      setPending((items) => ({ ...items, [deviceId]: false }));
      clearTimeout(pendingTimersRef.current.get(deviceId));
      pendingTimersRef.current.delete(deviceId);
      setToast("The device owner declined this monitoring request.");
    });
    socket.on("recording:approved", ({ deviceId, requestId, type }) => {
      if (recordingRequestsRef.current.get(deviceId) !== requestId) return;
      clearTimeout(recordingTimersRef.current.get(deviceId));
      recordingTimersRef.current.delete(deviceId);
      recordingRequestsRef.current.delete(deviceId);
      setRecordingPending((items) => ({ ...items, [deviceId]: false }));
      startRecording(deviceId, type);
    });
    socket.on("recording:denied", ({ deviceId, requestId }) => {
      if (recordingRequestsRef.current.get(deviceId) !== requestId) return;
      clearTimeout(recordingTimersRef.current.get(deviceId));
      recordingTimersRef.current.delete(deviceId);
      recordingRequestsRef.current.delete(deviceId);
      setRecordingPending((items) => ({ ...items, [deviceId]: false }));
      setToast("The device owner declined recording.");
    });
    socket.on("signal", async ({ from, type, payload }) => {
      const deviceId = socketDevicesRef.current.get(from);
      const peer = deviceId ? peersRef.current.get(deviceId) : null;
      if (!peer || peer.connectionState === "closed") return;
      try {
        if (type === "answer" && !peer.remoteDescription) {
          await peer.setRemoteDescription(payload);
          for (const candidate of candidatesRef.current.get(deviceId) || []) await peer.addIceCandidate(candidate);
          candidatesRef.current.set(deviceId, []);
        } else if (type === "ice") {
          if (!peer.remoteDescription) candidatesRef.current.get(deviceId)?.push(payload);
          else await peer.addIceCandidate(payload);
        } else if (type === "stop") closeSession(deviceId);
      } catch (e) { setError(`WebRTC signaling error: ${e.message}`); }
    });
    refreshDevices();
    refreshRecordings();
    return () => {
      socket.disconnect();
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      qualityTimersRef.current.forEach(clearInterval);
      qualityTimersRef.current.clear();
      pendingTimersRef.current.forEach(clearTimeout);
      pendingTimersRef.current.clear();
      recordingTimersRef.current.forEach(clearTimeout);
      recordingTimersRef.current.clear();
      recordersRef.current.forEach((recorder) => { if (recorder.state === "recording") recorder.stop(); });
    };
  }, [user, refreshDevices, refreshRecordings, closeSession]);

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await api(`/auth/${authMode}`, { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
      setUser(result.user);
    } catch (e) { setAuthError(e.message); }
  }

  function requestSession(device) {
    if (!device.online || !socketRef.current?.connected) return setError("This device is offline and cannot receive a monitoring request.");
    setPending((items) => ({ ...items, [device.id]: true }));
    socketRef.current.emit("session:request", { deviceId: device.id });
    clearTimeout(pendingTimersRef.current.get(device.id));
    pendingTimersRef.current.set(device.id, setTimeout(() => {
      setPending((items) => ({ ...items, [device.id]: false }));
      socketRef.current?.emit("session:cancel", { deviceId: device.id });
      setToast(`No response from ${device.name}. The request expired.`);
    }, 30_000));
  }

  function endSession(deviceId) {
    socketRef.current?.emit("session:end", { deviceId });
    closeSession(deviceId);
  }

  function startRecording(deviceId, type) {
    const stream = sessionsRef.current[deviceId]?.stream;
    if (!stream || !window.MediaRecorder) return setError("A connected media stream and MediaRecorder support are required.");
    const source = new MediaStream(type === "audio" ? stream.getAudioTracks() : stream.getVideoTracks());
    if (!source.getTracks().length) return setError(type === "audio" ? "This session has no audio track." : "This session has no video track.");
    try {
      const options = type === "audio"
        ? ["audio/webm;codecs=opus", "audio/webm"]
        : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      const mimeType = options.find((typeName) => MediaRecorder.isTypeSupported(typeName));
      const recorderOptions = type === "video"
        ? { videoBitsPerSecond: recordingQualityRef.current === "high" ? 4_000_000 : 1_500_000, ...(mimeType ? { mimeType } : {}) }
        : (mimeType ? { mimeType } : undefined);
      const recorder = recorderOptions ? new MediaRecorder(source, recorderOptions) : new MediaRecorder(source);
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = (event) => setError(`Recording failed: ${event.error?.message || "media recorder error"}`);
      recorder.onstop = async () => {
        socketRef.current?.emit("recording:end", { deviceId });
        setRecordingByDevice((current) => {
          const next = { ...current };
          delete next[deviceId];
          return next;
        });
        try {
          const item = await saveRecording(new Blob(chunks, { type: mimeType || "video/webm" }), {
            deviceId, deviceName: devicesRef.current.find((device) => device.id === deviceId)?.name || "Device", type
          });
          setRecordings((items) => [item, ...items]);
          setToast("Recording saved to this browser’s private storage.");
        } catch (e) { setError(`Recording could not be saved: ${e.message}`); }
      };
      recordersRef.current.set(deviceId, recorder);
      recorder.start(1000);
      setRecordingByDevice((currentByDevice) => ({ ...currentByDevice, [deviceId]: type }));
      setToast(`${type === "audio" ? "Audio" : "Video"} recording started with device-owner consent.`);
    } catch (e) {
      socketRef.current?.emit("recording:end", { deviceId });
      setError(`Recording could not start: ${e.message}`);
    }
  }

  function toggleRecording(deviceId, type) {
    const current = recordersRef.current.get(deviceId);
    if (current?.state === "recording") {
      socketRef.current?.emit("recording:end", { deviceId });
      current.stop();
      return;
    }
    if (recordingRequestsRef.current.has(deviceId)) return;
    const session = sessionsRef.current[deviceId];
    const track = type === "audio"
      ? session?.stream?.getAudioTracks().some((item) => item.readyState === "live")
      : session?.stream?.getVideoTracks().some((item) => item.readyState === "live");
    if (!track || !window.MediaRecorder) return setError("A connected media stream and MediaRecorder support are required.");
    const requestId = crypto.randomUUID();
    recordingRequestsRef.current.set(deviceId, requestId);
    setRecordingPending((items) => ({ ...items, [deviceId]: true }));
    socketRef.current?.emit("recording:request", { deviceId, requestId, type });
    recordingTimersRef.current.set(deviceId, setTimeout(() => {
      recordingRequestsRef.current.delete(deviceId);
      setRecordingPending((items) => ({ ...items, [deviceId]: false }));
      socketRef.current?.emit("recording:cancel", { deviceId, requestId });
      setToast("Recording consent request expired.");
    }, 30_000));
  }

  async function logout() {
    try { await api("/auth/logout", { method: "POST" }); }
    catch (requestError) { setError(`Sign-out request failed: ${requestError.message}`); }
    socketRef.current?.disconnect();
    setUser(null); setDevices([]); setSessions({});
  }

  const activeSessions = useMemo(() => Object.entries(sessions).filter(([, session]) => ["connected", "connecting"].includes(session.state)), [sessions]);
  if (authLoading) return <div className="loading-screen"><div className="spinner" /><span>Securely connecting…</span></div>;
  if (!user) return <AuthPage mode={authMode} setMode={setAuthMode} error={authError} onSubmit={submitAuth} />;
  let view;
  const common = { devices, sessions, pending, requestSession, endSession, toggleRecording, recordingByDevice, recordingPending, layout, setLayout };
  if (page === "overview") view = <OverviewPage {...common} activeSessions={activeSessions} recordings={recordings} setPage={setPage} />;
  else if (page === "live") view = <LivePage {...common} />;
  else if (page === "devices") view = <DevicesPage {...common} refresh={refreshDevices} />;
  else if (page === "pairing") view = <PairingPage />;
  else if (page === "recordings") view = <RecordingsPage recordings={recordings} setRecordings={setRecordings} />;
  else if (page === "audio") view = <AudioPage {...common} />;
  else if (page === "storage") view = <StoragePage recordings={recordings} />;
  else if (page === "notifications") view = <NotificationsPage />;
  else view = <SettingsPage user={user} logout={logout} onError={setError} onSuccess={setToast} recordingQuality={recordingQuality} setRecordingQuality={(quality) => {
    setRecordingQuality(quality);
    localStorage.setItem("smartvision-recording-quality", quality);
  }} devices={devices} />;

  const currentPage = navigation.find(([id]) => id === page);
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><ShieldCheck size={22} /></div><div><b>SMARTVISION</b><span>SECURITY CONSOLE</span></div><button className="icon-button sidebar-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <div className="nav-caption">MONITORING</div>
      <nav>{navigation.map(([id, label, Icon]) => <button key={id} data-nav={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => { setPage(id); setMenuOpen(false); }}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{id === "live" && activeSessions.length > 0 && <span className="nav-count">{activeSessions.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection-card"><span className={`connection-dot ${socketConnected ? "online" : ""}`} /><div><b>{socketConnected ? "Signaling connected" : "Connecting…"}</b><small>Secure connection</small></div><LockKeyhole size={14} /></div><button className="profile-button" onClick={() => setPage("settings")}><div className="avatar">{user.email.slice(0, 1).toUpperCase()}</div><div className="profile-text"><b>{user.email}</b><small>Account owner</small></div></button></div>
    </aside>
    {menuOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><button className="icon-button menu-button" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button><div><span className="breadcrumb">SMARTVISION <span>/</span> {currentPage?.[1].toUpperCase()}</span><h1>{currentPage?.[1]}</h1></div><div className="topbar-actions"><div className="secure-pill"><span className={`connection-dot ${socketConnected ? "online" : ""}`} />{socketConnected ? "System online" : "Reconnecting"}</div><span className="topbar-time">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><button className="icon-button" title="Sign out" onClick={logout}><LogOut size={18} /></button></div></header>
      {error && <div className="alert error-alert"><Activity size={17} /><span>{error}</span><button className="icon-button" onClick={() => setError("")}><X size={16} /></button></div>}
      <div className="content">{view}</div>
    </main>
    {toast && <div className="toast"><span>✓</span>{toast}<button className="icon-button" onClick={() => setToast("")}><X size={15} /></button></div>}
  </div>;
}

function AuthPage({ mode, setMode, error, onSubmit }) {
  return <main className="auth-page"><div className="auth-brand"><div className="brand-mark"><ShieldCheck size={23} /></div><div><b>SMARTVISION</b><span>CCTV MONITORING</span></div></div><section className="auth-card"><div className="eyebrow">PRIVATE BY DESIGN</div><h1>{mode === "login" ? "Welcome back" : "Create your account"}</h1><p>Sign in to securely monitor your paired devices.</p><form onSubmit={onSubmit}><label>Email address<input name="email" type="email" autoComplete="email" required maxLength="254" /></label><label>Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength="12" maxLength="128" required /></label>{mode === "register" && <small>Use at least 12 characters for a stronger password.</small>}{error && <div className="inline-error">{error}</div>}<button className="button primary full">{mode === "login" ? "Sign in securely" : "Create secure account"}</button></form><button className="text-button auth-switch" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "New to SMARTVISION? Create an account" : "Already have an account? Sign in"}</button><div className="auth-security"><LockKeyhole size={15} /> Encrypted session · Camera access always requires consent</div></section></main>;
}
