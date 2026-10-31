import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  AlertTriangle, ArrowDownToLine, Battery, Bell, Camera, CircleHelp, Cloud, Film,
  HardDrive, Headphones, LockKeyhole, Mic, Monitor, Pencil, Plus, QrCode, RefreshCw,
  ShieldCheck, Smartphone, Trash2, Volume2, Wifi, X
} from "lucide-react";
import { api } from "./api.js";
import { deleteRecording } from "./recordings.js";

const bytes = (value) => {
  if (!value) return "0 B";
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${["B", "KB", "MB", "GB"][index]}`;
};

function Intro({ eyebrow, title, action }) {
  return <div className="page-intro"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>{action}</div>;
}

function Empty({ icon: Icon, title, text, action }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={23} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function Privacy({ icon: Icon = ShieldCheck, children }) {
  return <div className="privacy-note"><Icon size={17} /><span>{children}</span></div>;
}

function Stat({ label, value, note, icon: Icon, accent }) {
  return <article className="stat-card"><div className={`stat-icon ${accent || ""}`}><Icon size={19} /></div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></article>;
}

function LayoutPicker({ value, onChange }) {
  return <div className="layout-picker" aria-label="Camera layout">{[1, 4, 9, 16].map((n) => <button key={n} className={value === n ? "selected" : ""} onClick={() => onChange(n)} title={`${n} camera layout`}>{n}</button>)}</div>;
}

function CameraGrid({ sessions, devices, limit, endSession, toggleRecording, recordingByDevice, recordingPending }) {
  return <div className={`camera-grid grid-${limit}`}>{sessions.slice(0, limit).map(([id, session]) => <CameraTile key={id} device={devices.find((item) => item.id === id)} session={session} onEnd={() => endSession(id)} onRecord={(type) => toggleRecording(id, type)} recordingType={recordingByDevice?.[id]} recordingPending={recordingPending?.[id]} />)}</div>;
}

function CameraTile({ device, session, onEnd, onRecord, recordingType, recordingPending }) {
  const videoRef = useRef(null);
  useEffect(() => { if (videoRef.current && session.stream) videoRef.current.srcObject = session.stream; }, [session.stream]);
  const video = session.stream?.getVideoTracks().find((track) => track.readyState === "live");
  const audio = session.stream?.getAudioTracks().some((track) => track.readyState === "live");
  const dimensions = video?.getSettings?.();
  return <article className="camera-tile"><div className="camera-video">
    {video ? <video ref={videoRef} autoPlay playsInline muted /> : session.state === "connecting" ? <div className="camera-placeholder"><span className="spinner" /><span>Negotiating secure stream…</span></div> : <div className="camera-placeholder"><Mic size={26} /><span>Audio-only session</span></div>}
    <div className="camera-overlay-top"><span className={`live-badge ${session.state === "connected" ? "is-live" : ""}`}><span />{session.state === "connected" ? "LIVE" : session.state.toUpperCase()}</span>{audio && <span className="audio-live"><Mic size={13} /> AUDIO</span>}</div>
    {video && <button className="fullscreen-button icon-button" title="Full screen" onClick={() => videoRef.current?.requestFullscreen?.()}><Monitor size={15} /></button>}
  </div><div className="camera-footer"><div className="camera-title"><b>{device?.name || "Device"}</b><small>{device?.browser || "Mobile browser"} · {video ? `${dimensions?.width || "—"} × ${dimensions?.height || "—"}` : "No video track"} · {session.quality || "Measuring connection"}</small></div><div className="camera-controls">{video && <button className={`icon-button ${recordingType === "video" ? "recording-control" : ""}`} disabled={recordingPending || (recordingType && recordingType !== "video")} title={recordingPending ? "Waiting for owner consent" : recordingType === "video" ? "Stop video recording" : "Request video recording consent"} onClick={() => onRecord("video")}>{recordingType === "video" ? <span className="recording-square" /> : <Film size={16} />}</button>}{audio && <button className={`icon-button ${recordingType === "audio" ? "recording-control" : ""}`} disabled={recordingPending || (recordingType && recordingType !== "audio")} title={recordingPending ? "Waiting for owner consent" : recordingType === "audio" ? "Stop audio recording" : "Request audio recording consent"} onClick={() => onRecord("audio")}>{recordingType === "audio" ? <span className="recording-square" /> : <Mic size={16} />}</button>}<button className="icon-button danger-hover" title="End session" onClick={onEnd}><X size={17} /></button></div></div></article>;
}

function DeviceTable({ devices, requestSession, sessions, pending }) {
  return <div className="table-scroll"><table className="device-table"><thead><tr><th>DEVICE</th><th>STATUS</th><th>PERMISSIONS</th><th>LAST SEEN</th><th /></tr></thead><tbody>{devices.map((device) => <tr key={device.id}><td><div className="table-device"><span className="device-symbol small"><Smartphone size={17} /></span><span><b>{device.name}</b><small>{device.browser}</small></span></div></td><td><span className={`status-pill ${device.online ? "online" : ""}`}><i />{device.online ? "Online" : "Offline"}</span></td><td><span className="permission-icons" title="Authorized capabilities"><Camera size={14} className={device.permissions?.camera ? "allowed" : ""} /><Mic size={14} className={device.permissions?.microphone ? "allowed" : ""} /></span></td><td>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "—"}</td><td>{["connected", "connecting"].includes(sessions[device.id]?.state) ? <span className="session-active"><span />{sessions[device.id].state === "connected" ? "Active" : "Connecting"}</span> : <button className="button table-action" disabled={!device.online || pending[device.id]} onClick={() => requestSession(device)}>{pending[device.id] ? "Pending…" : "Request"}</button>}</td></tr>)}</tbody></table></div>;
}

export function OverviewPage({ devices, sessions, activeSessions, recordings, layout, setLayout, requestSession, endSession, toggleRecording, recordingByDevice, recordingPending, pending, setPage }) {
  const online = devices.filter((device) => device.online).length;
  const liveVideo = activeSessions.filter(([, session]) => session.stream?.getVideoTracks().some((track) => track.readyState === "live")).length;
  const liveAudio = activeSessions.filter(([, session]) => session.stream?.getAudioTracks().some((track) => track.readyState === "live")).length;
  return <>
    <div className="welcome-row"><div><div className="eyebrow">SECURITY AT A GLANCE</div><h2>Your monitoring overview</h2><p>Live status from your authorized browser devices.</p></div><button className="button primary" onClick={() => setPage("pairing")}><Plus size={17} /> Add device</button></div>
    <div className="stat-grid"><Stat label="Registered devices" value={devices.length} icon={Smartphone} note="Authorized browsers" /><Stat label="Online now" value={online} icon={Wifi} note={`${devices.length - online} offline`} accent="green" /><Stat label="Active camera sessions" value={liveVideo} icon={Camera} note="Owner-approved streams" /><Stat label="Active microphones" value={liveAudio} icon={Mic} note="Consent required" /><Stat label="Saved recordings" value={recordings.length} icon={Film} note={bytes(recordings.reduce((sum, item) => sum + item.size, 0))} /></div>
    <section className="section-card"><div className="section-heading"><div><h3>Live camera wall</h3><p>Streams appear only while a device owner approves monitoring.</p></div><div className="section-tools"><LayoutPicker value={layout} onChange={setLayout} /><button className="text-button" onClick={() => setPage("live")}>View all <span>→</span></button></div></div>
      {activeSessions.length ? <CameraGrid sessions={activeSessions} devices={devices} limit={layout} endSession={endSession} toggleRecording={toggleRecording} recordingByDevice={recordingByDevice} recordingPending={recordingPending} /> : <Empty icon={Camera} title="No active camera streams" text={devices.length ? "Request a session from an online device. Its owner must approve before any media is shared." : "Pair a mobile browser to start building your private camera wall."} action={<button className="button secondary" onClick={() => setPage(devices.length ? "devices" : "pairing")}>{devices.length ? "View devices" : "Pair a device"} <span>→</span></button>} />}
    </section>
    <section className="section-card"><div className="section-heading"><div><h3>Connected devices</h3><p>Current browser connection status</p></div><button className="text-button" onClick={() => setPage("devices")}>Manage devices <span>→</span></button></div>{devices.length ? <DeviceTable devices={devices.slice(0, 5)} requestSession={requestSession} sessions={sessions} pending={pending} /> : <div className="compact-empty"><Smartphone size={19} /><span>No devices paired yet.</span><button className="text-button" onClick={() => setPage("pairing")}>Pair your first device</button></div>}</section>
  </>;
}

export function LivePage(props) {
  const { devices, sessions, pending, requestSession, endSession, toggleRecording, recordingByDevice, recordingPending, layout, setLayout } = props;
  const entries = Object.entries(sessions).filter(([, value]) => ["connected", "connecting"].includes(value.state));
  return <><Intro eyebrow="REAL-TIME MONITORING" title="Live cameras" action={<LayoutPicker value={layout} onChange={setLayout} />} /><Privacy>Every live stream requires a fresh approval on the mobile device. Browser and operating-system background restrictions may interrupt streams.</Privacy>{entries.length ? <CameraGrid sessions={entries} devices={devices} limit={layout} endSession={endSession} toggleRecording={toggleRecording} recordingByDevice={recordingByDevice} recordingPending={recordingPending} /> : <section className="section-card"><Empty icon={Camera} title="No cameras streaming" text="Online devices can receive a request. Video will appear only after the device owner approves it." action={<button className="button secondary" onClick={() => document.querySelector('[data-nav="devices"]')?.click()}>Connect an online device</button>} /></section>}<section className="section-card"><div className="section-heading"><div><h3>Available devices</h3><p>Tap request to ask the owner to share media.</p></div></div>{devices.length ? <DeviceTable devices={devices} requestSession={requestSession} sessions={sessions} pending={pending} /> : <div className="compact-empty">No paired devices. Use QR pairing to add one.</div>}</section></>;
}

export function DevicesPage({ devices, refresh, requestSession, endSession, sessions, pending }) {
  async function rename(device) {
    const name = window.prompt("Enter a new device name", device.name);
    if (name === null) return;
    try { await api(`/devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name }) }); await refresh(); }
    catch (error) { window.alert(error.message); }
  }
  async function remove(device) {
    if (!window.confirm(`Remove "${device.name}"? This will revoke its access immediately.`)) return;
    try { await api(`/devices/${device.id}`, { method: "DELETE" }); endSession(device.id); await refresh(); }
    catch (error) { window.alert(error.message); }
  }
  return <><Intro eyebrow="AUTHORIZED BROWSERS" title="Connected devices" action={<button className="button secondary" onClick={refresh}><RefreshCw size={16} /> Refresh</button>} /><Privacy icon={LockKeyhole}>Only browsers paired using your account’s single-use QR code can connect. Removing a device revokes its session cookie.</Privacy><section className="section-card">  {devices.length ? <div className="device-list">{devices.map((device) => <div className="device-card" key={device.id}><div className="device-symbol"><Smartphone size={22} /></div><div className="device-details"><div className="device-name-row"><b>{device.name}</b><span className={`status-pill ${device.online ? "online" : ""}`}><i />{device.online ? "Online" : "Offline"}</span></div><span>{device.browser} · {device.deviceType}</span><small>ID: {device.id}</small><div className="device-permissions"><span><Camera size={13} /> Camera {device.permissions?.camera ? "allowed" : "not allowed"}</span><span><Mic size={13} /> Microphone {device.permissions?.microphone ? "allowed" : "not allowed"}</span>{device.battery?.level !== undefined && <span><Battery size={13} /> {Math.round(device.battery.level * 100)}%{device.battery.charging ? " · charging" : ""}</span>}</div><small>{device.lastSeenAt ? `Last connected ${new Date(device.lastSeenAt).toLocaleString()}` : "Never connected"}</small></div><div className="device-actions">{["connected", "connecting"].includes(sessions[device.id]?.state) ? <button className="button secondary compact" onClick={() => endSession(device.id)}>End session</button> : <button className="button primary compact" disabled={!device.online || pending[device.id]} onClick={() => requestSession(device)}>{pending[device.id] ? "Waiting for approval…" : "Request session"}</button>}<button className="icon-button" title="Rename device" onClick={() => rename(device)}><Pencil size={16} /></button><button className="icon-button danger-hover" title="Remove device" onClick={() => remove(device)}><Trash2 size={16} /></button></div></div>)}</div> : <Empty icon={Smartphone} title="No paired devices" text="Pair any phone or tablet using its browser. No app installation is required." action={<button className="button primary" onClick={() => document.querySelector('[data-nav="pairing"]')?.click()}>Create pairing QR</button>} />}</section></>;
}

export function PairingPage() {
  const [pairing, setPairing] = useState(null);
  const [qrData, setQrData] = useState("");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!pairing) return undefined;
    const update = () => setRemaining(Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  useEffect(() => { if (pairing && remaining === 0) setPairing(null); }, [pairing, remaining]);
  async function create() {
    setError("");
    try {
      const session = await api("/pairings", { method: "POST", body: "{}" });
      setRemaining(Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)));
      setPairing(session);
    }
    catch (e) { setError(e.message); }
  }
  const url = pairing ? `${window.location.origin}/device/connect?token=${encodeURIComponent(pairing.token)}` : "";
  useEffect(() => {
    let active = true;
    if (!url) { setQrData(""); return undefined; }
    QRCode.toDataURL(url, { width: 208, margin: 1, errorCorrectionLevel: "M" })
      .then((data) => { if (active) setQrData(data); })
      .catch((error) => { if (active) setError(`Could not create QR code: ${error.message}`); });
    return () => { active = false; };
  }, [url]);
  return <><Intro eyebrow="SECURE DEVICE ENROLLMENT" title="Pair a mobile browser" /><div className="pairing-layout"><section className="section-card pairing-card"><div className="pairing-step"><span>01</span><div><b>Generate a one-time QR code</b><small>It expires after 5 minutes and cannot be reused.</small></div></div>{pairing ? <div className="qr-box">{qrData ? <img src={qrData} alt="One-time SMARTVISION device pairing QR code" /> : <span className="spinner" />}<span>Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span></div> : <div className="qr-placeholder"><QrCode size={38} /><span>Your secure QR code will appear here</span></div>}<button className="button primary full" onClick={create}><Plus size={17} />{pairing ? "Generate a new QR code" : "Generate pairing QR"}</button><div className="qr-url"><LockKeyhole size={14} /><span>Share only with the device owner. This token authorizes enrollment, not automatic camera access.</span></div>{error && <div className="inline-error">{error}</div>}</section><section className="section-card pairing-instructions"><div className="eyebrow">HOW PAIRING WORKS</div><h3>Simple. Private. Consent-first.</h3>{[["Scan the code", "Open your phone camera and scan the QR code. No app download required."], ["Name your device", "Choose a recognizable name on the phone that will share its camera."], ["Grant browser access", "The device owner explicitly grants camera and/or microphone permission."], ["Approve each session", "Every monitoring request must be accepted on the mobile device before streaming starts."]].map(([title, text], i) => <div className="instruction-step" key={title}><span>{i + 1}</span><div><b>{title}</b><small>{text}</small></div></div>)}<div className="warning-box"><AlertTriangle size={16} /><span>Mobile browsers can suspend media when backgrounded or locked. Continuous screen-off monitoring is not guaranteed.</span></div></section></div></>;
}

export function RecordingsPage({ recordings, setRecordings }) {
  const [playing, setPlaying] = useState(null);
  const [estimate, setEstimate] = useState(null);
  useEffect(() => { if (navigator.storage?.estimate) navigator.storage.estimate().then(setEstimate).catch(() => {}); }, []);
  async function remove(item) {
    if (!window.confirm("Delete this recording from this browser?")) return;
    try { await deleteRecording(item.id); setRecordings((items) => items.filter((recording) => recording.id !== item.id)); if (playing?.id === item.id) setPlaying(null); }
    catch (e) { window.alert(`Could not delete recording: ${e.message}`); }
  }
  function download(item) {
    const url = URL.createObjectURL(item.blob);
    const link = document.createElement("a");
    link.href = url; link.download = `smartvision-${item.deviceName.replace(/[^a-z0-9-_]/gi, "-")}-${item.createdAt.slice(0, 10)}.webm`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <><Intro eyebrow="LOCAL MEDIA LIBRARY" title="Recordings" /><Privacy icon={LockKeyhole}>Recordings are stored only in this browser’s IndexedDB. They are not uploaded or synchronized to a server. Clearing browser data may erase them.</Privacy>{playing && <section className="section-card playback-card"><div className="section-heading"><div><h3>{playing.deviceName} · {playing.type} playback</h3><p>{new Date(playing.createdAt).toLocaleString()}</p></div><button className="icon-button" onClick={() => setPlaying(null)}><X size={18} /></button></div><MediaPlayer item={playing} /></section>}<section className="section-card"><div className="section-heading"><div><h3>Recording history</h3><p>{recordings.length} recording{recordings.length === 1 ? "" : "s"} stored on this device</p></div>{estimate && <span className="storage-label">{bytes(estimate.usage || 0)} browser storage used</span>}</div>{recordings.length ? <div className="recording-list">{recordings.map((item) => <div className="recording-row" key={item.id}><div className="recording-icon">{item.type === "audio" ? <Headphones size={19} /> : <Film size={19} />}</div><div className="recording-meta"><b>{item.deviceName} <span className="recording-type">{item.type}</span></b><small>{new Date(item.createdAt).toLocaleString()} · {bytes(item.size)}</small></div><div className="recording-actions"><button className="button secondary compact" onClick={() => setPlaying(item)}>Play</button><button className="icon-button" title="Download" onClick={() => download(item)}><ArrowDownToLine size={17} /></button><button className="icon-button danger-hover" title="Delete" onClick={() => remove(item)}><Trash2 size={16} /></button></div></div>)}</div> : <Empty icon={Film} title="No recordings saved" text="Start a camera or audio session, then choose record. The recording will be saved locally in this browser." />}</section></>;
}

function MediaPlayer({ item }) {
  const src = useMemo(() => URL.createObjectURL(item.blob), [item]);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  return item.type === "audio" ? <audio controls src={src} className="audio-player" /> : <video controls src={src} className="recording-player" />;
}

function AudioSession({ device, session, onEnd, onRecord, recording, recordingType, recordingPending }) {
  const ref = useRef(null);
  const [volume, setVolume] = useState(.8);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState("");
  useEffect(() => { if (ref.current) ref.current.srcObject = session.stream; }, [session.stream]);
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);
  async function toggleAudio() {
    if (!playing) {
      try { await ref.current?.play(); setPlaying(true); setMuted(false); setAudioError(""); }
      catch (error) { setAudioError(`Audio playback was blocked: ${error.message}`); }
      return;
    }
    setMuted(!muted);
  }
  return <div className="audio-session"><audio ref={ref} muted={muted} onPlaying={() => setPlaying(true)} onPause={() => setPlaying(false)} /><div className="audio-pulse"><Volume2 size={20} /></div><div className="audio-session-title"><b>{device?.name || "Device"}</b><small>{audioError || (playing ? "Secure WebRTC audio · Playing" : "Secure WebRTC audio · Press play to listen")}</small></div><div className="volume-control"><Volume2 size={15} /><input type="range" min="0" max="1" step=".05" value={volume} aria-label="Volume" onChange={(e) => setVolume(Number(e.target.value))} /></div><button className="icon-button" title={!playing ? "Start audio playback" : muted ? "Unmute playback" : "Mute playback"} onClick={toggleAudio}>{!playing || muted ? <Volume2 size={17} /> : <Mic size={17} />}</button><button className={`icon-button ${recording ? "recording-control" : ""}`} disabled={recordingPending || (recordingType && recordingType !== "audio")} title={recordingPending ? "Waiting for device consent" : recording ? "Stop audio recording" : "Request audio recording consent"} onClick={onRecord}>{recording ? <span className="recording-square" /> : <Film size={17} />}</button><button className="icon-button danger-hover" title="End session" onClick={onEnd}><X size={17} /></button></div>;
}

export function AudioPage(props) {
  const { devices, sessions, pending, requestSession, endSession, toggleRecording, recordingByDevice, recordingPending } = props;
  const active = Object.entries(sessions).filter(([, session]) => session.state === "connected" && session.stream?.getAudioTracks().some((track) => track.readyState === "live"));
  return <><Intro eyebrow="CONSENT-BASED MONITORING" title="Audio monitoring" /><Privacy icon={Mic}>Microphones are never activated silently. A device owner must approve each session, and an active microphone indicator remains visible on their phone.</Privacy><section className="section-card"><div className="section-heading"><div><h3>Live audio sources</h3><p>{active.length} active microphone{active.length === 1 ? "" : "s"}</p></div></div>{active.length ? <div className="audio-sessions">{active.map(([id, session]) => <AudioSession key={id} device={devices.find((item) => item.id === id)} session={session} onEnd={() => endSession(id)} onRecord={() => toggleRecording(id, "audio")} recording={recordingByDevice?.[id] === "audio"} recordingType={recordingByDevice?.[id]} recordingPending={recordingPending?.[id]} />)}</div> : <Empty icon={Headphones} title="No active microphone streams" text="Request a session from an online device. Audio starts only after its owner approves." />}</section><section className="section-card"><div className="section-heading"><div><h3>Available microphones</h3><p>Request an owner-approved session</p></div></div>{devices.length ? <DeviceTable devices={devices} requestSession={requestSession} sessions={sessions} pending={pending} /> : <div className="compact-empty">No paired devices.</div>}</section></>;
}

export function StoragePage({ recordings }) {
  const [estimate, setEstimate] = useState(null);
  useEffect(() => { if (navigator.storage?.estimate) navigator.storage.estimate().then(setEstimate).catch(() => {}); }, []);
  const used = recordings.reduce((sum, item) => sum + item.size, 0);
  const percent = estimate?.quota ? Math.min(used / estimate.quota * 100, 100) : 0;
  return <><Intro eyebrow="LOCAL BROWSER STORAGE" title="Storage management" /><Privacy icon={HardDrive}>Media is kept in this browser only. Use browser storage controls carefully—clearing site data also deletes recordings.</Privacy><section className="section-card storage-card"><div className="storage-summary"><div className="storage-icon"><HardDrive size={22} /></div><div><span>SMARTVISION RECORDINGS</span><h3>{bytes(used)}</h3><small>{recordings.length} local file{recordings.length === 1 ? "" : "s"}</small></div></div><progress className="storage-progress" max="100" value={percent} aria-label="Recording storage quota used" /><div className="storage-legend"><span>Recordings in this browser</span><b>{estimate?.quota ? `${bytes(estimate.quota)} available browser quota` : "Browser quota information unavailable"}</b></div></section><div className="two-column"><InfoCard icon={ShieldCheck} title="Private by default" text="Recordings never leave this browser unless you explicitly download and share them." /><InfoCard icon={AlertTriangle} title="Storage can be cleared" text="Browser cleanup, private browsing, or device reset may permanently remove local recordings. Download files you need to keep." /></div></>;
}

function InfoCard({ icon: Icon, title, text }) {
  return <section className="section-card info-card"><div className="setting-icon"><Icon size={18} /></div><div><h3>{title}</h3><p>{text}</p></div></section>;
}

export function NotificationsPage() {
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  async function enable() { if ("Notification" in window) setPermission(await Notification.requestPermission()); }
  return <><Intro eyebrow="BROWSER ALERTS" title="Notifications" /><section className="section-card settings-card"><div className="setting-row"><div className="setting-icon"><Bell size={18} /></div><div className="setting-copy"><b>Browser notifications</b><small>Show alerts when devices connect or disconnect while the dashboard is in the background.</small></div><button className="button secondary compact" onClick={enable} disabled={permission === "granted" || permission === "unsupported"}>{permission === "granted" ? "Enabled" : permission === "denied" ? "Blocked in browser" : permission === "unsupported" ? "Not supported" : "Enable"}</button></div><div className="setting-row"><div className="setting-icon"><Wifi size={18} /></div><div className="setting-copy"><b>Device status updates</b><small>Device and session status update in real time while this dashboard is open.</small></div><span className="setting-value">Live</span></div></section><Privacy icon={CircleHelp}>Browser notifications may require HTTPS and permission in your browser settings.</Privacy></>;
}

function ChangePassword({ onError, onSuccess }) {
  const [open, setOpen] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.newPassword !== values.confirmPassword) return onError("New passwords do not match.");
    try { await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) }); onSuccess("Password updated."); setOpen(false); }
    catch (error) { onError(error.message); }
  }
  return <div className="password-setting"><button className="button secondary compact" onClick={() => setOpen(!open)}>{open ? "Cancel" : "Change"}</button>{open && <form className="password-form" onSubmit={submit}><input name="currentPassword" type="password" placeholder="Current password" required /><input name="newPassword" type="password" placeholder="New password (12+ characters)" minLength="12" required /><input name="confirmPassword" type="password" placeholder="Confirm new password" minLength="12" required /><button className="button primary compact">Update</button></form>}</div>;
}

export function SettingsPage({ user, logout, onError, onSuccess, recordingQuality, setRecordingQuality, devices }) {
  return <><Intro eyebrow="ACCOUNT & SECURITY" title="Settings" /><section className="section-card settings-card"><div className="section-title"><h3>Account profile</h3><p>Signed in account and security controls</p></div><div className="setting-row"><div className="avatar large">{user.email.slice(0, 1).toUpperCase()}</div><div className="setting-copy"><b>{user.email}</b><small>SMARTVISION account owner</small></div></div><div className="setting-row"><div className="setting-icon"><LockKeyhole size={18} /></div><div className="setting-copy"><b>Change password</b><small>Change your account password with current credentials.</small></div><ChangePassword onError={onError} onSuccess={onSuccess} /></div><div className="setting-row"><div className="setting-icon"><Camera size={18} /></div><div className="setting-copy"><b>Device permissions</b><small>{devices.filter((device) => device.permissions?.camera).length} camera and {devices.filter((device) => device.permissions?.microphone).length} microphone grants. Revoke permissions in each device browser’s site settings.</small></div><span className="setting-value">Browser managed</span></div><div className="setting-row"><div className="setting-icon"><Film size={18} /></div><div className="setting-copy"><b>Recording quality</b><small>Applies to new video recordings. Higher quality uses more local storage.</small></div><select className="settings-select" aria-label="Recording quality" value={recordingQuality} onChange={(event) => setRecordingQuality(event.target.value)}><option value="standard">Standard</option><option value="high">High</option></select></div><div className="setting-row"><div className="setting-icon"><ShieldCheck size={18} /></div><div className="setting-copy"><b>Secure session</b><small>Authenticated with an HTTP-only, same-site session cookie.</small></div><span className="setting-value">Protected</span></div><div className="setting-row"><div className="setting-icon"><Cloud size={18} /></div><div className="setting-copy"><b>Recording storage</b><small>Recordings stay in the local browser; no cloud upload configured.</small></div><span className="setting-value">Local only</span></div><div className="setting-row"><div className="setting-icon"><LockKeyhole size={18} /></div><div className="setting-copy"><b>Sign out</b><small>End this dashboard session.</small></div><button className="button secondary compact" onClick={logout}>Sign out</button></div></section><Privacy icon={AlertTriangle}>Camera access is limited by the device browser. A locked screen or suspended browser can interrupt streaming.</Privacy></>;
}
