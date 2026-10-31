# SMARTVISION CCTV

SMARTVISION CCTV is a browser-based, consent-first remote camera monitoring platform. Mobile devices pair using a short-lived QR code and share real browser camera/microphone tracks over WebRTC only after the device owner explicitly approves each monitoring session.

## Features

- Responsive, light-theme monitoring dashboard with overview, live camera layouts (1/4/9/16), device management, QR enrollment, audio, local recordings, storage, notifications, and settings.
- React/Vite frontend with an Express and Socket.IO backend.
- MongoDB-backed accounts, authorized devices, and one-use pairing sessions.
- Password-hashed accounts, HTTP-only same-site cookies, rate-limited authentication/pairing endpoints, origin checks, and owner-scoped signaling.
- Camera and microphone permission prompts initiated by a mobile-browser user gesture. Each monitoring request needs a separate approval on that mobile browser.
- WebRTC offer/answer and ICE signaling; STUN by default and optional coturn REST TURN credentials.
- Consent-based MediaRecorder output stored in that dashboard browser's IndexedDB. Recordings can be played, downloaded, and deleted locally.
- Explicit visibility, track, network, and signaling status; no placeholder/fake streams or synthetic LIVE state.

## Requirements

- Node.js 20 or newer.
- MongoDB 6+ locally or a MongoDB Atlas database.
- HTTPS in production. Browsers generally permit camera/microphone access on `localhost` during development.
- For devices on separate networks or restrictive mobile carriers, configure a TURN server. A STUN-only setup will not connect through every NAT/firewall.

## Local development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. Set `MONGODB_URI` and a randomly generated `JWT_SECRET` of at least 32 characters. Keep `.env` private.

   PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Start MongoDB, then run:

   ```sh
   npm run dev
   ```

4. Open `http://localhost:5173`, create an account, and use **QR pairing**. Scan the displayed QR with a phone camera. The phone must reach the same app using an HTTPS URL for camera access; a phone cannot use its own `localhost` to reach your development computer. For local phone testing, use a trusted HTTPS development tunnel and set `APP_ORIGIN` to that exact origin.

5. To test two different devices, sign in on the dashboard browser, scan the one-time pairing QR on a mobile browser, grant the requested browser permission(s), then accept a session request on the mobile device. Keep both browser pages open in the foreground for the most reliable behavior.

`npm run dev` starts Vite on port 5173 and the API/signaling server on port 3001. Vite proxies `/api` and `/socket.io` to the backend.

## Environment

| Variable | Required | Description |
|---|---:|---|
| `PORT` | No | Express/Socket.IO port (default `3001`). |
| `NODE_ENV` | No | Set `production` for secure cookies and built frontend hosting. |
| `MONGODB_URI` | Yes | MongoDB connection string. |
| `JWT_SECRET` | Yes | Private random secret, at least 32 characters. Rotate carefully; rotation invalidates current sessions. |
| `APP_ORIGIN` | Yes for deployment | Exact browser origin allowed by the API/socket (scheme, hostname, and port), e.g. `https://monitor.example.com`. |
| `STUN_URL` | No | STUN URI; defaults to Google's public STUN endpoint. |
| `TURN_URL` | Recommended for production | TURN URI, e.g. `turn:turn.example.com:3478` or `turns:turn.example.com:5349`. |
| `TURN_SECRET` | Recommended with TURN | coturn REST shared secret. The backend creates time-limited HMAC-SHA1 credentials per authenticated account. Never place the shared secret in frontend code. |

Use a private TURN deployment and firewall policy suitable for your environment. Keep the TURN shared secret and MongoDB credentials in your host's secret manager.

## Netlify frontend + Render backend deployment

Netlify serves the static React frontend. The Express/Socket.IO signaling server must run separately on a persistent Node host; deploy it to Render, Railway, Fly.io, or another service that supports WebSocket upgrades. Netlify Functions are not a persistent Socket.IO server. This repository includes `netlify.toml` and a Render Blueprint in `render.yaml`.

1. Push this repository to a Git provider and import it as a new Netlify site. Netlify detects the repository-root `netlify.toml`, runs `npm run build`, and publishes `dist/`. The `/*` rewrite supports the React single-page routes.
2. Deploy `render.yaml` as a Render Blueprint. Before creating the service, create a MongoDB Atlas database/user and allow the Render service to connect. Set the Blueprint's `MONGODB_URI` to the Atlas URI (Render marks it secret/not synced).
3. After the Render service is created, note its HTTPS origin, for example `https://smartvision-cctv-api.onrender.com`. In Netlify build environment variables, set:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | Render origin, without a trailing slash |
   | `VITE_SIGNALING_URL` | Same Render origin, without a trailing slash |

   Trigger a new Netlify deploy after changing build variables.

4. In Render environment variables, set `APP_ORIGIN` to the exact Netlify site origin (for example `https://your-site.netlify.app`, with no path or trailing slash). Redeploy the backend after setting it. Set `NODE_ENV=production`, `COOKIE_SAME_SITE=none`, and a strong generated `JWT_SECRET`; the Blueprint generates the latter automatically. Never set secrets as `VITE_*` variables: Vite includes those in public browser files.
5. Add a custom domain to Netlify and use an API subdomain under that same domain for Render (for example, `monitor.example.com` and `api.example.com`). Set `APP_ORIGIN=https://monitor.example.com`, `VITE_API_URL=https://api.example.com`, `VITE_SIGNALING_URL=https://api.example.com`, and `COOKIE_DOMAIN=.example.com`. Once both hosts use HTTPS and share the same registrable domain, set `COOKIE_SAME_SITE=strict` for better CSRF protection. This avoids third-party-cookie restrictions that may affect the default `netlify.app` + `onrender.com` domains. DNS and custom-domain verification are configured in each provider's dashboard.
6. In MongoDB Atlas, restrict network access appropriately. For initial connectivity testing only, Atlas may require an IP allow-list entry for the backend host; do not assume a stable outbound IP unless your hosting plan guarantees it.
7. (Recommended) Configure a private coturn service and set `TURN_URL` and `TURN_SECRET` in Render. Test WebSocket connectivity, sign-in, QR pairing, and WebRTC from Wi-Fi and cellular networks.

Netlify alone cannot host this full application: it only hosts the frontend here. The Render Web Service stays online for the Express API and Socket.IO/WebRTC signaling. Atlas, Netlify, and Render account setup, DNS, and production secrets must be authorized in their respective dashboards.

The included Render Blueprint selects a free Web Service so deployment does not silently opt into paid hosting. Free instances can sleep while idle and may interrupt sessions during restarts; choose an always-on paid instance in Render if uninterrupted signaling is important.

For a single-origin deployment on a WebSocket-capable Node host, omit the two `VITE_*_URL` variables and the frontend uses its own origin for API and signaling.

## Important browser limitations

- A browser page cannot guarantee that a camera or microphone remains active after the screen locks, the browser is backgrounded/suspended, the operating system reclaims resources, or the phone powers off. SMARTVISION displays page visibility and connection/media state but cannot override these restrictions.
- Camera/microphone access requires browser permission and HTTPS (except localhost). Device owners can revoke permission in browser settings at any time.
- WebRTC peer-to-peer connectivity is not guaranteed by STUN alone. TURN relay service is needed for some networks. The app does not claim a stream is live until a real peer connection/track is received.
- Recordings are local to the dashboard browser's IndexedDB, not encrypted server-side or synchronized. Browser cleanup/storage eviction can delete them. Download recordings for retention and protect the computer/browser account.
- The app does not include email verification, password reset, multi-factor authentication, billing, cloud recording storage, a built-in TURN server, or a separately audited compliance program. Add operational controls appropriate to your deployment and jurisdiction before production use.
- Browser notifications are permission-based and are shown only while this dashboard is running; persistent push notifications/service-worker delivery are not configured.

## Commands

```sh
npm run dev       # frontend and backend development servers
npm run build     # production frontend build
npm start         # production Express + Socket.IO server
npm test          # Node test runner
```
