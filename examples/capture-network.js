/**
 * capture-network.js
 * Demonstrates: capturing network requests and responses during a navigation.
 *
 * Run: node examples/capture-network.js
 */

const BASE = process.env.PLAYBIG_URL || 'http://localhost:3000';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function action(id, act, params = {}) {
  return request('POST', `/sessions/${id}/action`, { action: act, params });
}

async function main() {
  // Start a session with no initial URL
  const session = await request('POST', '/sessions', {});
  const id = session.id;
  console.log('Session:', id);

  // Navigate — all network traffic will be captured
  await action(id, 'navigate', { url: 'https://httpbin.org/get' });
  await action(id, 'waitForLoadState', { state: 'networkidle' });

  // Fetch captured network data
  const { requests, responses } = await request('GET', `/sessions/${id}/network`);
  console.log(`\nCaptured ${requests.length} requests, ${responses.length} responses\n`);

  // Show requests
  for (const req of requests) {
    console.log(`  → ${req.method} ${req.url}`);
  }

  // Show responses
  for (const resp of responses) {
    console.log(`  ← ${resp.status} ${resp.url}`);
    if (resp.body) {
      try {
        const parsed = JSON.parse(resp.body);
        console.log('    body:', JSON.stringify(parsed, null, 2).slice(0, 300));
      } catch {}
    }
  }

  // Filter by URL substring
  const { requests: apiRequests } = await request('GET', `/sessions/${id}/network?url=httpbin`);
  console.log(`\nRequests matching "httpbin": ${apiRequests.length}`);

  // Clear network log
  await request('DELETE', `/sessions/${id}/network`);
  console.log('Network log cleared.');

  // Make another request and capture only the new traffic
  const since = Date.now();
  await action(id, 'navigate', { url: 'https://httpbin.org/user-agent' });

  const { requests: newReqs } = await request('GET', `/sessions/${id}/network?since=${since}`);
  console.log(`\nNew requests after clear: ${newReqs.length}`);
  newReqs.forEach(r => console.log(' ', r.method, r.url));

  await request('DELETE', `/sessions/${id}`);
  console.log('\nSession ended.');
}

main().catch(err => { console.error(err); process.exit(1); });
