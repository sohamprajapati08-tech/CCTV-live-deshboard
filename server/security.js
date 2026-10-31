import { createHash, createHmac, randomBytes } from "node:crypto";

export function digestToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePairingSecret() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: digestToken(token) };
}

export function isValidDeviceName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 60;
}

export function identifyBrowser(userAgent = "") {
  if (/Edg\//.test(userAgent)) return "Microsoft Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Unknown browser";
}

export function createIceServers({ stunUrl, turnUrl, turnSecret, ownerId, now = Date.now() }) {
  const servers = [{ urls: stunUrl || "stun:stun.l.google.com:19302" }];
  if (turnUrl && turnSecret) {
    const username = `${Math.floor(now / 1000) + 3600}:${ownerId}`;
    servers.push({
      urls: turnUrl,
      username,
      credential: createHmac("sha1", turnSecret).update(username).digest("base64")
    });
  }
  return servers;
}
