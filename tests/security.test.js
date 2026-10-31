import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createIceServers, digestToken, generatePairingSecret, identifyBrowser,
  isValidDeviceName
} from "../server/security.js";

test("pairing secrets are high entropy and only their digest is persisted", () => {
  const first = generatePairingSecret();
  const second = generatePairingSecret();
  assert.equal(first.token.length, 43);
  assert.equal(first.tokenHash, digestToken(first.token));
  assert.notEqual(first.tokenHash, first.token);
  assert.notEqual(first.token, second.token);
});

test("device names reject blank or overlong values", () => {
  assert.equal(isValidDeviceName("  "), false);
  assert.equal(isValidDeviceName("Front entrance"), true);
  assert.equal(isValidDeviceName(`x${"x".repeat(60)}`), false);
});

test("browser identification uses reported user-agent family", () => {
  assert.equal(identifyBrowser("Mozilla/5.0 Edg/123.0"), "Microsoft Edge");
  assert.equal(identifyBrowser("Mozilla/5.0 Firefox/124.0"), "Firefox");
  assert.equal(identifyBrowser("unknown"), "Unknown browser");
});

test("TURN credentials are owner-scoped, time-limited, and signed server-side", () => {
  const now = 1_800_000_000_000;
  const config = createIceServers({
    stunUrl: "stun:stun.example.test:3478",
    turnUrl: "turns:turn.example.test:5349",
    turnSecret: "private-shared-secret",
    ownerId: "owner-123",
    now
  });
  const username = `${Math.floor(now / 1000) + 3600}:owner-123`;
  assert.equal(config.length, 2);
  assert.equal(config[1].username, username);
  assert.equal(config[1].credential, createHmac("sha1", "private-shared-secret").update(username).digest("base64"));
  assert.equal(createIceServers({ turnUrl: "turn:relay", turnSecret: "", ownerId: "owner-123" }).length, 1);
});
