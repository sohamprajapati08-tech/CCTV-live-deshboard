import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import http from "node:http";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { Device, Pairing, User } from "./models.js";
import {
  createIceServers, digestToken, generatePairingSecret, identifyBrowser,
  isValidDeviceName
} from "./security.js";

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173";
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || (isProduction ? "none" : "strict");
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

let configuredOrigin;
try { configuredOrigin = new URL(APP_ORIGIN); }
catch { throw new Error("APP_ORIGIN must be a valid origin URL."); }
if (configuredOrigin.origin !== APP_ORIGIN) {
  throw new Error("APP_ORIGIN must contain only the scheme, host, and optional port (no path or trailing slash).");
}
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a random value at least 32 characters long.");
}
if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI must be configured before starting SMARTVISION CCTV.");
}
if (isProduction && !APP_ORIGIN.startsWith("https://")) {
  throw new Error("APP_ORIGIN must use HTTPS in production.");
}
if (!["strict", "lax", "none"].includes(COOKIE_SAME_SITE)) {
  throw new Error("COOKIE_SAME_SITE must be strict, lax, or none.");
}
if (COOKIE_SAME_SITE === "none" && !isProduction) {
  throw new Error("SameSite=None cookies require NODE_ENV=production and HTTPS.");
}

await mongoose.connect(process.env.MONGODB_URI);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: APP_ORIGIN, credentials: true },
  maxHttpBufferSize: 1e6
});
const activeDeviceSockets = new Map();
const activeOwnerSockets = new Map();
const activeRecordingRequests = new Map();
const activeSessionRequests = new Map();

app.set("trust proxy", isProduction ? 1 : false);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      connectSrc: ["'self'", APP_ORIGIN.replace(/^http/, "ws")],
      mediaSrc: ["'self'", "blob:"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use((req, _res, next) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) req.body = {};
  next();
});
app.use(cookieParser());
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && origin !== APP_ORIGIN) return res.status(403).json({ error: "Origin not allowed." });
  res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Session");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const pairingLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: COOKIE_SAME_SITE,
  path: "/",
  ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {})
};
const signOwner = (userId) => jwt.sign({ sub: userId, type: "owner" }, JWT_SECRET, { expiresIn: "12h" });
const signDevice = (deviceId, ownerId) =>
  jwt.sign({ sub: deviceId, ownerId, type: "device" }, JWT_SECRET, { expiresIn: "30d" });

function readAuth(req) {
  const token = req.cookies.smartvision_session;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.type === "owner" ? payload : null;
  } catch {
    return null;
  }
}

async function readDevice(req) {
  const token = req.cookies.smartvision_device;
  if (!token) return null;
  let auth;
  try {
    auth = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (auth.type !== "device") return null;
  return Device.findOne({ _id: auth.sub, ownerId: auth.ownerId });
}

function authenticateOwner(req, res, next) {
  const auth = readAuth(req);
  if (!auth) return res.status(401).json({ error: "Sign in to continue." });
  req.ownerId = auth.sub;
  next();
}

function requireOwner(req, res, next) {
  authenticateOwner(req, res, next);
}

app.use("/api/auth", authLimit);
app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 12–128 characters." });
    }
    if (await User.exists({ email })) return res.status(409).json({ error: "An account already uses that email." });
    const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 12) });
    res.cookie("smartvision_session", signOwner(user.id), { ...cookieOptions, maxAge: 12 * 60 * 60 * 1000 });
    res.status(201).json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "An account already uses that email." });
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.passwordHash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    res.cookie("smartvision_session", signOwner(user.id), { ...cookieOptions, maxAge: 12 * 60 * 60 * 1000 });
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("smartvision_session", cookieOptions);
  res.sendStatus(204);
});

app.post("/api/auth/password", authenticateOwner, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128) {
      return res.status(400).json({ error: "New password must be 12–128 characters." });
    }
    const user = await User.findById(req.ownerId);
    if (!user || !(await bcrypt.compare(String(currentPassword || ""), user.passwordHash))) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    res.cookie("smartvision_session", signOwner(user.id), { ...cookieOptions, maxAge: 12 * 60 * 60 * 1000 });
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", authenticateOwner, async (req, res, next) => {
  try {
    const user = await User.findById(req.ownerId).select("email");
    if (!user) return res.status(401).json({ error: "Account not found." });
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/device/me", async (req, res, next) => {
  try {
    const device = await readDevice(req);
    if (!device) return res.status(401).json({ error: "Sign in through a new pairing QR code to authorize this browser." });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      device: {
        id: device.id,
        name: device.name,
        permissions: device.permissions
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/pairings", requireOwner, pairingLimit, async (req, res, next) => {
  try {
    const { token, tokenHash } = generatePairingSecret();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await Pairing.updateMany(
      { ownerId: req.ownerId, expiresAt: { $gt: new Date() }, consumedAt: { $exists: false } },
      { $set: { consumedAt: new Date() } }
    );
    await Pairing.create({ ownerId: req.ownerId, tokenHash, expiresAt });
    res.status(201).json({ token, expiresAt });
  } catch (error) {
    next(error);
  }
});

app.post("/api/pairings/validate", pairingLimit, async (req, res, next) => {
  try {
    const token = req.body.token;
    if (typeof token !== "string" || token.length < 32) {
      return res.status(400).json({ error: "Pairing link is invalid." });
    }
    const pairing = await Pairing.exists({
      tokenHash: digestToken(token),
      expiresAt: { $gt: new Date() },
      consumedAt: { $exists: false }
    });
    if (!pairing) return res.status(410).json({ error: "This pairing code expired or has already been used." });
    res.json({ valid: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/pairings/consume", pairingLimit, async (req, res, next) => {
  try {
    const { token, name, camera, microphone } = req.body;
    if (typeof token !== "string" || token.length < 32 || !isValidDeviceName(name)) {
      return res.status(400).json({ error: "Pairing link or device name is invalid." });
    }
    if (camera !== true && microphone !== true) {
      return res.status(400).json({ error: "Approve at least camera or microphone access on this device." });
    }
    const pairing = await Pairing.findOneAndUpdate(
      { tokenHash: digestToken(token), expiresAt: { $gt: new Date() }, consumedAt: { $exists: false } },
      { $set: { consumedAt: new Date() } },
      { new: true }
    );
    if (!pairing) return res.status(410).json({ error: "This pairing code expired or has already been used." });
    const device = await Device.create({
      ownerId: pairing.ownerId,
      name: name.trim(),
      browser: identifyBrowser(req.get("user-agent")),
      permissions: { camera, microphone }
    });
    res.cookie("smartvision_device", signDevice(device.id, String(pairing.ownerId)), {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.status(201).json({ device: { id: device.id, name: device.name } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/devices", requireOwner, async (req, res, next) => {
  try {
    const devices = await Device.find({ ownerId: req.ownerId }).sort({ createdAt: -1 }).lean();
    res.json({
      devices: devices.map(({ _id, name, deviceType, browser, permissions, battery, lastSeenAt, connectedAt }) => ({
        id: String(_id), name, deviceType, browser, permissions, battery,
        online: activeDeviceSockets.has(String(_id)),
        lastSeenAt, connectedAt,
        socketId: activeDeviceSockets.get(String(_id))?.socketId || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/devices/:id", requireOwner, async (req, res, next) => {
  try {
    if (!isValidDeviceName(req.body.name)) return res.status(400).json({ error: "Device name must be 1–60 characters." });
    const device = await Device.findOneAndUpdate(
      { _id: req.params.id, ownerId: req.ownerId },
      { $set: { name: req.body.name.trim() } },
      { new: true, runValidators: true }
    );
    if (!device) return res.status(404).json({ error: "Device not found." });
    res.json({ device: { id: device.id, name: device.name } });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/devices/:id", requireOwner, async (req, res, next) => {
  try {
    const device = await Device.findOneAndDelete({ _id: req.params.id, ownerId: req.ownerId });
    if (!device) return res.status(404).json({ error: "Device not found." });
    const active = activeDeviceSockets.get(String(device.id));
    if (active) {
      active.socket.emit("device:revoked");
      active.socket.disconnect(true);
      activeDeviceSockets.delete(String(device.id));
    }
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

app.get("/api/config", async (req, res, next) => {
  try {
    let ownerId;
    if (req.get("X-Device-Session") === "1") {
      const device = await readDevice(req);
      if (!device) return res.status(401).json({ error: "Device is not authorized." });
      ownerId = String(device.ownerId);
    } else {
      const ownerAuth = readAuth(req);
      if (!ownerAuth) return res.status(401).json({ error: "Sign in to continue." });
      ownerId = String(ownerAuth.sub);
    }
    const iceServers = createIceServers({
      stunUrl: process.env.STUN_URL,
      turnUrl: process.env.TURN_URL,
      turnSecret: process.env.TURN_SECRET,
      ownerId
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ iceServers });
  } catch (error) {
    next(error);
  }
});

io.use((socket, next) => {
  if (socket.handshake.headers.origin !== APP_ORIGIN) {
    return next(new Error("Origin not allowed."));
  }
  let cookies;
  try {
    cookies = Object.fromEntries(
      (socket.handshake.headers.cookie || "").split(";").filter(Boolean).map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
      })
    );
  } catch {
    return next(new Error("Invalid session cookie."));
  }
  const role = socket.handshake.auth?.role === "device" ? "device" : "owner";
  const token = cookies[role === "device" ? "smartvision_device" : "smartvision_session"];
  try {
    const auth = jwt.verify(token || "", JWT_SECRET);
    if (auth.type !== role) return next(new Error("Authentication required."));
    socket.data.auth = auth;
    next();
  } catch {
    next(new Error("Authentication required."));
  }
});

io.on("connection", async (socket) => {
  const auth = socket.data.auth;
  if (auth.type === "owner") {
    socket.data.role = "owner";
    socket.data.ownerId = String(auth.sub);
    socket.join(`owner:${auth.sub}`);
    const ownerSockets = activeOwnerSockets.get(String(auth.sub)) || new Set();
    ownerSockets.add(socket.id);
    activeOwnerSockets.set(String(auth.sub), ownerSockets);
    socket.on("signal", (message) => relaySignal(socket, message));
    socket.on("disconnect", () => {
      const ownerSockets = activeOwnerSockets.get(String(auth.sub));
      ownerSockets?.delete(socket.id);
      for (const [deviceId, request] of activeRecordingRequests) {
        if (request.ownerSocketId === socket.id) {
          activeDeviceSockets.get(deviceId)?.socket.emit("recording:cancel");
          activeRecordingRequests.delete(deviceId);
        }
      }
      for (const [deviceId, request] of activeSessionRequests) {
        if (request.ownerSocketId === socket.id) {
          activeDeviceSockets.get(deviceId)?.socket.emit("session:cancel");
          activeSessionRequests.delete(deviceId);
        }
      }
      if (ownerSockets?.size === 0) {
        activeOwnerSockets.delete(String(auth.sub));
        for (const active of activeDeviceSockets.values()) {
          if (active.ownerId === String(auth.sub)) active.socket.emit("session:end");
        }
      }
    });
    socket.on("session:request", ({ deviceId } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      if (target?.ownerId === String(auth.sub)) {
        activeSessionRequests.set(String(deviceId), { ownerSocketId: socket.id, requestedAt: Date.now() });
        target.socket.emit("session:request", { ownerSocketId: socket.id });
      }
    });
    socket.on("session:cancel", ({ deviceId } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      const request = activeSessionRequests.get(String(deviceId));
      if (target?.ownerId === String(auth.sub) && request?.ownerSocketId === socket.id) {
        activeSessionRequests.delete(String(deviceId));
        target.socket.emit("session:cancel");
      }
    });
    socket.on("recording:request", ({ deviceId, requestId, type } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      if (!target || target.ownerId !== String(auth.sub) || !["audio", "video"].includes(type) ||
        typeof requestId !== "string" || requestId.length > 80) return;
      activeRecordingRequests.set(String(deviceId), {
        requestId, ownerSocketId: socket.id, type, requestedAt: Date.now()
      });
      target.socket.emit("recording:request", { ownerSocketId: socket.id, requestId, type });
    });
    socket.on("recording:cancel", ({ deviceId, requestId } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      const request = activeRecordingRequests.get(String(deviceId));
      if (target?.ownerId === String(auth.sub) && request?.ownerSocketId === socket.id && request.requestId === requestId) {
        activeRecordingRequests.delete(String(deviceId));
        target.socket.emit("recording:cancel");
      }
    });
    socket.on("session:end", ({ deviceId } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      if (target?.ownerId === String(auth.sub)) {
        activeRecordingRequests.delete(String(deviceId));
        activeSessionRequests.delete(String(deviceId));
        target.socket.emit("session:end");
      }
    });
    socket.on("recording:end", ({ deviceId } = {}) => {
      const target = activeDeviceSockets.get(String(deviceId));
      if (target?.ownerId === String(auth.sub)) target.socket.emit("recording:end");
    });
    return;
  }

  const device = await Device.findOne({ _id: auth.sub, ownerId: auth.ownerId });
  if (!device) return socket.disconnect(true);
  socket.data.role = "device";
  socket.data.deviceId = String(device.id);
  socket.data.ownerId = String(device.ownerId);
  socket.join(`owner:${device.ownerId}`);
  const previous = activeDeviceSockets.get(String(device.id));
  if (previous) previous.socket.disconnect(true);
  activeDeviceSockets.set(String(device.id), { socket, ownerId: String(device.ownerId), socketId: socket.id });
  device.connectedAt = new Date();
  device.lastSeenAt = device.connectedAt;
  await device.save();
  io.to(`owner:${device.ownerId}`).emit("device:status", {
    deviceId: String(device.id), online: true, socketId: socket.id
  });
  socket.on("device:status", async (status = {}) => {
    const update = {};
    if (Number.isFinite(status.batteryLevel) && status.batteryLevel >= 0 && status.batteryLevel <= 1) {
      update["battery.level"] = status.batteryLevel;
    }
    if (typeof status.charging === "boolean") update["battery.charging"] = status.charging;
    if (typeof status.camera === "boolean") update["permissions.camera"] = status.camera;
    if (typeof status.microphone === "boolean") update["permissions.microphone"] = status.microphone;
    update.lastSeenAt = new Date();
    await Device.updateOne({ _id: device.id, ownerId: device.ownerId }, { $set: update });
    io.to(`owner:${device.ownerId}`).emit("device:metadata", { deviceId: String(device.id), ...status });
  });
  socket.on("signal", (message) => relaySignal(socket, message));
  socket.on("session:approved", ({ ownerSocketId } = {}) => {
    const request = activeSessionRequests.get(String(device.id));
    if (!request || request.ownerSocketId !== ownerSocketId || Date.now() - request.requestedAt > 30_000) return;
    const ownerSocket = io.sockets.sockets.get(ownerSocketId);
    if (ownerSocket?.data.role === "owner" && ownerSocket.data.ownerId === String(device.ownerId)) {
      activeSessionRequests.delete(String(device.id));
      ownerSocket.emit("session:approved", { deviceId: String(device.id), deviceSocketId: socket.id });
    }
  });
  socket.on("session:denied", ({ ownerSocketId } = {}) => {
    const request = activeSessionRequests.get(String(device.id));
    if (!request || request.ownerSocketId !== ownerSocketId || Date.now() - request.requestedAt > 30_000) return;
    activeSessionRequests.delete(String(device.id));
    const ownerSocket = io.sockets.sockets.get(ownerSocketId);
    if (ownerSocket?.data.role === "owner" && ownerSocket.data.ownerId === String(device.ownerId)) {
      ownerSocket.emit("session:denied", { deviceId: String(device.id) });
    }
  });
  socket.on("recording:approved", ({ ownerSocketId, requestId } = {}) => {
    const request = activeRecordingRequests.get(String(device.id));
    if (!request || request.ownerSocketId !== ownerSocketId || request.requestId !== requestId ||
      Date.now() - request.requestedAt > 30_000) return;
    activeRecordingRequests.delete(String(device.id));
    const ownerSocket = io.sockets.sockets.get(ownerSocketId);
    if (ownerSocket?.data.role !== "owner" || ownerSocket.data.ownerId !== String(device.ownerId)) return;
    ownerSocket.emit("recording:approved", { deviceId: String(device.id), requestId, type: request.type });
    socket.emit("recording:active", { requestId, type: request.type });
  });
  socket.on("recording:denied", ({ ownerSocketId, requestId } = {}) => {
    const request = activeRecordingRequests.get(String(device.id));
    if (!request || request.ownerSocketId !== ownerSocketId || request.requestId !== requestId ||
      Date.now() - request.requestedAt > 30_000) return;
    activeRecordingRequests.delete(String(device.id));
    const ownerSocket = io.sockets.sockets.get(ownerSocketId);
    if (ownerSocket?.data.role === "owner" && ownerSocket.data.ownerId === String(device.ownerId)) {
      ownerSocket.emit("recording:denied", { deviceId: String(device.id), requestId });
    }
  });
  socket.on("recording:end", () => socket.emit("recording:end"));
  socket.on("session:end", () => {
    activeSessionRequests.delete(String(device.id));
    activeRecordingRequests.delete(String(device.id));
    for (const ownerSocketId of activeOwnerSockets.get(String(device.ownerId)) || []) {
      io.to(ownerSocketId).emit("signal", { from: socket.id, type: "stop", payload: null });
    }
  });
  socket.on("disconnect", () => {
    activeRecordingRequests.delete(String(device.id));
    activeSessionRequests.delete(String(device.id));
    if (activeDeviceSockets.get(String(device.id))?.socketId === socket.id) {
      activeDeviceSockets.delete(String(device.id));
      io.to(`owner:${device.ownerId}`).emit("device:status", { deviceId: String(device.id), online: false });
    }
  });
});

function relaySignal(socket, message = {}) {
  if (!message.to || !["offer", "answer", "ice", "stop"].includes(message.type)) return;
  const target = io.sockets.sockets.get(message.to);
  if (!target || target.data.ownerId !== socket.data.ownerId) return;
  const allowed =
    (socket.data.role === "owner" && target.data.role === "device") ||
    (socket.data.role === "device" && target.data.role === "owner");
  if (allowed) target.emit("signal", { from: socket.id, type: message.type, payload: message.payload });
}

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
if (isProduction) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.resolve(root, "../dist")));
  app.get("*", (_req, res) => res.sendFile(path.resolve(root, "../dist/index.html")));
}
app.get("/healthz", (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({ status: databaseReady ? "ok" : "database-unavailable" });
});
app.use((error, _req, res, _next) => {
  console.error("Request failed:", error.message);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  res.status(status).json({ error: status < 500 ? error.message : "An unexpected server error occurred." });
});

server.listen(PORT, () => console.log(`SMARTVISION CCTV listening on port ${PORT}`));
