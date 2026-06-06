'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Per-session writable dirs live under here. Cleaned up in endSession.
// Lives on tmpfs (or a regular dir if /tmp is not tmpfs); we ensure it
// exists once at module load time. The dir is owned by whoever runs
// playbig — Chromium under bwrap shares the same outer UID via --uid
// 1000, so it can write here.
const SESSION_ROOT = process.env.PLAYBIG_SESSION_ROOT || '/tmp/playbig-sessions';
try { fs.mkdirSync(SESSION_ROOT, { recursive: true, mode: 0o755 }); } catch { /* ignore */ }

// Wrapper script path — packaged alongside the source. Each launch sets
// CHROMIUM_REAL_BIN + PLAYBIG_BWRAP_SESSION_DIR in env so the wrapper
// knows what to bwrap and where to bind RW. The wrapper itself lives in
// the repo (scripts/chromium-bwrap.sh) so it ships with the bind-mount
// — no separate install step.
const BWRAP_WRAPPER = path.resolve(__dirname, '..', 'scripts', 'chromium-bwrap.sh');

// CHROMIUM_BWRAP_DISABLE=1 falls back to launching Chromium directly,
// without the per-session bwrap envelope. Useful for debugging when
// bwrap or the underlying namespace plumbing is broken; never in prod.
function bwrapDisabled() {
  return process.env.CHROMIUM_BWRAP_DISABLE === '1';
}

// Move a Playwright Download into the session's downloads subdir on the
// host fs (which is bind-mounted RW into the bwrap'd chromium). Records
// metadata on the session; the bytes themselves are served by
// GET /sessions/:id/downloads/:idx.
//
// Hard-capped at MAX_DOWNLOAD_BYTES per file and MAX_DOWNLOADS_PER_SESSION
// total — a malicious site can't fill the herd's scratch space.
async function captureDownload(session, downloadsDir, download) {
  if (!downloadsDir) return; // bwrap disabled — fall back to playwright's default tmp
  if (session.downloads.length >= MAX_DOWNLOADS_PER_SESSION) {
    try { await download.cancel(); } catch { /* best effort */ }
    return;
  }
  const idx = session.downloads.length;
  const suggested = download.suggestedFilename() || `download-${idx}`;
  // Sanitise — strip path separators and disallow .. — the file lives
  // inside the per-session dir so even a path-traversal hit can't reach
  // the host's real fs, but a clean name is friendlier to clients.
  const safeName = suggested.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || `download-${idx}`;
  const finalPath = path.join(downloadsDir, `${idx}-${safeName}`);
  try {
    await download.saveAs(finalPath);
    const st = fs.statSync(finalPath);
    if (st.size > MAX_DOWNLOAD_BYTES) {
      // Save succeeded but exceeded our cap; truncate by deleting.
      try { fs.unlinkSync(finalPath); } catch { /* ignore */ }
      session.downloads.push({
        idx, name: safeName, url: download.url(),
        bytes: st.size, savedAt: Date.now(),
        truncated: true, error: `exceeded MAX_DOWNLOAD_BYTES (${MAX_DOWNLOAD_BYTES})`,
      });
      return;
    }
    session.downloads.push({
      idx, name: safeName, url: download.url(),
      bytes: st.size, savedAt: Date.now(),
      path: finalPath,
    });
  } catch (err) {
    session.downloads.push({
      idx, name: safeName, url: download.url(),
      bytes: 0, savedAt: Date.now(),
      error: err.message,
    });
  }
}

// Default 30 min (was 0 = never expire, which let leaked sessions live forever).
// The monitor ends sessions past this; the OS-level chrome-reaper is the hard
// backstop a bit beyond it. Set to 0 to disable age-expiry (NOT recommended).
const MAX_SESSION_AGE_MS      = parseInt(process.env.MAX_SESSION_AGE_MS      || '1800000', 10);
const MAX_CONSOLE_LOGS        = parseInt(process.env.MAX_CONSOLE_LOGS        || '1000',    10);
const MAX_NETWORK_ENTRIES     = parseInt(process.env.MAX_NETWORK_ENTRIES     || '1000',    10);
// Max response body to buffer in memory per entry (default 1 MB). Bodies larger
// than this still have their size recorded via content-length; the body field will be null.
const MAX_RESPONSE_BODY_BYTES = parseInt(process.env.MAX_RESPONSE_BODY_BYTES || '1048576', 10);
// Hard cap on each download. The bytes are written to the per-session
// bwrap dir which lives on tmpfs/scratch — a runaway download from a
// malicious site shouldn't be able to fill the disk. Total per-session
// is bounded by MAX_DOWNLOADS_PER_SESSION × this.
const MAX_DOWNLOAD_BYTES      = parseInt(process.env.MAX_DOWNLOAD_BYTES      || '104857600', 10); // 100 MB
const MAX_DOWNLOADS_PER_SESSION = parseInt(process.env.MAX_DOWNLOADS_PER_SESSION || '50',     10);

// Used to execute arbitrary Playwright-API code on the server side
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class SessionManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  // ─── create ────────────────────────────────────────────────────────────────

  async createSession({ url, options = {}, apiKeyLabel = null, apiKeyId = null } = {}) {
    const id = uuidv4();

    // Defense in depth:
    //   - bwrap-outside  (this wrapper): fs / pid / ipc / uts / cgroup
    //                                    namespaces per session
    //   - chromium-inside (chromiumSandbox:true): renderer seccomp BPF +
    //                                              userns + no-new-privs
    //
    // Each session gets a private writable dir under SESSION_ROOT that
    // bwrap binds RW; everything else on the host fs is read-only.
    const sandboxOff = process.env.CHROMIUM_DISABLE_SANDBOX === '1';
    const sessionTmp = path.join(SESSION_ROOT, id);
    fs.mkdirSync(sessionTmp, { recursive: true, mode: 0o755 });

    const realChromiumBin = chromium.executablePath();
    const useBwrap = !bwrapDisabled();
    // Chromium's download artifacts land here (Playwright's downloadsPath).
    // The path is BIND-MOUNTED RW into bwrap, so chromium-inside and
    // playwright-outside see the same directory and download.saveAs() can
    // resolve the source file across the mount-ns boundary.
    const downloadsPath = path.join(sessionTmp, 'pw-downloads');
    fs.mkdirSync(downloadsPath, { recursive: true, mode: 0o755 });

    const launchOpts = {
      headless: true,
      chromiumSandbox: !sandboxOff,
      args: sandboxOff ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      downloadsPath,
      ...(options.launch || {}),
    };
    if (useBwrap) {
      launchOpts.executablePath = BWRAP_WRAPPER;
      launchOpts.env = {
        ...process.env,
        CHROMIUM_REAL_BIN:         realChromiumBin,
        PLAYBIG_BWRAP_SESSION_DIR: sessionTmp,
      };
    }
    const browser = await chromium.launch(launchOpts);

    const context = await browser.newContext({
      ...(options.context || {}),
    });

    const page = await context.newPage();

    const session = {
      id,
      startUrl: url || null,
      browser,
      context,
      page,
      consoleLogs: [],
      pageErrors:  [],
      networkRequests:  [],
      networkResponses: [],
      // Dialog capture ring-buffer (capped at 20; rare events)
      dialogHistory:   [],
      // One-shot handler installed by the 'handleDialog' action.
      // Fires on the next dialog; then auto-clears.
      dialogResponder: null,
      createdAt:    Date.now(),
      lastActivity: Date.now(),
      status: 'initializing',
      options,
      // Caller attribution — passed by the auth middleware. Used by the
      // close-webhook so downstream billing knows which user/job spent
      // browser time.
      apiKeyLabel,
      apiKeyId,
      // Per-session bwrap writable dir — cleaned up in endSession.
      bwrapSessionDir: useBwrap ? sessionTmp : null,
      // Downloads captured via page.on('download'). Saved to the
      // per-session bwrap dir (host fs side); the caller fetches them
      // via GET /sessions/:id/downloads/:idx.
      downloads: [],
    };

    // Per-session downloads dir — separate subdir so it survives the
    // chromium profile cleanup but still lives inside the bwrap-bound
    // session directory (so chromium-inside-bwrap can write here).
    const downloadsDir = sessionTmp ? path.join(sessionTmp, 'downloads') : null;
    if (downloadsDir) {
      try { fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o755 }); } catch { /* ignore */ }
    }

    context.on('page', (p) => p.on('download', (d) => captureDownload(session, downloadsDir, d)));
    page.on('download', (d) => captureDownload(session, downloadsDir, d));

    // Console log capture (ring buffer)
    page.on('console', msg => {
      if (session.consoleLogs.length >= MAX_CONSOLE_LOGS) session.consoleLogs.shift();
      session.consoleLogs.push({
        type:      msg.type(),
        text:      msg.text(),
        location:  msg.location(),
        timestamp: Date.now(),
      });
    });

    // Uncaught page errors
    page.on('pageerror', err => {
      session.pageErrors.push({ message: err.message, timestamp: Date.now() });
    });

    // Network requests (ring buffer)
    page.on('request', req => {
      if (session.networkRequests.length >= MAX_NETWORK_ENTRIES) session.networkRequests.shift();
      const postData = req.postData();
      session.networkRequests.push({
        url:          req.url(),
        method:       req.method(),
        headers:      req.headers(),
        postData,
        postDataSize: postData != null ? Buffer.byteLength(postData, 'utf-8') : 0,
        resourceType: req.resourceType(),
        timestamp:    Date.now(),
      });
    });

    // Network responses (ring buffer)
    // Timing fields use Playwright's request.timing() which is complete by the time
    // the response event fires. All ms values are relative to timing.startTime.
    //
    //   ttfbMs      — time from request start to first byte of response headers
    //   downloadMs  — time from first byte to last byte (pure transfer time)
    //   totalMs     — ttfbMs + downloadMs (request start → last byte on wire)
    //   dnsMs       — DNS lookup duration  (null if served from cache / not applicable)
    //   connectMs   — TCP handshake        (null if connection was reused)
    //   tlsMs       — TLS handshake        (null if not HTTPS or connection reused)
    //
    // bodySize      — actual bytes received (from buffer); falls back to content-length header
    // body          — decoded string for text/* and application/json (up to MAX_RESPONSE_BODY_BYTES)
    page.on('response', async resp => {
      if (session.networkResponses.length >= MAX_NETWORK_ENTRIES) session.networkResponses.shift();

      const t       = resp.request().timing();
      const headers = resp.headers();

      // Helper: -1 means "not applicable" in Playwright timing
      const ms = v => (v != null && v >= 0) ? v : null;

      const ttfbMs     = ms(t.responseStart);
      const downloadMs = (ms(t.responseEnd) != null && ms(t.responseStart) != null)
                         ? t.responseEnd - t.responseStart : null;
      const totalMs    = ms(t.responseEnd);
      const dnsMs      = (ms(t.domainLookupStart) != null && ms(t.domainLookupEnd) != null)
                         ? t.domainLookupEnd - t.domainLookupStart : null;
      const connectMs  = (ms(t.connectStart) != null && ms(t.connectEnd) != null)
                         ? t.connectEnd - t.connectStart : null;
      const tlsMs      = (ms(t.secureConnectionStart) != null && ms(t.connectEnd) != null)
                         ? t.connectEnd - t.secureConnectionStart : null;

      // Declared size from header (may be absent or wrong for chunked/compressed)
      const declaredSize = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;

      let body     = null;
      let bodySize = declaredSize;

      try {
        // Always buffer so we get the real size; skip only if content-length says it's huge
        if (declaredSize == null || declaredSize <= MAX_RESPONSE_BODY_BYTES) {
          const buf = await resp.body();
          bodySize  = buf.length;
          if (buf.length <= MAX_RESPONSE_BODY_BYTES) {
            const ct = headers['content-type'] || '';
            if (ct.includes('json') || ct.includes('text')) {
              body = buf.toString('utf-8');
            }
          }
        }
      } catch { /* redirect, cancelled request, etc. */ }

      session.networkResponses.push({
        url:        resp.url(),
        status:     resp.status(),
        statusText: resp.statusText(),
        headers,
        body,
        bodySize,
        timing: {
          startTime:  t.startTime,  // absolute Unix ms when request was initiated
          ttfbMs,
          downloadMs,
          totalMs,
          dnsMs,
          connectMs,
          tlsMs,
        },
        timestamp: Date.now(),
      });
    });

    // Page / browser crash
    page.on('crash', () => {
      session.status = 'crashed';
      console.error(`[session ${id}] page crashed`);
    });

    // Dialog capture + dispatch.
    // The handleDialog action installs a one-shot responder for the NEXT dialog.
    // Without one, dialogs are auto-dismissed so the page never hangs.
    page.on('dialog', async dialog => {
      if (session.dialogHistory.length >= 20) session.dialogHistory.shift();
      const info = {
        type:         dialog.type(),
        message:      dialog.message(),
        defaultValue: dialog.defaultValue(),
        timestamp:    Date.now(),
      };
      session.dialogHistory.push(info);

      const responder = session.dialogResponder;
      session.dialogResponder = null;          // consume immediately
      if (responder && responder.response === 'accept') {
        await dialog.accept(responder.promptText != null ? String(responder.promptText) : undefined);
      } else {
        await dialog.dismiss();
      }
    });

    this.sessions.set(id, session);

    try {
      if (url) {
        await page.goto(url, {
          waitUntil: options.waitUntil || 'domcontentloaded',
          timeout:   options.timeout   || 30_000,
        });
      }
      session.status = 'active';
    } catch (err) {
      session.status = 'error';
      session.pageErrors.push({ message: err.message, timestamp: Date.now() });
    }

    return id;
  }

  // ─── read ──────────────────────────────────────────────────────────────────

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  listSessions() {
    return [...this.sessions.values()].map(s => this.sessionInfo(s));
  }

  sessionInfo(s) {
    return {
      id:           s.id,
      startUrl:     s.startUrl,
      status:       s.status,
      createdAt:    s.createdAt,
      lastActivity: s.lastActivity,
      ageMs:        Date.now() - s.createdAt,
      consoleLogs:  s.consoleLogs.length,
      pageErrors:   s.pageErrors.length,
      networkRequests:  s.networkRequests.length,
      networkResponses: s.networkResponses.length,
      downloads:    s.downloads ? s.downloads.length : 0,
    };
  }

  // ─── downloads ─────────────────────────────────────────────────────────────

  listDownloads(id) {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error('Session not found'); e.statusCode = 404; throw e; }
    // Strip the host fs path before returning — callers should never see it.
    return s.downloads.map(({ path: _path, ...rest }) => rest);
  }

  getDownloadStream(id, idx) {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error('Session not found'); e.statusCode = 404; throw e; }
    const d = s.downloads[idx];
    if (!d) { const e = new Error('Download not found'); e.statusCode = 404; throw e; }
    if (!d.path) {
      const e = new Error(d.error || 'Download has no body');
      e.statusCode = 410; // gone — capture failed or was truncated
      throw e;
    }
    return { path: d.path, name: d.name, bytes: d.bytes };
  }

  // ─── actions ───────────────────────────────────────────────────────────────

  async runAction(id, action, params = {}) {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error('Session not found'); e.statusCode = 404; throw e; }
    if (s.status === 'crashed') throw new Error('Session has crashed');
    s.lastActivity = Date.now();

    const { page, context, browser } = s;

    switch (action) {
      // ── navigation ────────────────────────────────────────────────────────
      case 'navigate':
        await page.goto(params.url, {
          waitUntil: params.waitUntil || 'domcontentloaded',
          timeout:   params.timeout   || 30_000,
        });
        return { url: page.url(), title: await page.title() };

      case 'reload':
        await page.reload({ waitUntil: params.waitUntil || 'domcontentloaded' });
        return { url: page.url() };

      case 'back':
        await page.goBack({ waitUntil: params.waitUntil || 'domcontentloaded' });
        return { url: page.url() };

      case 'forward':
        await page.goForward({ waitUntil: params.waitUntil || 'domcontentloaded' });
        return { url: page.url() };

      // ── page state ────────────────────────────────────────────────────────
      case 'url':
        return { url: page.url() };

      case 'title':
        return { title: await page.title() };

      case 'content':
        return { html: await page.content() };

      // ── dom interaction ───────────────────────────────────────────────────
      case 'click':
        await page.click(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      case 'dblclick':
        await page.dblclick(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      case 'fill':
        await page.fill(params.selector, params.value, { timeout: params.timeout || 10_000 });
        return {};

      case 'type':
        await page.type(params.selector, params.text, { delay: params.delay || 0 });
        return {};

      case 'pressKey':
        await page.keyboard.press(params.key);
        return {};

      case 'hover':
        await page.hover(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      case 'select':
        return { values: await page.selectOption(params.selector, params.value) };

      case 'check':
        await page.check(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      case 'uncheck':
        await page.uncheck(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      case 'focus':
        await page.focus(params.selector, { timeout: params.timeout || 10_000 });
        return {};

      // ── waiting ───────────────────────────────────────────────────────────
      case 'waitForSelector':
        await page.waitForSelector(params.selector, {
          state:   params.state   || 'visible',
          timeout: params.timeout || 30_000,
        });
        return {};

      case 'waitForNavigation':
        await page.waitForNavigation({ timeout: params.timeout || 30_000 });
        return { url: page.url() };

      case 'waitForLoadState':
        await page.waitForLoadState(params.state || 'load', { timeout: params.timeout || 30_000 });
        return {};

      case 'waitForTimeout':
        await page.waitForTimeout(Math.min(params.ms || 1000, 60_000));
        return {};

      // ── element queries ───────────────────────────────────────────────────
      case 'getAttribute':
        return { value: await page.getAttribute(params.selector, params.attribute, { timeout: params.timeout || 10_000 }) };

      case 'innerText':
        return { text: await page.innerText(params.selector, { timeout: params.timeout || 10_000 }) };

      case 'innerHTML':
        return { html: await page.innerHTML(params.selector, { timeout: params.timeout || 10_000 }) };

      case 'inputValue':
        return { value: await page.inputValue(params.selector, { timeout: params.timeout || 10_000 }) };

      case 'isVisible':
        return { visible: await page.isVisible(params.selector) };

      case 'isEnabled':
        return { enabled: await page.isEnabled(params.selector) };

      case 'isChecked':
        return { checked: await page.isChecked(params.selector) };

      case 'count':
        return { count: (await page.$$(params.selector)).length };

      // ── viewport / scroll ─────────────────────────────────────────────────
      case 'setViewport':
      case 'resize':
        await page.setViewportSize({ width: params.width, height: params.height });
        return {};

      case 'scroll':
        await page.evaluate(`window.scrollTo(${Number(params.x) || 0}, ${Number(params.y) || 0})`);
        return {};

      // ── accessibility snapshot ────────────────────────────────────────────
      // Returns the full accessibility tree for the current page.
      // Useful for understanding page structure without parsing HTML.
      // params.root    — CSS selector to root the snapshot at (default: full page)
      // params.interestingOnly — omit nodes with no accessible role (default: true)
      case 'snapshot': {
        const snapshotOpts = {};
        if (params.root != null) snapshotOpts.root = await page.$(params.root);
        if (params.interestingOnly != null) snapshotOpts.interestingOnly = params.interestingOnly;
        const snapshot = await page.accessibility.snapshot(snapshotOpts);
        return { snapshot };
      }

      // ── dialogs ───────────────────────────────────────────────────────────

      // handleDialog — installs a ONE-SHOT responder for the next dialog that
      // appears on this session.  Call this BEFORE triggering the action that
      // would cause the dialog (e.g. clicking a "Delete" button).
      //
      // params.response   — 'accept' (default) or 'dismiss'
      // params.promptText — text to type into prompt() dialogs (optional)
      case 'handleDialog':
        s.dialogResponder = {
          response:   params.response   || 'accept',
          promptText: params.promptText != null ? params.promptText : null,
        };
        return { queued: true };

      // dialogs — returns the history of dialogs that have fired on this session
      // (capped at the last 20 entries).
      case 'dialogs':
        return { dialogs: s.dialogHistory };

      // ── file upload ───────────────────────────────────────────────────────
      // Sets files on a <input type="file"> element.
      //
      // Option A — base64 content (no server-side file needed):
      //   params.selector  — CSS selector for the file input
      //   params.name      — filename to present to the page
      //   params.content   — base64-encoded file content
      //   params.mimeType  — MIME type (default: 'application/octet-stream')
      //
      // Option B — server-side path:
      //   params.selector  — CSS selector for the file input
      //   params.path      — absolute path on the playbig server
      case 'uploadFile': {
        if (!params.selector) {
          throw Object.assign(new Error('uploadFile requires "selector"'), { statusCode: 400 });
        }
        if (params.content != null) {
          const buf = Buffer.from(params.content, 'base64');
          await page.setInputFiles(params.selector, {
            name:     params.name     || 'upload',
            mimeType: params.mimeType || 'application/octet-stream',
            buffer:   buf,
          });
        } else if (params.path != null) {
          await page.setInputFiles(params.selector, params.path);
        } else {
          throw Object.assign(
            new Error('uploadFile requires "content" (base64) or "path" (server-side path)'),
            { statusCode: 400 },
          );
        }
        return {};
      }

      // ── cookies ───────────────────────────────────────────────────────────
      case 'cookies':
        return { cookies: await context.cookies() };

      case 'setCookies':
        await context.addCookies(params.cookies);
        return {};

      case 'clearCookies':
        await context.clearCookies();
        return {};

      // ── capture ───────────────────────────────────────────────────────────
      case 'screenshot': {
        const buf = await page.screenshot({
          fullPage: params.fullPage || false,
          type:     params.type     || 'png',
          ...(params.clip ? { clip: params.clip } : {}),
        });
        return { image: buf.toString('base64'), encoding: 'base64', mimeType: `image/${params.type || 'png'}` };
      }

      case 'pdf': {
        const buf = await page.pdf(params.options || {});
        return { pdf: buf.toString('base64'), encoding: 'base64' };
      }

      // ── eval: runs in the BROWSER context ────────────────────────────────
      // params.code is a JS expression or function string, e.g.:
      //   "document.title"
      //   "() => Array.from(document.querySelectorAll('a')).map(a => a.href)"
      case 'evaluate':
        return { result: await page.evaluate(params.code) };

      // ── exec: runs on the SERVER with access to Playwright page/context/browser
      // params.code is an async function body, e.g.:
      //   "const title = await page.title(); return title;"
      case 'exec': {
        const fn = new AsyncFunction('page', 'context', 'browser', params.code);
        return { result: await fn(page, context, browser) };
      }

      default:
        throw Object.assign(new Error(`Unknown action: ${action}`), { statusCode: 400 });
    }
  }

  // ─── destroy ───────────────────────────────────────────────────────────────

  async endSession(id, endReason = 'requested') {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error('Session not found'); e.statusCode = 404; throw e; }
    this.sessions.delete(id);
    const endedAt = Date.now();
    // Bound the close so a hung browser.close() can't wedge the caller or the
    // monitor tick. If it doesn't close in time the process is left for the
    // OS-level chrome-reaper to SIGKILL — it can never outlive the hard cap.
    try {
      await Promise.race([
        s.browser.close(),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch (err) {
      console.error(`[session ${id}] error closing browser: ${err.message}`);
    }
    // Reap the per-session bwrap work dir. Inside the bwrap mount-ns the
    // dir held the browser's profile / SingletonLock / cookies; once
    // chromium is gone we can delete it on the host fs side too.
    if (s.bwrapSessionDir) {
      try { fs.rmSync(s.bwrapSessionDir, { recursive: true, force: true }); }
      catch (err) {
        console.warn(`[session ${id}] failed to remove bwrap dir: ${err.message}`);
      }
    }
    // Fire-and-forget usage callback. Don't block the response on a slow
    // upstream — the local close is what the caller cares about.
    const callbackUrl = process.env.USAGE_CALLBACK_URL;
    if (callbackUrl) {
      const payload = {
        session_id:   id,
        api_key_id:   s.apiKeyId,
        api_key_label: s.apiKeyLabel,
        started_at:   s.createdAt,
        ended_at:     endedAt,
        duration_ms:  endedAt - s.createdAt,
        end_reason:   endReason,
      };
      const headers = { 'Content-Type': 'application/json' };
      const secret = process.env.USAGE_CALLBACK_SECRET;
      if (secret) headers.Authorization = `Bearer ${secret}`;
      fetch(callbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => {
        console.warn(`[session ${id}] usage callback failed: ${err.message}`);
      });
    }
    return { id, ended: true };
  }

  async destroyAll() {
    for (const id of [...this.sessions.keys()]) {
      await this.endSession(id).catch(() => {});
    }
  }

  // ─── health helpers ────────────────────────────────────────────────────────

  isExpired(session) {
    if (!MAX_SESSION_AGE_MS) return false;
    return Date.now() - session.createdAt > MAX_SESSION_AGE_MS;
  }
}

const sessionManager = new SessionManager();
module.exports = { sessionManager };
