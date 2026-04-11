'use strict';

const express        = require('express');
const sessionsRouter = require('./routes/sessions');
const healthRouter   = require('./routes/health');
const keysRouter     = require('./routes/keys');
const mcpRouter      = require('./routes/mcp');
const { monitor }    = require('./monitor');
const { forwarder }  = require('./forwarder');

function createServer() {
  const app = express();

  app.use(express.json({ limit: '10mb' }));

  // ── request logging ────────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.path}\n`);
    next();
  });

  // ── follower routing (transparent proxy to follower nodes) ─────────────────
  // When FOLLOWERS is set, the forwarder intercepts all /sessions requests:
  //   - POST /sessions       → round-robin to a follower or self
  //   - /sessions/:id/...    → routed to the node that owns the session
  // The client only ever needs to talk to this (leader) node.
  // /admin and /mcp are intentionally NOT forwarded — they are leader-local.
  app.use('/sessions', forwarder.middleware());

  // ── routes ─────────────────────────────────────────────────────────────────
  app.use('/sessions',  sessionsRouter);
  app.use('/health',    healthRouter);
  // MCP + key management are leader-local; followers do not mount these.
  app.use('/admin/keys', keysRouter);
  app.use('/mcp',        mcpRouter);

  // ── 404 ────────────────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // ── error handler ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  });

  // ── start watchdog ─────────────────────────────────────────────────────────
  monitor.start();

  return app;
}

module.exports = { createServer };
