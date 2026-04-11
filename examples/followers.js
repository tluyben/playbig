/**
 * followers.js
 * Demonstrates the FOLLOWERS load-distribution feature.
 *
 * Setup — start two followers (plain standalone nodes):
 *   PORT=3001 node src/index.js
 *   PORT=3002 node src/index.js
 *
 * Start the leader (routes sessions to followers + itself):
 *   FOLLOWERS=localhost:3001,localhost:3002 PORT=3000 node src/index.js
 *
 * Run this example (always talk to the leader only):
 *   node examples/followers.js
 *
 * You'll see sessions distributed across the three nodes in round-robin order.
 * The client only needs the leader URL — routing is fully transparent.
 * The x-playbig-node response header shows which node handled each request.
 */

const LEADER = process.env.PLAYBIG_LEADER || 'http://localhost:3000';

async function createSession(url) {
  const res = await fetch(`${LEADER}/sessions`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ url }),
  });
  const json = await res.json();
  const node = res.headers.get('x-playbig-node') || 'self';
  return { session: json, node };
}

async function action(id, act, params = {}) {
  // Always talk to the leader — it routes to the right follower automatically
  const res = await fetch(`${LEADER}/sessions/${id}/action`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ action: act, params }),
  });
  return res.json();
}

async function endSession(id) {
  await fetch(`${LEADER}/sessions/${id}`, { method: 'DELETE' });
}

async function main() {
  const urls = [
    'https://example.com',
    'https://example.org',
    'https://example.net',
  ];

  const created = [];

  console.log('Creating sessions via leader (round-robin across followers + self)…\n');
  for (const url of urls) {
    const { session, node } = await createSession(url);
    console.log(`  Created ${session.id}  →  node: ${node}`);
    created.push(session.id);
  }

  console.log('\nRunning actions (always via leader — routing is transparent)…\n');
  for (const id of created) {
    const { result } = await action(id, 'title');
    console.log(`  [${id.slice(0, 8)}…] title: ${result?.title}`);
  }

  console.log('\nCleaning up…');
  for (const id of created) {
    await endSession(id);
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
