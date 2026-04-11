# playbig — project notes for Claude

## What this is

`playbig` is an Express HTTP service that manages Playwright browser sessions.
Each session = one isolated Chromium browser process. Sessions never share cookies
or state. A watchdog monitors them and kills crashed or expired ones.

## File map

```
src/
  index.js           — entry point: checks chromium, starts server, handles SIGTERM/SIGINT
  server.js          — Express app factory; mounts routers; starts monitor
  session-manager.js — core singleton; all browser lifecycle logic; runAction switch
  monitor.js         — watchdog: periodic health checks + expiry enforcement
  forwarder.js       — follower routing: transparent proxy + session registry
  chromium-check.js  — launch+close a test browser at startup; exit(1) if broken
  routes/
    sessions.js      — REST CRUD for sessions + action/logs/network endpoints
    health.js        — GET /health endpoint

examples/            — self-contained JS demos (use native fetch, no extra deps)
tests/               — jest unit tests
scripts/
  install-chromium.sh — system deps (root) + playwright browser binary (user)
Dockerfile           — based on mcr.microsoft.com/playwright:v1.44.0-jammy
docker-compose.yml   — standalone by default; leader+slave config commented out
```

## Key design decisions

- **One browser per session** for true isolation (not shared browser + context).
- **Ring buffers** for console logs and network entries (`MAX_CONSOLE_LOGS`, `MAX_NETWORK_ENTRIES`).
- **Monitor uses `browser.isConnected()`** for cheap liveness, then falls back to
  `page.evaluate('1')` — avoids noisy round-trips when the browser is healthy.
- **`evaluate`** runs JS in the browser via `page.evaluate(code)`.
- **`exec`** runs server-side Playwright code via `AsyncFunction('page','context','browser', body)`.
- **Follower routing** (FOLLOWERS env var) makes the leader a transparent reverse proxy.
  The client only ever talks to the leader; the leader routes all requests to the right
  node using an in-memory session registry. See `src/forwarder.js`.
- **Graceful shutdown**: monitor.stop() → server.close() → sessionManager.destroyAll().

## Follower routing

Set `FOLLOWERS=host1:port1,host2:port2` on the leader node to enable load distribution.
Full `http://` URLs are also accepted.

```
# Start two follower nodes (plain, no FOLLOWERS set)
PORT=3001 node src/index.js
PORT=3002 node src/index.js

# Start the leader
FOLLOWERS=localhost:3001,localhost:3002 PORT=3000 node src/index.js
```

How it works:
- Pool = followers + self. Self is always included.
- `POST /sessions` → round-robins across the pool. If a follower is chosen, the request
  is proxied; the resulting session ID is registered in the leader's in-memory registry.
  If self is chosen, the leader handles it locally and registers the ID.
- Any other `/sessions/:id/…` → looked up in the registry. Forwarded to the owning
  follower, or handled locally. The client never needs to know which node owns a session.
- `DELETE /sessions/:id` → proxied/handled, then unregistered.
- Response includes `x-playbig-node` header naming the follower that handled it
  (absent when handled by the leader itself).

The session registry is in-memory. A leader restart loses routing state for
existing sessions (those sessions would return 404 from the leader until deleted
directly on the follower).

## Environment variables (see .env.example)

`PORT`, `MAX_SESSION_AGE_MS`, `MAX_CONSOLE_LOGS`, `MAX_NETWORK_ENTRIES`,
`MONITOR_INTERVAL_MS`, `FOLLOWERS`

## Common tasks

### Add a new action

1. Add a `case 'myAction':` block in `src/session-manager.js` → `runAction()`.
2. Document it in the action table in `README.md`.
3. No other files need to change.

### Add auth middleware

Add it in `src/server.js` before the route mounts. The rest of the service is
auth-agnostic.

### Add a new route

Create `src/routes/myroute.js`, export an Express `router`, mount it in
`src/server.js`.

## Running locally

```bash
npm install
sudo bash scripts/install-chromium.sh
cp .env.example .env
npm start
```

## Running tests

```bash
npm test
```

Tests live in `tests/` and use jest. Current coverage: `forwarder.js` unit tests.
