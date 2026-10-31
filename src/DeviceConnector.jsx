  import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { AlertTriangle, Camera, Check, LockKeyhole, Mic, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { api } from "./api.js";

export default function DeviceConnector() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [name, setName] = useState("");
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [facing, setFacing] = useState("environment");
  const [phase, setPhase] = useState("setup");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [request, setRequest] = useState(null);
  const [recordingRequest, setRecordingRequest] = useState(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [stream, setStream] = useState(null);
  const [device, setDevice] = useState(null);
  const [connected, setConnected] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [online, setOnline] = useState(navigator.onLine);
  const socketRef = useRef(null);
  const peerRef = useRef(null);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const candidatesRef = useRef([]);
  const mediaPreferencesRef = useRef({ camera, microphone, facing });

  useEffect(() => {
    streamRef.current = stream;
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    mediaPreferencesRef.current = { camera, microphone, facing };
  }, [camera, microphone, facing]);

  useEffect(() => {
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden && streamRef.current?.getTracks().some((track) => track.readyState === "live")) {
        setWarning("This page is in the background. Your browser may pause camera or microphone access; continuous background streaming is not guaranteed.");
      }
    };
    const network = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) setWarning("Internet connection lost. The browser will attempt to reconnect signaling when the network returns.");
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (token) return () => { active = false; };
    api("/device/me").then(({ device: paired }) => {
      if (!active) return;
      setDevice(paired);
      setName(paired.name);
      setCamera(paired.permissions?.camera || false);
      setMicrophone(paired.permissions?.microphone || false);
      mediaPreferencesRef.current = {
        camera: paired.permissions?.camera || false,
        microphone: paired.permissions?.microphone || false,
        facing
      };
      setPhase("waiting");
      connectDeviceSocket();
    }).catch((requestError) => {
      if (active && !requestError.message.startsWith("Sign in through a new pairing QR code")) setError(requestError.message);
    });
    return () => { active = false; };
  }, [token]);

  async function beginPairing(event) {
    event.preventDefault();
    setError(""); setWarning("");
    if (!token || !name.trim()) return setError("This pairing link or device name is invalid.");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return setError("Camera and microphone require a supported browser and HTTPS (localhost is allowed for development).");
    if (!camera && !microphone) return setError("Select at least one media permission.");
    let media;
    try {
      await api("/pairings/validate", { method: "POST", body: JSON.stringify({ token }) });
      media = await navigator.mediaDevices.getUserMedia({ video: camera ? { facingMode: facing } : false, audio: microphone });
      streamRef.current = media;
      setStream(media);
      const { device: paired } = await api("/pairings/consume", {
        method: "POST",
        body: JSON.stringify({ token, name: name.trim(), camera, microphone })
      });
      window.history.replaceState(null, "", "/device/connect");
      setDevice(paired);
      mediaPreferencesRef.current = { camera, microphone, facing };
      setPhase("waiting");
      connectDeviceSocket();
      media.getTracks().forEach((track) => {
        track.onended = () => setWarning(`${track.kind === "video" ? "Camera" : "Microphone"} access stopped. The stream is no longer available.`);
      });
    } catch (requestError) {
      media?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
      setError(requestError.message || "Permission was not granted.");
    }
  }

  function connectDeviceSocket() {
    const socket = io(import.meta.env.VITE_SIGNALING_URL || undefined, {
      auth: { role: "device" },
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      setError((current) => current.startsWith("Secure signaling unavailable:") ? "" : current);
      setPhase((current) => ["active", "connecting"].includes(current) ? current : "waiting");
      if (navigator.getBattery) navigator.getBattery().then((battery) => {
        socket.emit("device:status", {
          batteryLevel: battery.level, charging: battery.charging,
          camera: streamRef.current?.getVideoTracks().some((track) => track.readyState === "live") || false,
          microphone: streamRef.current?.getAudioTracks().some((track) => track.readyState === "live") || false,
          networkOnline: navigator.onLine
        });
      }).catch(() => {});
      else socket.emit("device:status", {
        camera: streamRef.current?.getVideoTracks().some((track) => track.readyState === "live") || false,
        microphone: streamRef.current?.getAudioTracks().some((track) => track.readyState === "live") || false,
        networkOnline: navigator.onLine
      });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (connectError) => setError(`Secure signaling unavailable: ${connectError.message}`));
    socket.on("device:revoked", () => stopMonitoring(true));
    socket.on("session:request", ({ ownerSocketId }) => setRequest({ ownerSocketId }));
    socket.on("session:cancel", () => setRequest(null));
    socket.on("session:end", () => stopMonitoring(false));
    socket.on("recording:request", (incoming) => setRecordingRequest(incoming));
    socket.on("recording:active", () => { setRecordingRequest(null); setRecordingActive(true); });
    socket.on("recording:end", () => setRecordingActive(false));
    socket.on("recording:cancel", () => setRecordingRequest(null));
    socket.on("signal", async ({ from, type, payload }) => {
      try {
        if (type === "offer") {
          const { iceServers } = await api("/config", { headers: { "X-Device-Session": "1" } });
          const peer = new RTCPeerConnection({ iceServers });
          peerRef.current?.close();
          peerRef.current = peer;
          (streamRef.current?.getTracks() || []).forEach((track) => peer.addTrack(track, streamRef.current));
          peer.onicecandidate = (event) => {
            if (event.candidate) socket.emit("signal", { to: from, type: "ice", payload: event.candidate });
          };
          peer.onconnectionstatechange = () => {
            if (peer.connectionState === "connected") {
              setWarning("");
              setPhase("active");
            } else if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
              setWarning("The network interrupted this stream. Keep this page open and approve another session request to reconnect.");
              setPhase(peer.connectionState === "failed" ? "waiting" : "connecting");
            }
          };
          await peer.setRemoteDescription(payload);
          for (const candidate of candidatesRef.current) await peer.addIceCandidate(candidate);
          candidatesRef.current = [];
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("signal", { to: from, type: "answer", payload: peer.localDescription });
          setPhase("connecting");
          setRequest(null);
        } else if (type === "ice") {
          if (peerRef.current?.remoteDescription) await peerRef.current.addIceCandidate(payload);
          else candidatesRef.current.push(payload);
        } else if (type === "stop") stopMonitoring(false);
      } catch (signalError) {
        setError(`Secure media negotiation failed: ${signalError.message}`);
        setPhase("waiting");
      }
    });
  }

  async function approveSession() {
    setError(""); setWarning("");
    try {
      let media = streamRef.current;
      if (!media?.getTracks().some((track) => track.readyState === "live")) {
        const preferences = mediaPreferencesRef.current;
        media = await navigator.mediaDevices.getUserMedia({
          video: preferences.camera ? { facingMode: preferences.facing } : false,
          audio: preferences.microphone
        });
        media.getTracks().forEach((track) => {
          track.onended = () => setWarning(`${track.kind === "video" ? "Camera" : "Microphone"} access stopped.`);
        });
        streamRef.current = media;
        setStream(media);
      }
      socketRef.current?.emit("device:status", {
        camera: media.getVideoTracks().some((track) => track.readyState === "live"),
        microphone: media.getAudioTracks().some((track) => track.readyState === "live"),
        networkOnline: navigator.onLine
      });
      socketRef.current?.emit("session:approved", { ownerSocketId: request.ownerSocketId });
      setPhase("connecting");
      setRequest(null);
    } catch (requestError) {
      setError(`Media permission is required for this session: ${requestError.message}`);
      socketRef.current?.emit("session:denied", { ownerSocketId: request.ownerSocketId });
      setRequest(null);
    }
  }

  function denySession() {
    socketRef.current?.emit("session:denied", { ownerSocketId: request?.ownerSocketId });
    setRequest(null);
  }

  function approveRecording() {
    if (!recordingRequest) return;
    socketRef.current?.emit("recording:approved", {
      ownerSocketId: recordingRequest.ownerSocketId,
      requestId: recordingRequest.requestId
    });
    setRecordingRequest(null);
  }

  function denyRecording() {
    if (!recordingRequest) return;
    socketRef.current?.emit("recording:denied", {
      ownerSocketId: recordingRequest.ownerSocketId,
      requestId: recordingRequest.requestId
    });
    setRecordingRequest(null);
  }

  function stopMonitoring(revoked = false) {
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setRecordingActive(false);
    setRecordingRequest(null);
    setPhase(revoked ? "revoked" : "waiting");
    setRequest(null);
    if (revoked) {
      socketRef.current?.disconnect();
      setError("This device was removed by the account owner.");
    }
  }

  async function switchCamera() {
    const preferences = mediaPreferencesRef.current;
    if (!preferences.camera || !navigator.mediaDevices?.getUserMedia) return;
    const nextFacing = preferences.facing === "environment" ? "user" : "environment";
    let next;
    try {
      next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacing }, audio: preferences.microphone });
      const peer = peerRef.current;
      for (const track of next.getTracks()) {
        const sender = peer?.getSenders().find((item) => item.track?.kind === track.kind);
        if (sender) await sender.replaceTrack(track);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = next;
      setStream(next);
      setFacing(nextFacing);
      mediaPreferencesRef.current = { ...preferences, facing: nextFacing };
    } catch (switchError) {
      next?.getTracks().forEach((track) => track.stop());
      setError(`Could not switch camera: ${switchError.message}`);
    }
  }

  function leave() {
    socketRef.current?.emit("session:end");
    socketRef.current?.disconnect();
    stopMonitoring();
    setPhase("stopped");
  }

  useEffect(() => () => {
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    socketRef.current?.disconnect();
  }, []);

  const mediaActive = phase === "active" && stream?.getTracks().some((track) => track.readyState === "live");
  const hasVideo = stream?.getVideoTracks().some((track) => track.readyState === "live");

  return <main className="device-page">
    <div className="device-brand"><div className="brand-mark"><ShieldCheck size={22} /></div><div><b>SMARTVISION</b><span>SECURE DEVICE CONNECTION</span></div></div>
    <section className="device-connect-card">
      {phase === "setup" && <>
        <div className="device-icon"><Smartphone size={25} /></div><div className="eyebrow">PRIVATE DEVICE PAIRING</div><h1>Connect this device</h1>
        <p>Pair this mobile browser with your SMARTVISION account. Camera and microphone access will only be shared when you approve each monitoring request.</p>
        <form onSubmit={beginPairing}>
          <label>Device name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Front entrance phone" maxLength={60} required /></label>
          <div className="permission-choice">
            <label className="check-row"><input type="checkbox" checked={camera} onChange={(event) => setCamera(event.target.checked)} /><span><Camera size={18} /><b>Camera access</b><small>Choose front or rear camera</small></span></label>
            <label className="check-row"><input type="checkbox" checked={microphone} onChange={(event) => setMicrophone(event.target.checked)} /><span><Mic size={18} /><b>Microphone access</b><small>For consent-based audio</small></span></label>
          </div>
          {camera && <label>Initial camera<select value={facing} onChange={(event) => setFacing(event.target.value)}><option value="environment">Rear camera</option><option value="user">Front camera</option></select></label>}
          <div className="consent-box"><ShieldCheck size={17} /><span>By continuing, you grant the browser permission prompts you accept. The account owner still needs your approval for every live session.</span></div>
          {error && <div className="inline-error">{error}</div>}
          <button className="button primary full" type="submit">Continue and pair securely</button>
        </form>
      </>}
      {phase !== "setup" && phase !== "revoked" && phase !== "stopped" && <>
        <div className="device-icon active"><span className={`connection-dot ${connected ? "online" : ""}`} /><Smartphone size={24} /></div><div className="eyebrow">DEVICE {connected ? "CONNECTED" : "RECONNECTING"}</div><h1>{device?.name || name}</h1>
        <p>{phase === "waiting" ? "This device is paired. Keep this page open; monitoring requests will appear here for your approval." : phase === "connecting" ? "You approved this session. Establishing an encrypted peer-to-peer media connection…" : "Monitoring is active. Your camera and microphone are being shared with the authorized dashboard."}</p>
        {hasVideo && <div className="local-preview"><video ref={videoRef} autoPlay playsInline muted /><div className="preview-label"><span className={`connection-dot ${mediaActive ? "online" : ""}`} />{mediaActive ? "CAMERA SHARING ACTIVE" : "CAMERA PREVIEW"}</div>{phase !== "active" && camera && <button className="button secondary compact flip-camera" onClick={switchCamera}><RefreshCw size={15} /> Flip camera</button>}</div>}
        <div className="device-live-status"><span className={`status-pill ${connected ? "online" : ""}`}><i />{connected ? "Signaling connected" : "Reconnecting…"}</span><span className={`status-pill ${mediaActive ? "online" : ""}`}><i />{mediaActive ? "Media sharing active" : "Media not streaming"}</span><span className={`status-pill ${recordingActive ? "recording-status" : ""}`}><i />{recordingActive ? "Recording in progress" : "Not recording"}</span><span className={`status-pill ${visible ? "" : "warning-status"}`}><i />{visible ? "Page visible" : "Page backgrounded"}</span><span className={`status-pill ${online ? "online" : ""}`}><i />{online ? "Internet available" : "Offline"}</span></div>
        {request && <div className="session-consent"><div className="consent-box"><ShieldCheck size={18} /><span>The account owner is requesting access to the selected camera and microphone. Approve only if you recognize this request.</span></div><div className="consent-actions"><button className="button secondary" onClick={denySession}>Decline</button><button className="button primary" onClick={approveSession}><Check size={16} /> Approve this session</button></div></div>}
        {recordingRequest && <div className="session-consent recording-consent"><div className="consent-box"><AlertTriangle size={18} /><span>The dashboard owner is requesting permission to record {recordingRequest.type} from this device. A recording indicator will stay visible while recording.</span></div><div className="consent-actions"><button className="button secondary" onClick={denyRecording}>Decline recording</button><button className="button primary" onClick={approveRecording}><Check size={16} /> Allow recording</button></div></div>}
        {warning && <div className="warning-box"><AlertTriangle size={16} /><span>{warning}</span></div>}{error && <div className="inline-error">{error}</div>}
        <button className="button stop-button full" onClick={leave}><X size={17} /> Stop monitoring and disconnect</button>
      </>}
      {(phase === "revoked" || phase === "stopped") && <><div className="device-icon"><AlertTriangle size={23} /></div><h1>{phase === "revoked" ? "Access revoked" : "Disconnected"}</h1><p>{phase === "revoked" ? "This device is no longer authorized. Ask the account owner to generate a new pairing QR code." : "Monitoring has stopped and this browser has disconnected."}</p>{error && <div className="inline-error">{error}</div>}</>}
    </section>
    <footer className="device-footer"><LockKeyhole size={14} /> Your browser controls all camera and microphone permissions.</footer>
  </main>;
}
