'use strict';

const express        = require('express');
const sessionsRouter = require('./routes/sessions');
const healthRouter   = require('./routes/health');
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

  // ── leader-mode round-robin for new session creation ──────────────────────
  if (process.env.LEADER_MODE === 'true') {
    app.use('/sessions', forwarder.middleware());
  }

  // ── routes ─────────────────────────────────────────────────────────────────
  app.use('/sessions', sessionsRouter);
  app.use('/health',   healthRouter);

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
