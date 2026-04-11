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
  forwarder.js       — leader-mode round-robin middleware
  chromium-check.js  — launch+close a test browser at startup; exit(1) if broken
  routes/
    sessions.js      — REST CRUD for sessions + action/logs/network endpoints
    health.js        — GET /health endpoint

examples/            — self-contained JS demos (use native fetch, no extra deps)
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
- **Leader forwarding** only intercepts `POST /sessions` (session creation). All subsequent
  calls for an existing session go directly to the node that owns it (client uses
  the `x-playbig-slave` response header).
- **Graceful shutdown**: monitor.stop() → server.close() → sessionManager.destroyAll().

## Environment variables (see .env.example)

`PORT`, `MAX_SESSION_AGE_MS`, `MAX_CONSOLE_LOGS`, `MAX_NETWORK_ENTRIES`,
`MONITOR_INTERVAL_MS`, `LEADER_MODE`, `SLAVE_URLS`, `FORWARD_INCLUDE_SELF`

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

## Running tests / linting

None set up yet — add with jest/vitest and eslint if needed.
