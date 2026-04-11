'use strict';

// ── Remote MCP server (streamable-HTTP transport) ─────────────────────────────
//
// Implements the Model Context Protocol over HTTP/JSON-RPC 2.0.
// Compatible with Claude Code, Codex CLI, opencode, and any MCP client that
// supports the streamable-HTTP transport.
//
// Auth: every POST request must carry  Authorization: Bearer <access_key>
// Keys are managed via the /admin/keys endpoints.
//
// Endpoint: POST /mcp

const express = require('express');
const { sessionManager } = require('../session-manager');
const { validateKey }    = require('../db');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

function mcpAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const key  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key || !validateKey(key)) {
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized: invalid or missing access key'));
  }
  next();
}

// ── Tool catalogue ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'browser_create_session',
    description:
      'Create a new isolated Playwright/Chromium browser session. ' +
      'Returns the session ID, which is required for all subsequent browser_* calls. ' +
      'Always end the session with browser_delete_session when done.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to navigate to immediately after creating the session.'
        },
        options: {
          type: 'object',
          description: 'Optional creation options.',
          properties: {
            waitUntil: {
              type: 'string',
              enum: ['domcontentloaded', 'load', 'networkidle'],
              description: 'Navigation wait condition (default: domcontentloaded).'
            },
            timeout: {
              type: 'number',
              description: 'Navigation timeout in ms (default: 30000).'
            }
          }
        }
      }
    }
  },
  {
    name: 'browser_list_sessions',
    description: 'List all active browser sessions with their status and metadata.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_get_session',
    description: 'Get current status and metadata for a specific browser session.',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Session ID from browser_create_session.' }
      }
    }
  },
  {
    name: 'browser_delete_session',
    description: 'End a browser session and terminate the underlying browser process. Always call this when finished.',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Session ID to end.' }
      }
    }
  },
  {
    name: 'browser_run_action',
    description: [
      'Run a Playwright browser action on an existing session.',
      '',
      'Key actions and their params:',
      '  navigate        {url, waitUntil?, timeout?}          — go to a URL',
      '  reload          {}                                   — reload the current page',
      '  back / forward  {}                                   — browser history navigation',
      '  url             {}                                   — get current URL',
      '  title           {}                                   — get page title',
      '  content         {}                                   — get full page HTML',
      '  click           {selector, timeout?}                 — click an element',
      '  dblclick        {selector, timeout?}                 — double-click',
      '  fill            {selector, value}                    — fill an input field',
      '  type            {selector, text, delay?}             — type text char by char',
      '  pressKey        {key}                                — press a key (e.g. "Enter")',
      '  hover           {selector}                           — hover over element',
      '  select          {selector, value}                    — select option(s)',
      '  check/uncheck   {selector}                           — checkbox/radio',
      '  focus           {selector}                           — focus element',
      '  waitForSelector {selector, state?, timeout?}         — wait for element',
      '  waitForTimeout  {ms}                                 — pause (max 60 000 ms)',
      '  waitForLoadState {state?}                            — wait for load/networkidle',
      '  getAttribute    {selector, attribute}                — get attribute value',
      '  innerText       {selector}                           — get visible text',
      '  innerHTML       {selector}                           — get raw HTML',
      '  inputValue      {selector}                           — get input value',
      '  isVisible       {selector}                           — check visibility',
      '  isEnabled       {selector}                           — check enabled state',
      '  isChecked       {selector}                           — check checked state',
      '  count           {selector}                           — count matching elements',
      '  setViewport     {width, height}                      — resize viewport',
      '  scroll          {x, y}                              — scroll to position',
      '  cookies         {}                                   — get all cookies',
      '  setCookies      {cookies: [...]}                     — add cookies',
      '  clearCookies    {}                                   — clear all cookies',
      '  screenshot      {fullPage?, type?}                   — capture screenshot (returns image)',
      '  pdf             {options?}                           — generate PDF',
      '  evaluate        {code}                               — run JS in browser context',
      '  exec            {code}                               — run async server-side code with page/context/browser',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      required: ['session_id', 'action'],
      properties: {
        session_id: { type: 'string', description: 'Session ID.' },
        action:     { type: 'string', description: 'Action name (see description).' },
        params:     { type: 'object', description: 'Action-specific parameters.' }
      }
    }
  },
  {
    name: 'browser_get_logs',
    description:
      'Get console logs and uncaught page errors recorded in a browser session. ' +
      'Use the `since` filter to poll for new entries.',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        since: {
          type: 'number',
          description: 'Unix timestamp in ms — only return entries newer than this.'
        },
        type: {
          type: 'string',
          description: 'Filter by log type: log, warn, error, info, debug, etc.'
        }
      }
    }
  },
  {
    name: 'browser_get_network',
    description:
      'Get network requests and responses captured in a browser session. ' +
      'Includes timing, headers, and response bodies (text/JSON up to configured limit).',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string' },
        since: {
          type: 'number',
          description: 'Unix timestamp in ms — only return entries newer than this.'
        },
        url: {
          type: 'string',
          description: 'Filter by URL substring.'
        }
      }
    }
  }
];

// ── Tool implementations ──────────────────────────────────────────────────────

function textResult(str) {
  return { content: [{ type: 'text', text: str }] };
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

async function callTool(name, args) {
  switch (name) {

    case 'browser_create_session': {
      const id = await sessionManager.createSession({ url: args.url, options: args.options });
      const s  = sessionManager.getSession(id);
      return textResult(JSON.stringify(sessionManager.sessionInfo(s), null, 2));
    }

    case 'browser_list_sessions':
      return textResult(JSON.stringify({ sessions: sessionManager.listSessions() }, null, 2));

    case 'browser_get_session': {
      const s = sessionManager.getSession(args.session_id);
      if (!s) return errorResult(`Session not found: ${args.session_id}`);
      return textResult(JSON.stringify(sessionManager.sessionInfo(s), null, 2));
    }

    case 'browser_delete_session': {
      try {
        const result = await sessionManager.endSession(args.session_id);
        return textResult(JSON.stringify(result));
      } catch (err) {
        return errorResult(err.message);
      }
    }

    case 'browser_run_action': {
      try {
        const result = await sessionManager.runAction(
          args.session_id,
          args.action,
          args.params || {}
        );
        // Return screenshots as image content so clients can display them
        if (args.action === 'screenshot' && result.image) {
          return {
            content: [
              { type: 'image', data: result.image, mimeType: result.mimeType || 'image/png' }
            ]
          };
        }
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(err.message);
      }
    }

    case 'browser_get_logs': {
      const s = sessionManager.getSession(args.session_id);
      if (!s) return errorResult(`Session not found: ${args.session_id}`);
      let logs   = s.consoleLogs;
      let errors = s.pageErrors;
      if (args.since) {
        logs   = logs.filter(l => l.timestamp > args.since);
        errors = errors.filter(e => e.timestamp > args.since);
      }
      if (args.type) {
        logs = logs.filter(l => l.type === args.type);
      }
      return textResult(JSON.stringify({ logs, pageErrors: errors }, null, 2));
    }

    case 'browser_get_network': {
      const s = sessionManager.getSession(args.session_id);
      if (!s) return errorResult(`Session not found: ${args.session_id}`);
      let requests  = s.networkRequests;
      let responses = s.networkResponses;
      if (args.since) {
        requests  = requests.filter(r => r.timestamp > args.since);
        responses = responses.filter(r => r.timestamp > args.since);
      }
      if (args.url) {
        const needle = args.url;
        requests  = requests.filter(r => r.url.includes(needle));
        responses = responses.filter(r => r.url.includes(needle));
      }
      return textResult(JSON.stringify({ requests, responses }, null, 2));
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// ── JSON-RPC 2.0 dispatcher ───────────────────────────────────────────────────

const ACCEPTED_VERSIONS = new Set(['2024-11-05', '2025-03-26']);

async function handleMethod(method, params) {
  switch (method) {

    case 'initialize': {
      const requested = params?.protocolVersion || '2024-11-05';
      const version   = ACCEPTED_VERSIONS.has(requested) ? requested : '2024-11-05';
      return {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'playbig', version: require('../../package.json').version }
      };
    }

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!name) throw Object.assign(new Error('Missing tool name'), { code: -32602 });
      return callTool(name, args || {});
    }

    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleSingle(item) {
  if (!item || typeof item !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }

  const { jsonrpc, id, method, params } = item;

  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }

  // JSON-RPC notifications: request objects with no "id" key — do not reply
  const isNotification = !('id' in item);

  try {
    const result = await handleMethod(method, params);
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, err.code || -32603, err.message || 'Internal error');
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /mcp — discovery / connectivity probe (no auth required)
router.get('/', (_req, res) => {
  res.json({
    name:      'playbig',
    version:   require('../../package.json').version,
    transport: 'streamable-http',
    endpoint:  'POST /mcp',
    auth:      'Authorization: Bearer <access_key>',
    note:      'Use POST with JSON-RPC 2.0 bodies. Obtain an access key via POST /admin/keys.'
  });
});

// POST /mcp — MCP JSON-RPC 2.0 entry point
router.post('/', mcpAuth, async (req, res, next) => {
  try {
    const body = req.body;

    // Batch requests
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map(handleSingle));
      const replies = results.filter(r => r !== null);
      if (replies.length === 0) return res.status(202).end();
      return res.json(replies);
    }

    const result = await handleSingle(body);
    if (result === null) return res.status(202).end(); // notification — no response
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
// Exported for unit testing
module.exports._handleSingle  = handleSingle;
module.exports._handleMethod  = handleMethod;
module.exports.TOOLS          = TOOLS;
