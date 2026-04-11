'use strict';

/**
 * Unit tests for the playbig CLI.
 *
 * Strategy:
 *  - Mock `fs` so no real files are read or written.
 *  - Mock global `fetch` so no real HTTP calls are made.
 *  - Mock `process.exit` to prevent Jest from exiting.
 *  - Import the module under test after setting up mocks.
 */

jest.mock('fs');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  loadConfig,
  readSession,
  writeSession,
  apiRequest,
  resolveSession,
  COMMANDS,
  main,
  CONFIG_FILE,
  SESSION_FILE,
} = require('../playbig');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return a resolved fetch mock that yields the given JSON body and status. */
function mockFetch(body, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok:     status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text:   () => Promise.resolve(JSON.stringify(body)),
  });
}

/** Return a config object pointing at a test base URL with no token. */
const testConfig = (overrides = {}) => ({
  token:   '',
  baseUrl: 'http://localhost:3000',
  ...overrides,
});

// ── Setup / teardown ──────────────────────────────────────────────────────────

let exitSpy;
let consoleSpy;

beforeEach(() => {
  jest.resetAllMocks();

  // Default fs behaviour: config file does not exist, session file throws ENOENT
  fs.existsSync.mockReturnValue(false);
  fs.readFileSync.mockImplementation((filePath) => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
  fs.writeFileSync.mockImplementation(() => {});
  fs.unlinkSync.mockImplementation(() => {});

  // Silence console output during tests
  consoleSpy = {
    log:   jest.spyOn(console, 'log').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
  jest.spyOn(process.stdout, 'write').mockImplementation(() => {});

  // Prevent process.exit from actually exiting
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

  // Clean env
  delete process.env.PLAYBIG_TOKEN;
  delete process.env.PLAYBIG_URL;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  test('returns defaults when no file and no env vars', () => {
    const cfg = loadConfig();
    expect(cfg.token).toBe('');
    expect(cfg.baseUrl).toBe('http://localhost:3000');
  });

  test('strips trailing slash from baseUrl', () => {
    process.env.PLAYBIG_URL = 'http://myhost:4000/';
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe('http://myhost:4000');
  });

  test('reads bare token from config file', () => {
    fs.existsSync.mockImplementation(p => p === CONFIG_FILE);
    fs.readFileSync.mockImplementation(p => {
      if (p === CONFIG_FILE) return 'pbk_abc123';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const cfg = loadConfig();
    expect(cfg.token).toBe('pbk_abc123');
  });

  test('reads key=value format from config file', () => {
    fs.existsSync.mockImplementation(p => p === CONFIG_FILE);
    fs.readFileSync.mockImplementation(p => {
      if (p === CONFIG_FILE) return 'token=pbk_xyz\nurl=http://remote:9000';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const cfg = loadConfig();
    expect(cfg.token).toBe('pbk_xyz');
    expect(cfg.baseUrl).toBe('http://remote:9000');
  });

  test('skips comment lines in config file', () => {
    fs.existsSync.mockImplementation(p => p === CONFIG_FILE);
    fs.readFileSync.mockImplementation(() => '# comment\ntoken=pbk_ok\n# another');
    const cfg = loadConfig();
    expect(cfg.token).toBe('pbk_ok');
  });

  test('env var PLAYBIG_TOKEN overrides file token', () => {
    process.env.PLAYBIG_TOKEN = 'env_token';
    fs.existsSync.mockImplementation(p => p === CONFIG_FILE);
    fs.readFileSync.mockImplementation(() => 'token=file_token');
    const cfg = loadConfig();
    expect(cfg.token).toBe('env_token');
  });

  test('env var PLAYBIG_URL overrides file url', () => {
    process.env.PLAYBIG_URL = 'http://env-host:1111';
    fs.existsSync.mockImplementation(p => p === CONFIG_FILE);
    fs.readFileSync.mockImplementation(() => 'url=http://file-host:2222');
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe('http://env-host:1111');
  });
});

// ── readSession / writeSession ────────────────────────────────────────────────

describe('readSession', () => {
  test('returns null when session file does not exist', () => {
    expect(readSession()).toBeNull();
  });

  test('returns session id from file', () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-abc\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readSession()).toBe('sess-abc');
  });

  test('returns null for empty session file', () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return '\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readSession()).toBeNull();
  });
});

describe('writeSession', () => {
  test('writes session id to file', () => {
    writeSession('sess-123');
    expect(fs.writeFileSync).toHaveBeenCalledWith(SESSION_FILE, 'sess-123\n', 'utf8');
  });

  test('deletes session file when passed null', () => {
    writeSession(null);
    expect(fs.unlinkSync).toHaveBeenCalledWith(SESSION_FILE);
  });

  test('silently ignores ENOENT when deleting non-existent session file', () => {
    fs.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(() => writeSession(null)).not.toThrow();
  });
});

// ── apiRequest ────────────────────────────────────────────────────────────────

describe('apiRequest', () => {
  test('makes a GET request and returns parsed JSON', async () => {
    mockFetch({ ok: true });
    const cfg = testConfig();
    const res = await apiRequest(cfg, 'GET', '/health');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      expect.objectContaining({ method: 'GET' })
    );
    expect(res).toEqual({ ok: true });
  });

  test('sends Authorization header when token is set', async () => {
    mockFetch({ sessions: [] });
    const cfg = testConfig({ token: 'pbk_test' });
    await apiRequest(cfg, 'GET', '/sessions');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer pbk_test' }),
      })
    );
  });

  test('appends query string parameters', async () => {
    mockFetch({ logs: [] });
    const cfg = testConfig();
    await apiRequest(cfg, 'GET', '/sessions/s1/logs', undefined, { since: '1234', type: 'error' });
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('since=1234');
    expect(calledUrl).toContain('type=error');
  });

  test('sends JSON body on POST', async () => {
    mockFetch({ id: 'new-sess' }, 201);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 201, statusText: 'Created',
      text: () => Promise.resolve(JSON.stringify({ id: 'new-sess' })),
    });
    const cfg = testConfig();
    await apiRequest(cfg, 'POST', '/sessions', { url: 'https://example.com' });
    const opts = global.fetch.mock.calls[0][1];
    expect(JSON.parse(opts.body)).toEqual({ url: 'https://example.com' });
  });

  test('throws with error message on non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      text: () => Promise.resolve(JSON.stringify({ error: 'Session not found' })),
    });
    const cfg = testConfig();
    await expect(apiRequest(cfg, 'GET', '/sessions/bad')).rejects.toThrow('Session not found');
  });

  test('throws a connection error when fetch itself throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const cfg = testConfig();
    await expect(apiRequest(cfg, 'GET', '/health')).rejects.toThrow('Cannot connect to playbig');
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe('start-session', () => {
  test('creates a session and writes the id', async () => {
    mockFetch({ id: 'sess-new', startUrl: 'https://example.com', status: 'active' });
    const cfg = testConfig();
    await COMMANDS['start-session'].run(cfg, ['https://example.com']);
    expect(fs.writeFileSync).toHaveBeenCalledWith(SESSION_FILE, 'sess-new\n', 'utf8');
  });

  test('kills an existing session before creating a new one', async () => {
    // Simulate an existing session
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-old\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1
        ? { id: 'sess-old', ended: true }   // DELETE old session
        : { id: 'sess-new', status: 'active' }; // POST new session
      return Promise.resolve({
        ok: true, status: 200, statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    });

    await COMMANDS['start-session'].run(testConfig(), []);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Second call should be a POST to create new session
    expect(global.fetch.mock.calls[1][1].method).toBe('POST');
  });
});

describe('end-session', () => {
  test('deletes the session and clears the session file', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-abc\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ id: 'sess-abc', ended: true });
    await COMMANDS['end-session'].run(testConfig(), []);
    expect(fs.unlinkSync).toHaveBeenCalledWith(SESSION_FILE);
  });

  test('uses provided session id instead of current session', async () => {
    mockFetch({ id: 'sess-other', ended: true });
    await COMMANDS['end-session'].run(testConfig(), ['sess-other']);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/sessions/sess-other',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

describe('sessions', () => {
  test('prints a list of sessions', async () => {
    mockFetch({
      sessions: [
        { id: 's1', status: 'active', ageMs: 5000, startUrl: 'https://a.com' },
        { id: 's2', status: 'active', ageMs: 10000, startUrl: null },
      ],
    });
    await COMMANDS['sessions'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  test('marks current session with *', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 's1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ sessions: [{ id: 's1', status: 'active', ageMs: 0, startUrl: '' }] });
    await COMMANDS['sessions'].run(testConfig(), []);
    const output = console.log.mock.calls[0][0];
    expect(output).toMatch(/^\*/);
  });

  test('prints a no-sessions message when list is empty', async () => {
    mockFetch({ sessions: [] });
    await COMMANDS['sessions'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledWith('No active sessions.');
  });
});

describe('goto', () => {
  test('throws when url argument is missing', async () => {
    await expect(COMMANDS['goto'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('sends navigate action with the provided url', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { url: 'https://example.com', title: 'Ex' } });
    await COMMANDS['goto'].run(testConfig(), ['https://example.com']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('navigate');
    expect(body.params.url).toBe('https://example.com');
  });
});

describe('click', () => {
  test('throws when selector is missing', async () => {
    await expect(COMMANDS['click'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('sends click action with the selector', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    await COMMANDS['click'].run(testConfig(), ['button#submit']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('click');
    expect(body.params.selector).toBe('button#submit');
  });
});

describe('fill', () => {
  test('throws when selector or value is missing', async () => {
    await expect(COMMANDS['fill'].run(testConfig(), ['#input'])).rejects.toThrow('Usage');
    await expect(COMMANDS['fill'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('sends fill action with selector and value', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    await COMMANDS['fill'].run(testConfig(), ['#email', 'test@example.com']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('fill');
    expect(body.params).toEqual({ selector: '#email', value: 'test@example.com' });
  });
});

describe('screenshot', () => {
  test('saves the screenshot to the specified file', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fakeBase64 = Buffer.from('PNG').toString('base64');
    mockFetch({ ok: true, result: { image: fakeBase64, encoding: 'base64', mimeType: 'image/png' } });
    await COMMANDS['screenshot'].run(testConfig(), ['output.png']);
    expect(fs.writeFileSync).toHaveBeenCalledWith('output.png', expect.any(Buffer));
  });

  test('defaults to screenshot.png when no file is given', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fakeBase64 = Buffer.from('PNG').toString('base64');
    mockFetch({ ok: true, result: { image: fakeBase64, encoding: 'base64', mimeType: 'image/png' } });
    await COMMANDS['screenshot'].run(testConfig(), []);
    expect(fs.writeFileSync).toHaveBeenCalledWith('screenshot.png', expect.any(Buffer));
  });

  test('passes fullPage=true when --full flag is present', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const fakeBase64 = Buffer.from('PNG').toString('base64');
    mockFetch({ ok: true, result: { image: fakeBase64, encoding: 'base64', mimeType: 'image/png' } });
    await COMMANDS['screenshot'].run(testConfig(), ['--full']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.params.fullPage).toBe(true);
  });
});

describe('eval', () => {
  test('throws when code is missing', async () => {
    await expect(COMMANDS['eval'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('sends evaluate action and prints the result', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { result: 42 } });
    await COMMANDS['eval'].run(testConfig(), ['1 + 1']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('evaluate');
    expect(body.params.code).toBe('1 + 1');
  });
});

describe('logs', () => {
  test('passes --since and --type query params', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ logs: [], pageErrors: [] });
    await COMMANDS['logs'].run(testConfig(), ['--since', '1000', '--type', 'error']);
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('since=1000');
    expect(calledUrl).toContain('type=error');
  });

  test('prints "No logs." when both arrays are empty', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ logs: [], pageErrors: [] });
    await COMMANDS['logs'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledWith('No logs.');
  });
});

describe('action', () => {
  test('throws when action name is missing', async () => {
    await expect(COMMANDS['action'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('throws on invalid JSON params', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(COMMANDS['action'].run(testConfig(), ['scroll', 'bad json'])).rejects.toThrow('Invalid JSON');
  });

  test('passes raw action name and params', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    await COMMANDS['action'].run(testConfig(), ['scroll', '{"x":0,"y":500}']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('scroll');
    expect(body.params).toEqual({ x: 0, y: 500 });
  });
});

describe('set-cookies', () => {
  test('throws when no JSON is provided', async () => {
    await expect(COMMANDS['set-cookies'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('throws on invalid JSON', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(COMMANDS['set-cookies'].run(testConfig(), ['{bad}'])).rejects.toThrow('Invalid JSON');
  });

  test('throws when JSON is not an array', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(COMMANDS['set-cookies'].run(testConfig(), ['{"a":1}'])).rejects.toThrow('array');
  });

  test('sends setCookies action with parsed cookies', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    const cookies = [{ name: 'session', value: 'abc', domain: 'example.com' }];
    await COMMANDS['set-cookies'].run(testConfig(), [JSON.stringify(cookies)]);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('setCookies');
    expect(body.params.cookies).toEqual(cookies);
  });
});

describe('network', () => {
  test('passes --url filter query param', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ requests: [], responses: [] });
    await COMMANDS['network'].run(testConfig(), ['--url', 'api/data']);
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('url=api%2Fdata');
  });

  test('prints "No network traffic." when both arrays are empty', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ requests: [], responses: [] });
    await COMMANDS['network'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledWith('No network traffic.');
  });
});

// ── resolveSession ────────────────────────────────────────────────────────────

describe('resolveSession', () => {
  test('returns the session from the file when no config.session', () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'from-file\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(resolveSession(testConfig())).toBe('from-file');
  });

  test('config.session overrides the session file', () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'from-file\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(resolveSession(testConfig({ session: 'override-id' }))).toBe('override-id');
  });

  test('calls process.exit(1) when no session is available', () => {
    expect(() => resolveSession(testConfig())).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ── use ───────────────────────────────────────────────────────────────────────

describe('use', () => {
  test('throws when session id is missing', async () => {
    await expect(COMMANDS['use'].run(testConfig(), [])).rejects.toThrow('Usage');
  });

  test('fetches session info then writes session id', async () => {
    mockFetch({ id: 'sess-xyz', status: 'active' });
    await COMMANDS['use'].run(testConfig(), ['sess-xyz']);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/sessions/sess-xyz',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(SESSION_FILE, 'sess-xyz\n', 'utf8');
  });

  test('throws (propagates API error) when session does not exist', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      text: () => Promise.resolve(JSON.stringify({ error: 'Session not found' })),
    });
    await expect(COMMANDS['use'].run(testConfig(), ['bad-id'])).rejects.toThrow('Session not found');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ── snapshot ──────────────────────────────────────────────────────────────────

describe('snapshot', () => {
  test('sends snapshot action and prints result', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const tree = { role: 'WebArea', name: 'Test', children: [] };
    mockFetch({ ok: true, result: { snapshot: tree } });
    await COMMANDS['snapshot'].run(testConfig(), []);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('snapshot');
  });

  test('passes root selector when provided', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { snapshot: {} } });
    await COMMANDS['snapshot'].run(testConfig(), ['main']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.params.root).toBe('main');
  });
});

// ── resize ────────────────────────────────────────────────────────────────────

describe('resize', () => {
  test('throws when dimensions are missing', async () => {
    await expect(COMMANDS['resize'].run(testConfig(), [])).rejects.toThrow('Usage');
    await expect(COMMANDS['resize'].run(testConfig(), ['1280'])).rejects.toThrow('Usage');
  });

  test('sends resize action with width and height', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    await COMMANDS['resize'].run(testConfig(), ['1280', '720']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('resize');
    expect(body.params).toEqual({ width: 1280, height: 720 });
  });
});

// ── handle-dialog / dialogs ───────────────────────────────────────────────────

describe('handle-dialog', () => {
  test('throws on invalid response value', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(COMMANDS['handle-dialog'].run(testConfig(), ['maybe'])).rejects.toThrow('Usage');
  });

  test('sends handleDialog action with accept by default', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { queued: true } });
    await COMMANDS['handle-dialog'].run(testConfig(), []);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('handleDialog');
    expect(body.params.response).toBe('accept');
  });

  test('sends handleDialog with dismiss and promptText', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { queued: true } });
    await COMMANDS['handle-dialog'].run(testConfig(), ['accept', 'my input']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.params.response).toBe('accept');
    expect(body.params.promptText).toBe('my input');
  });
});

describe('dialogs', () => {
  test('prints "No dialogs recorded." when list is empty', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { dialogs: [] } });
    await COMMANDS['dialogs'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledWith('No dialogs recorded.');
  });

  test('prints dialog history entries', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: { dialogs: [
      { type: 'confirm', message: 'Are you sure?', defaultValue: '', timestamp: 1000000 },
    ]}});
    await COMMANDS['dialogs'].run(testConfig(), []);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log.mock.calls[0][0]).toContain('confirm');
    expect(console.log.mock.calls[0][0]).toContain('Are you sure?');
  });
});

// ── upload-file ───────────────────────────────────────────────────────────────

describe('upload-file', () => {
  test('throws when selector or path is missing', async () => {
    await expect(COMMANDS['upload-file'].run(testConfig(), [])).rejects.toThrow('Usage');
    await expect(COMMANDS['upload-file'].run(testConfig(), ['#f'])).rejects.toThrow('Usage');
  });

  test('throws when the file cannot be read', async () => {
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      // Let all other readFileSync calls throw (simulates missing file)
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });
    await expect(
      COMMANDS['upload-file'].run(testConfig(), ['#input', '/tmp/nonexistent.txt'])
    ).rejects.toThrow('Cannot read file');
  });

  test('reads the file and sends uploadFile action with base64 content', async () => {
    const fileContent = Buffer.from('hello file');
    fs.readFileSync.mockImplementation(p => {
      if (p === SESSION_FILE) return 'sess-1\n';
      if (p === '/tmp/test.txt') return fileContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockFetch({ ok: true, result: {} });
    await COMMANDS['upload-file'].run(testConfig(), ['#file-input', '/tmp/test.txt']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('uploadFile');
    expect(body.params.selector).toBe('#file-input');
    expect(body.params.name).toBe('test.txt');
    expect(body.params.content).toBe(fileContent.toString('base64'));
  });
});

// ── --session flag via main() ─────────────────────────────────────────────────

describe('--session flag', () => {
  test('routes command to the specified session id', async () => {
    mockFetch({ ok: true, result: { url: 'https://example.com', title: 'Ex' } });
    await main(['node', 'playbig', '--session', 'explicit-id', 'goto', 'https://example.com']);
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('/sessions/explicit-id/action');
  });

  test('--session before the command works', async () => {
    mockFetch({ status: 'ok' });
    await main(['node', 'playbig', '--session', 'sess-abc', 'status']);
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('/sessions/sess-abc');
  });
});

// ── main() dispatcher ─────────────────────────────────────────────────────────

describe('main', () => {
  test('prints help when no command is given', async () => {
    await main(['node', 'playbig']);
    expect(console.log).toHaveBeenCalled();
  });

  test('prints help for --help flag', async () => {
    await main(['node', 'playbig', '--help']);
    expect(console.log).toHaveBeenCalled();
  });

  test('calls process.exit(1) for an unknown command', async () => {
    await expect(main(['node', 'playbig', 'nonexistent'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('dispatches to the health command', async () => {
    mockFetch({ status: 'ok', uptimeSec: 42 });
    await main(['node', 'playbig', 'health']);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
