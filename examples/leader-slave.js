/**
 * leader-slave.js
 * Demonstrates: creating multiple sessions via the leader, which distributes
 * them across slaves (or itself) in round-robin.
 *
 * Setup:
 *   Start the leader:
 *     LEADER_MODE=true SLAVE_URLS=http://localhost:3001,http://localhost:3002 PORT=3000 node src/index.js
 *   Start two slaves:
 *     PORT=3001 node src/index.js
 *     PORT=3002 node src/index.js
 *
 * Run this example:
 *   node examples/leader-slave.js
 *
 * The leader response includes an x-playbig-slave header telling you which node
 * owns the session. Use that base URL for subsequent calls to that session.
 */

const LEADER = process.env.PLAYBIG_LEADER || 'http://localhost:3000';

async function createSession(url) {
  const res = await fetch(`${LEADER}/sessions`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ url }),
  });
  const json = await res.json();
  // If the leader forwarded to a slave it sets this header
  const node = res.headers.get('x-playbig-slave') || LEADER;
  return { session: json, node };
}

async function action(base, id, act, params = {}) {
  const res = await fetch(`${base}/sessions/${id}/action`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ action: act, params }),
  });
  return res.json();
}

async function endSession(base, id) {
  await fetch(`${base}/sessions/${id}`, { method: 'DELETE' });
}

async function main() {
  const urls = [
    'https://example.com',
    'https://example.org',
    'https://example.net',
  ];

  const created = [];

  // Create sessions — the leader distributes them in round-robin
  for (const url of urls) {
    const { session, node } = await createSession(url);
    console.log(`Session ${session.id}  →  node: ${node}`);
    created.push({ id: session.id, node });
  }

  // Interact with each session on its owning node
  for (const { id, node } of created) {
    const { result } = await action(node, id, 'title');
    console.log(`  [${id}] title: ${result?.title}`);
  }

  // Check leader health
  const health = await fetch(`${LEADER}/health`).then(r => r.json());
  console.log('\nLeader health:', JSON.stringify(health.mode, null, 2));

  // Clean up
  for (const { id, node } of created) {
    await endSession(node, id);
  }
  console.log('\nAll sessions ended.');
}

main().catch(err => { console.error(err); process.exit(1); });
