'use strict';

const express = require('express');
const { sessionManager } = require('../session-manager');
const { monitor }        = require('../monitor');
const { forwarder }      = require('../forwarder');

const router = express.Router();

router.get('/', (req, res) => {
  const isLeader = process.env.LEADER_MODE === 'true';
  res.json({
    status:   'ok',
    uptimeSec: Math.floor(process.uptime()),
    memory:    process.memoryUsage(),
    sessions: {
      count: sessionManager.sessions.size,
      list:  sessionManager.listSessions(),
    },
    monitor: monitor.status(),
    mode:    isLeader ? forwarder.status() : { mode: 'standalone' },
  });
});

module.exports = router;
