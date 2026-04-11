'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');

const MAX_SESSION_AGE_MS      = parseInt(process.env.MAX_SESSION_AGE_MS      || '0',       10);
const MAX_CONSOLE_LOGS        = parseInt(process.env.MAX_CONSOLE_LOGS        || '1000',    10);
const MAX_NETWORK_ENTRIES     = parseInt(process.env.MAX_NETWORK_ENTRIES     || '1000',    10);
// Max response body to buffer in memory per entry (default 1 MB). Bodies larger
// than this still have their size recorded via content-length; the body field will be null.
const MAX_RESPONSE_BODY_BYTES = parseInt(process.env.MAX_RESPONSE_BODY_BYTES || '1048576', 10);

// Used to execute arbitrary Playwright-API code on the server side
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class SessionManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  // ─── create ────────────────────────────────────────────────────────────────

  async createSession({ url, options = {} } = {}) {
    const id = uuidv4();

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(options.launch || {}),
    });

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
      createdAt:    Date.now(),
      lastActivity: Date.now(),
      status: 'initializing',
      options,
    };

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
    };
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
        await page.setViewportSize({ width: params.width, height: params.height });
        return {};

      case 'scroll':
        await page.evaluate(`window.scrollTo(${Number(params.x) || 0}, ${Number(params.y) || 0})`);
        return {};

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

  async endSession(id) {
    const s = this.sessions.get(id);
    if (!s) { const e = new Error('Session not found'); e.statusCode = 404; throw e; }
    this.sessions.delete(id);
    try { await s.browser.close(); } catch (err) {
      console.error(`[session ${id}] error closing browser: ${err.message}`);
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
