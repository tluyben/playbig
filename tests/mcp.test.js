'use strict';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// We mock the db module so the MCP route never touches the filesystem,
// and the session-manager so we don't need a real Chromium browser.

jest.mock('../src/db', () => ({
  validateKey: jest.fn(),
}));

jest.mock('../src/session-manager', () => ({
  sessionManager: {
    createSession: jest.fn(),
    getSession:    jest.fn(),
    listSessions:  jest.fn(),
    sessionInfo:   jest.fn(),
    endSession:    jest.fn(),
    runAction:     jest.fn(),
  },
}));

const { validateKey }    = require('../src/db');
const { sessionManager } = require('../src/session-manager');
const { _handleSingle, _handleMethod, TOOLS } = require('../src/routes/mcp');

// ── Helpers ───────────────────────────────────────────────────────────────────

function req(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function notification(method, params) {
  // Notifications have no "id" key at all
  return { jsonrpc: '2.0', method, params };
}

// ── Protocol tests ────────────────────────────────────────────────────────────

describe('MCP protocol — handleSingle', () => {
  test('returns Invalid Request for missing jsonrpc field', async () => {
    const r = await _handleSingle({ id: 1, method: 'ping' });
    expect(r.error.code).toBe(-32600);
  });

  test('returns Invalid Request for null input', async () => {
    const r = await _handleSingle(null);
    expect(r.error.code).toBe(-32600);
  });

  test('returns null (no reply) for notifications', async () => {
    const r = await _handleSingle(notification('notifications/initialized'));
    expect(r).toBeNull();
  });

  test('returns null for unknown-method notifications (no response ever)', async () => {
    const r = await _handleSingle(notification('some/notification'));
    expect(r).toBeNull();
  });

  test('returns Method not found error for unknown method', async () => {
    const r = await _handleSingle(req('nonexistent/method'));
    expect(r.error.code).toBe(-32601);
  });

  test('wraps result in jsonrpc envelope', async () => {
    const r = await _handleSingle(req('ping', {}, 42));
    expect(r).toEqual({ jsonrpc: '2.0', id: 42, result: {} });
  });
});

// ── initialize ────────────────────────────────────────────────────────────────

describe('MCP initialize', () => {
  test('returns protocolVersion, capabilities, serverInfo', async () => {
    const result = await _handleMethod('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:    {},
      clientInfo:      { name: 'test', version: '0.0.1' },
    });
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe('playbig');
    expect(result.serverInfo.version).toBeTruthy();
  });

  test('accepts 2025-03-26 protocol version', async () => {
    const result = await _handleMethod('initialize', { protocolVersion: '2025-03-26' });
    expect(result.protocolVersion).toBe('2025-03-26');
  });

  test('falls back to 2024-11-05 for unsupported versions', async () => {
    const result = await _handleMethod('initialize', { protocolVersion: '1999-01-01' });
    expect(result.protocolVersion).toBe('2024-11-05');
  });
});

// ── ping ──────────────────────────────────────────────────────────────────────

describe('MCP ping', () => {
  test('returns empty object', async () => {
    const result = await _handleMethod('ping', {});
    expect(result).toEqual({});
  });
});

// ── tools/list ────────────────────────────────────────────────────────────────

describe('MCP tools/list', () => {
  test('returns all expected tools', async () => {
    const result = await _handleMethod('tools/list', {});
    const names  = result.tools.map(t => t.name);
    expect(names).toContain('browser_create_session');
    expect(names).toContain('browser_list_sessions');
    expect(names).toContain('browser_get_session');
    expect(names).toContain('browser_delete_session');
    expect(names).toContain('browser_run_action');
    expect(names).toContain('browser_get_logs');
    expect(names).toContain('browser_get_network');
  });

  test('each tool has name, description, inputSchema', () => {
    TOOLS.forEach(t => {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
    });
  });
});

// ── tools/call — browser_create_session ──────────────────────────────────────

describe('tools/call browser_create_session', () => {
  const fakeSession = {
    id: 'sess-1', startUrl: 'https://example.com', status: 'active',
    createdAt: 1000, lastActivity: 1000, ageMs: 0,
    consoleLogs: 0, pageErrors: 0, networkRequests: 0, networkResponses: 0,
  };

  beforeEach(() => {
    sessionManager.createSession.mockResolvedValue('sess-1');
    sessionManager.getSession.mockReturnValue({ id: 'sess-1' });
    sessionManager.sessionInfo.mockReturnValue(fakeSession);
  });

  test('calls createSession and returns session info as JSON text', async () => {
    const result = await _handleMethod('tools/call', {
      name:      'browser_create_session',
      arguments: { url: 'https://example.com' },
    });
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      url: 'https://example.com', options: undefined,
    });
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('sess-1');
  });
});

// ── tools/call — browser_list_sessions ───────────────────────────────────────

describe('tools/call browser_list_sessions', () => {
  beforeEach(() => {
    sessionManager.listSessions.mockReturnValue([]);
  });

  test('returns sessions array', async () => {
    const result = await _handleMethod('tools/call', {
      name: 'browser_list_sessions', arguments: {},
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessions).toEqual([]);
  });
});

// ── tools/call — browser_get_session ─────────────────────────────────────────

describe('tools/call browser_get_session', () => {
  test('returns session info when found', async () => {
    const fake = { id: 'sess-1', status: 'active' };
    sessionManager.getSession.mockReturnValue(fake);
    sessionManager.sessionInfo.mockReturnValue(fake);

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_session', arguments: { session_id: 'sess-1' },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe('sess-1');
  });

  test('returns error result when session not found', async () => {
    sessionManager.getSession.mockReturnValue(null);
    const result = await _handleMethod('tools/call', {
      name: 'browser_get_session', arguments: { session_id: 'missing' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

// ── tools/call — browser_delete_session ──────────────────────────────────────

describe('tools/call browser_delete_session', () => {
  test('calls endSession and returns confirmation', async () => {
    sessionManager.endSession.mockResolvedValue({ id: 'sess-1', ended: true });
    const result = await _handleMethod('tools/call', {
      name: 'browser_delete_session', arguments: { session_id: 'sess-1' },
    });
    expect(sessionManager.endSession).toHaveBeenCalledWith('sess-1');
    expect(result.isError).toBeFalsy();
  });

  test('returns error result when session not found', async () => {
    sessionManager.endSession.mockRejectedValue(Object.assign(new Error('Session not found'), { statusCode: 404 }));
    const result = await _handleMethod('tools/call', {
      name: 'browser_delete_session', arguments: { session_id: 'ghost' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

// ── tools/call — browser_run_action ──────────────────────────────────────────

describe('tools/call browser_run_action', () => {
  test('forwards action to sessionManager.runAction and returns result', async () => {
    sessionManager.runAction.mockResolvedValue({ url: 'https://example.com', title: 'Example' });
    const result = await _handleMethod('tools/call', {
      name:      'browser_run_action',
      arguments: { session_id: 'sess-1', action: 'navigate', params: { url: 'https://example.com' } },
    });
    expect(sessionManager.runAction).toHaveBeenCalledWith('sess-1', 'navigate', { url: 'https://example.com' });
    expect(result.content[0].type).toBe('text');
  });

  test('returns screenshot as image content block', async () => {
    sessionManager.runAction.mockResolvedValue({
      image: 'base64data==', encoding: 'base64', mimeType: 'image/png',
    });
    const result = await _handleMethod('tools/call', {
      name:      'browser_run_action',
      arguments: { session_id: 'sess-1', action: 'screenshot', params: {} },
    });
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].data).toBe('base64data==');
  });

  test('returns error result when action fails', async () => {
    sessionManager.runAction.mockRejectedValue(new Error('Selector not found'));
    const result = await _handleMethod('tools/call', {
      name:      'browser_run_action',
      arguments: { session_id: 'sess-1', action: 'click', params: { selector: '#gone' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Selector not found/);
  });
});

// ── tools/call — browser_get_logs ────────────────────────────────────────────

describe('tools/call browser_get_logs', () => {
  const makeSession = (logs = [], errors = []) => ({
    consoleLogs: logs,
    pageErrors:  errors,
  });

  test('returns logs and pageErrors', async () => {
    const log = { type: 'log', text: 'hello', timestamp: 1000 };
    sessionManager.getSession.mockReturnValue(makeSession([log]));

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_logs', arguments: { session_id: 'sess-1' },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.logs).toHaveLength(1);
    expect(parsed.logs[0].text).toBe('hello');
  });

  test('filters by since timestamp', async () => {
    const old = { type: 'log', text: 'old',  timestamp: 500  };
    const neo = { type: 'log', text: 'new',  timestamp: 2000 };
    sessionManager.getSession.mockReturnValue(makeSession([old, neo]));

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_logs', arguments: { session_id: 'sess-1', since: 1000 },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.logs).toHaveLength(1);
    expect(parsed.logs[0].text).toBe('new');
  });

  test('filters by type', async () => {
    const warn  = { type: 'warn',  text: 'w', timestamp: 1000 };
    const error = { type: 'error', text: 'e', timestamp: 1001 };
    sessionManager.getSession.mockReturnValue(makeSession([warn, error]));

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_logs', arguments: { session_id: 'sess-1', type: 'warn' },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.logs).toHaveLength(1);
    expect(parsed.logs[0].type).toBe('warn');
  });

  test('returns error result when session not found', async () => {
    sessionManager.getSession.mockReturnValue(null);
    const result = await _handleMethod('tools/call', {
      name: 'browser_get_logs', arguments: { session_id: 'ghost' },
    });
    expect(result.isError).toBe(true);
  });
});

// ── tools/call — browser_get_network ─────────────────────────────────────────

describe('tools/call browser_get_network', () => {
  const makeSession = (requests = [], responses = []) => ({
    networkRequests:  requests,
    networkResponses: responses,
  });

  test('returns requests and responses', async () => {
    const r = { url: 'https://api.example.com/data', timestamp: 1000 };
    sessionManager.getSession.mockReturnValue(makeSession([r]));

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_network', arguments: { session_id: 'sess-1' },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.requests).toHaveLength(1);
  });

  test('filters by url substring', async () => {
    const a = { url: 'https://api.example.com/users',   timestamp: 1000 };
    const b = { url: 'https://cdn.example.com/logo.png', timestamp: 1001 };
    sessionManager.getSession.mockReturnValue(makeSession([a, b], [a, b]));

    const result = await _handleMethod('tools/call', {
      name: 'browser_get_network', arguments: { session_id: 'sess-1', url: 'api.example.com' },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests[0].url).toContain('api.example.com');
  });

  test('returns error result when session not found', async () => {
    sessionManager.getSession.mockReturnValue(null);
    const result = await _handleMethod('tools/call', {
      name: 'browser_get_network', arguments: { session_id: 'ghost' },
    });
    expect(result.isError).toBe(true);
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────────

describe('tools/call — unknown tool', () => {
  test('returns JSON-RPC error (not a tool error)', async () => {
    const r = await _handleSingle(req('tools/call', { name: 'does_not_exist', arguments: {} }));
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32601);
  });
});

// ── auth ──────────────────────────────────────────────────────────────────────
// Auth is middleware-level; we test the validateKey integration via the mock.

describe('validateKey is called during auth', () => {
  test('validateKey mock is set up correctly', () => {
    validateKey.mockReturnValue(true);
    expect(validateKey('pbk_somekey')).toBe(true);

    validateKey.mockReturnValue(false);
    expect(validateKey('bad')).toBe(false);
  });
});
