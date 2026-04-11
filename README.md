# playbig

A lightweight Express service that manages isolated Playwright browser sessions over HTTP.

Each session is a fully separate Chromium browser instance — cookies, storage, and state never bleed between sessions. A built-in watchdog monitors all sessions and kills any that crash, become unresponsive, or exceed a configured time limit.

---

## Features

- **Isolated sessions** — every session gets its own browser process; nothing leaks between them
- **Rich observability** — access console logs, page errors, and full network traffic (requests + responses) per session
- **Process monitoring** — a watchdog runs every N seconds to reap crashed, stuck, or expired sessions
- **Max session age** — set `MAX_SESSION_AGE_MS` and sessions are automatically killed after that time
- **Leader / slave mode** — point a leader at N slaves; new sessions are round-robined across the pool (including optionally the leader itself)
- **Graceful shutdown** — SIGTERM / SIGINT closes all browsers cleanly
- **Docker-ready** — ships with a `Dockerfile` and `docker-compose.yml`

---

## Quick start

```bash
# 1. Install deps
npm install

# 2. Install Chromium system deps (once, needs root)
sudo bash scripts/install-chromium.sh

# 3. Copy and adjust config
cp .env.example .env

# 4. Start
npm start
```

Or with Docker:

```bash
docker compose up --build
```

---

## API

All endpoints accept and return JSON.

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create a new session |
| `GET` | `/sessions` | List all active sessions |
| `GET` | `/sessions/:id` | Get session info |
| `DELETE` | `/sessions/:id` | End session and kill its browser |
| `POST` | `/sessions/:id/action` | Run a Playwright action |
| `GET` | `/sessions/:id/logs` | Get console logs and page errors |
| `DELETE` | `/sessions/:id/logs` | Clear log buffer |
| `GET` | `/sessions/:id/network` | Get network requests/responses |
| `DELETE` | `/sessions/:id/network` | Clear network buffer |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service status, session list, monitor state |

---

## Creating a session

```http
POST /sessions
Content-Type: application/json

{
  "url": "https://example.com",
  "options": {
    "waitUntil": "networkidle",
    "timeout": 30000,
    "launch":  { "headless": true },
    "context": { "userAgent": "my-bot/1.0" }
  }
}
```

Response:
```json
{
  "id": "3f2a1b4c-…",
  "startUrl": "https://example.com",
  "status": "active",
  "createdAt": 1712345678901,
  "lastActivity": 1712345679012,
  "ageMs": 111
}
```

---

## Running actions

```http
POST /sessions/:id/action
Content-Type: application/json

{ "action": "navigate", "params": { "url": "https://news.ycombinator.com" } }
```

### Available actions

#### Navigation
| Action | Key params |
|--------|-----------|
| `navigate` | `url`, `waitUntil`, `timeout` |
| `reload` | `waitUntil` |
| `back` / `forward` | `waitUntil` |
| `url` | — |
| `title` | — |
| `content` | — |

#### DOM interaction
| Action | Key params |
|--------|-----------|
| `click` | `selector`, `timeout` |
| `dblclick` | `selector`, `timeout` |
| `fill` | `selector`, `value` |
| `type` | `selector`, `text`, `delay` |
| `pressKey` | `key` (e.g. `"Enter"`) |
| `hover` | `selector` |
| `select` | `selector`, `value` |
| `check` / `uncheck` | `selector` |
| `focus` | `selector` |

#### Waiting
| Action | Key params |
|--------|-----------|
| `waitForSelector` | `selector`, `state`, `timeout` |
| `waitForNavigation` | `timeout` |
| `waitForLoadState` | `state` (`load`/`domcontentloaded`/`networkidle`) |
| `waitForTimeout` | `ms` (max 60 000) |

#### Queries
| Action | Returns |
|--------|---------|
| `getAttribute` | `selector`, `attribute` → `value` |
| `innerText` | `selector` → `text` |
| `innerHTML` | `selector` → `html` |
| `inputValue` | `selector` → `value` |
| `isVisible` | `selector` → `visible` |
| `isEnabled` | `selector` → `enabled` |
| `isChecked` | `selector` → `checked` |
| `count` | `selector` → `count` |

#### Cookies
| Action | Key params |
|--------|-----------|
| `cookies` | — |
| `setCookies` | `cookies: [...]` |
| `clearCookies` | — |

#### Capture
| Action | Key params | Returns |
|--------|-----------|---------|
| `screenshot` | `fullPage`, `type`, `clip` | `image` (base64), `mimeType` |
| `pdf` | `options` | `pdf` (base64) |

#### Scripting
| Action | `params.code` | Runs where |
|--------|------------|------------|
| `evaluate` | JS expression or `() => …` | **Browser context** (`page.evaluate`) |
| `exec` | Async function body with `page`, `context`, `browser` in scope | **Server** (Playwright API) |

**`evaluate` example** (browser JS):
```json
{ "action": "evaluate", "params": { "code": "() => document.querySelectorAll('a').length" } }
```

**`exec` example** (server-side Playwright):
```json
{ "action": "exec", "params": { "code": "const title = await page.title(); return { title };" } }
```

#### Accessibility snapshot

Returns the full accessibility tree for the current page. Useful for understanding page structure without parsing HTML, and for AI agents that prefer semantic descriptions over raw markup.

| Action | Key params | Returns |
|--------|-----------|---------|
| `snapshot` | `root?` (CSS selector), `interestingOnly?` (bool, default `true`) | `snapshot` (nested object) |

```json
{ "action": "snapshot" }
{ "action": "snapshot", "params": { "root": "main", "interestingOnly": false } }
```

The `root` param scopes the tree to a subtree. `interestingOnly: false` includes every DOM node; the default omits nodes with no accessible role.

#### Resize

Alias for `setViewport`. Both action names are equivalent.

| Action | Key params |
|--------|-----------|
| `setViewport` / `resize` | `width`, `height` |

```json
{ "action": "resize", "params": { "width": 1280, "height": 800 } }
```

#### Dialogs

Alert, confirm, and prompt dialogs block the page until handled. Install a one-shot handler **before** triggering the action that opens the dialog.

| Action | Key params | Description |
|--------|-----------|-------------|
| `handleDialog` | `response` (`accept`/`dismiss`), `promptText?` | Arm handler for the **next** dialog |
| `dialogs` | — | Return history of dialogs seen this session (last 20) |

Without a pre-armed handler, dialogs are auto-dismissed so the page never hangs.

**Typical usage:**
```json
// 1. Arm the handler
{ "action": "handleDialog", "params": { "response": "accept" } }

// 2. Trigger the dialog
{ "action": "click", "params": { "selector": "#confirm-delete" } }

// 3. (Optional) inspect history
{ "action": "dialogs" }
```

For `prompt()` dialogs, use `promptText` to supply the typed value:
```json
{ "action": "handleDialog", "params": { "response": "accept", "promptText": "my answer" } }
```

#### File upload

Sets files on a `<input type="file">` element. Two options:

| Option | Params | When to use |
|--------|--------|-------------|
| Base64 content | `selector`, `name`, `content` (base64), `mimeType?` | File lives on the caller's side |
| Server-side path | `selector`, `path` | File already on the playbig server |

```json
{ "action": "uploadFile", "params": {
  "selector": "#file-input",
  "name": "report.pdf",
  "content": "<base64-encoded bytes>",
  "mimeType": "application/pdf"
}}
```

---

## Multi-tab / parallel sessions

playbig maps browser "tabs" to **separate sessions** — each session is its own isolated Chromium process. This differs from tools like playwright-mcp, where tabs share a single browser instance. The trade-off is stronger isolation (no cookie or storage bleed) at the cost of slightly higher memory per "tab".

**Open two tabs and drive them concurrently:**

```bash
# Open tab A
curl -s -X POST http://localhost:3000/sessions -H "Content-Type: application/json" \
  -d '{"url":"https://site-a.example.com"}' | jq -r .id
# → "sess-aaaa"

# Open tab B
curl -s -X POST http://localhost:3000/sessions -H "Content-Type: application/json" \
  -d '{"url":"https://site-b.example.com"}' | jq -r .id
# → "sess-bbbb"

# Act on each independently
curl -s -X POST http://localhost:3000/sessions/sess-aaaa/action \
  -H "Content-Type: application/json" -d '{"action":"click","params":{"selector":"#login"}}'

curl -s -X POST http://localhost:3000/sessions/sess-bbbb/action \
  -H "Content-Type: application/json" -d '{"action":"screenshot"}'
```

**With the CLI**, use `--session` to target a specific session without changing your persistent active session:

```bash
# Capture both IDs
TAB_A=$(playbig start-session https://site-a.example.com && cat ~/.playbig-session)
playbig start-session https://site-b.example.com   # replaces active
TAB_B=$(cat ~/.playbig-session)

# Drive them side by side
playbig --session "$TAB_A" click "#login"
playbig --session "$TAB_B" screenshot tab-b.png

# Switch the persistent default
playbig use "$TAB_A"
playbig title   # now acts on tab A
```

Sessions are fully isolated — cookies, localStorage, and network state never bleed between them.

---

## Observability

### Console logs

```http
GET /sessions/:id/logs
GET /sessions/:id/logs?type=error
GET /sessions/:id/logs?since=1712345678000
```

Response includes `logs[]` (console messages) and `pageErrors[]` (uncaught exceptions).

### Network

```http
GET /sessions/:id/network
GET /sessions/:id/network?url=api.example.com
GET /sessions/:id/network?since=1712345678000
```

Response includes `requests[]` and `responses[]`.

**Response entry fields:**

| Field | Description |
|-------|-------------|
| `url`, `status`, `statusText`, `headers` | Standard HTTP fields |
| `body` | Decoded string for `text/*` and `application/json` responses up to `MAX_RESPONSE_BODY_BYTES`; `null` otherwise |
| `bodySize` | Actual bytes received (from buffered body); falls back to `content-length` header |
| `timing.startTime` | Absolute Unix timestamp (ms) when request was initiated |
| `timing.ttfbMs` | Time to first byte — request start → first byte of response headers |
| `timing.downloadMs` | Pure download time — first byte → last byte on wire |
| `timing.totalMs` | End-to-end — request start → last byte (`ttfbMs + downloadMs`) |
| `timing.dnsMs` | DNS lookup duration (`null` if cached or not applicable) |
| `timing.connectMs` | TCP handshake duration (`null` if connection was reused) |
| `timing.tlsMs` | TLS handshake duration (`null` if HTTP or connection was reused) |

**Request entry fields:**

| Field | Description |
|-------|-------------|
| `url`, `method`, `headers`, `resourceType` | Standard |
| `postData` | Raw POST body string (if any) |
| `postDataSize` | Byte length of post body |

Both buffers are ring-buffers capped at `MAX_CONSOLE_LOGS` / `MAX_NETWORK_ENTRIES` (default 1 000 each). Response bodies are buffered up to `MAX_RESPONSE_BODY_BYTES` (default 1 MB) per entry.

---

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `MAX_SESSION_AGE_MS` | `0` (unlimited) | Auto-kill sessions older than this |
| `MAX_CONSOLE_LOGS` | `1000` | Ring-buffer size for console log capture |
| `MAX_NETWORK_ENTRIES` | `1000` | Ring-buffer size for network capture |
| `MAX_RESPONSE_BODY_BYTES` | `1048576` | Max response body buffered per entry (1 MB) |
| `MONITOR_INTERVAL_MS` | `10000` | Watchdog check frequency |
| `LEADER_MODE` | `false` | Enable leader / slave forwarding |
| `SLAVE_URLS` | `""` | Comma-separated slave base URLs |
| `FORWARD_INCLUDE_SELF` | `true` | Include the leader in the round-robin pool |

---

## Leader / slave mode

The leader round-robins new session creation across itself and any configured slaves. Once a session is created on a node, all subsequent calls for that session go directly to that node. The leader response includes an `x-playbig-slave` header with the target node's URL.

```
# Leader
LEADER_MODE=true SLAVE_URLS=http://slave1:3000,http://slave2:3000 PORT=3000 node src/index.js

# Slaves (plain standalone instances)
PORT=3001 node src/index.js
PORT=3002 node src/index.js
```

See `examples/leader-slave.js` for a complete example.

See `docker-compose.yml` for the commented-out multi-node setup.

---

## Chromium installation

### With the install script

```bash
# System deps (requires root)
sudo bash scripts/install-chromium.sh

# Browser binary only (current user)
bash scripts/install-chromium.sh --user-only
```

### With Docker

The Docker image is based on the official Playwright image which includes Chromium and all system dependencies.

```bash
docker compose up --build
```

---

## Remote MCP server

playbig exposes itself as a remote **Model Context Protocol** server so you can
control a live Chromium browser directly from Claude Code, Codex CLI, opencode,
or any other MCP-capable AI tool.

### How it works

| Endpoint | Purpose |
|----------|---------|
| `GET /mcp` | Discovery / connectivity probe (no auth) |
| `POST /mcp` | JSON-RPC 2.0 entry point — all MCP traffic |
| `GET /admin/keys` | List access keys |
| `POST /admin/keys` | Create an access key |
| `DELETE /admin/keys/:key` | Revoke an access key |

Access keys are stored in `./content.db` (SQLite). The `/admin/keys` endpoints
require `Authorization: Bearer <ADMIN_SECRET>`; if `ADMIN_SECRET` is not set
they return **503** so you're safe by default.

The `/mcp` and `/admin/keys` endpoints are **leader-local** — they are never
forwarded to follower nodes.

### MCP tools exposed

| Tool | Description |
|------|-------------|
| `browser_create_session` | Launch a new isolated Chromium session |
| `browser_list_sessions` | List all active sessions |
| `browser_get_session` | Get session status and metadata |
| `browser_delete_session` | End a session and kill the browser |
| `browser_run_action` | Run any Playwright action (navigate, click, fill, screenshot, evaluate, …) |
| `browser_get_logs` | Retrieve console logs and page errors |
| `browser_get_network` | Retrieve captured network requests and responses |

### Setup

**1. Set `ADMIN_SECRET` in your `.env`:**

```bash
# generate a strong secret
openssl rand -hex 32
```

Add to `.env`:

```
ADMIN_SECRET=<the-generated-secret>
```

**2. Start the service:**

```bash
npm start
```

**3. Create an access key:**

```bash
curl -s -X POST http://localhost:3000/admin/keys \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-claude-code-key"}' | jq .
# → { "id": "...", "key": "pbk_...", "label": "my-claude-code-key", "created_at": ... }
```

**4. Add to your AI tool** (replace `http://localhost:3000` with your server URL
and `pbk_...` with the key from step 3):

---

#### Claude Code

```bash
claude mcp add --transport http playbig http://localhost:3000/mcp \
  --header "Authorization: Bearer pbk_..."
```

Or edit `~/.claude.json` (global) / `.claude.json` (project) manually:

```json
{
  "mcpServers": {
    "playbig": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer pbk_..."
      }
    }
  }
}
```

Verify the server is reachable:

```bash
claude mcp list
```

---

#### OpenAI Codex CLI

Add to `~/.codex/config.json` (create if absent):

```json
{
  "mcp": {
    "servers": {
      "playbig": {
        "transport": "http",
        "url": "http://localhost:3000/mcp",
        "headers": {
          "Authorization": "Bearer pbk_..."
        }
      }
    }
  }
}
```

---

#### opencode

Add to your opencode config (typically `~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "playbig": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer pbk_..."
      }
    }
  }
}
```

---

### Revoking a key

```bash
curl -s -X DELETE http://localhost:3000/admin/keys/pbk_... \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

### Example usage from Claude Code

Once the MCP server is configured, you can ask Claude Code to:

```
Use the playbig MCP tools to:
1. Open a browser and navigate to https://example.com
2. Take a screenshot
3. Get the page title
4. Close the session
```

---

## Examples

```bash
node examples/basic-session.js     # navigate, evaluate, screenshot
node examples/capture-network.js   # network traffic capture
node examples/console-logs.js      # console log and page error capture
node examples/leader-slave.js      # distributed session creation
```

---

## CLI (`./playbig`)

A local command-line tool for driving the API interactively. Requires Node ≥ 18 (uses built-in `fetch`).

### Setup

```bash
# Put your token in ~/.playbig
echo "token=pbk_..." > ~/.playbig
# Optionally set the server URL (default: http://localhost:3000)
echo "url=http://myserver:3000" >> ~/.playbig
```

Or via env vars: `PLAYBIG_TOKEN=pbk_...` and `PLAYBIG_URL=http://...`.

### Quick reference

```bash
# Session lifecycle
playbig start-session [url]       # launch browser (kills existing session)
playbig end-session               # close browser
playbig sessions                  # list all sessions (* = active)
playbig use <session-id>          # switch active session

# Navigation
playbig goto https://example.com
playbig reload / back / forward
playbig url / title / content

# DOM
playbig click "#submit"
playbig fill "#email" "user@example.com"
playbig press Enter
playbig wait "#result"            # waits for selector (visible by default)

# Capture
playbig screenshot page.png
playbig screenshot --full full.png
playbig pdf page.pdf

# Accessibility tree
playbig snapshot                  # full page
playbig snapshot main             # rooted at <main>

# Resize viewport
playbig resize 1280 800
playbig viewport 1920 1080        # synonym

# Dialogs — arm BEFORE the action that opens the dialog
playbig handle-dialog accept
playbig click "#delete-account"
playbig dialogs                   # inspect history

# File upload
playbig upload-file "#avatar" ./photo.jpg

# JS execution
playbig eval "document.title"
playbig exec "return await page.title();"

# Observability
playbig logs --type error
playbig network --url api/
playbig health

# Multi-session targeting
playbig --session <id> <command>  # target a session without changing ~/.playbig-session
```

Full help: `playbig help`
