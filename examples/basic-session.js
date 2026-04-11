/**
 * basic-session.js
 * Demonstrates: create a session, navigate, interact, take a screenshot, end it.
 *
 * Run: node examples/basic-session.js
 */

const BASE = process.env.PLAYBIG_URL || 'http://localhost:3000';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function action(sessionId, action, params = {}) {
  return request('POST', `/sessions/${sessionId}/action`, { action, params });
}

async function main() {
  // 1. Create a session starting on example.com
  const session = await request('POST', '/sessions', { url: 'https://example.com' });
  const id = session.id;
  console.log('Session created:', id);

  // 2. Read the page title
  const { result: titleResult } = await action(id, 'title');
  console.log('Title:', titleResult.title);

  // 3. Evaluate arbitrary JS in the browser
  const { result: evalResult } = await action(id, 'evaluate', {
    code: `() => ({ h1: document.querySelector('h1').innerText, links: document.querySelectorAll('a').length })`,
  });
  console.log('Page info:', evalResult);

  // 4. Navigate to another page
  await action(id, 'navigate', { url: 'https://example.com' });

  // 5. Take a screenshot (base64 PNG)
  const { result: ss } = await action(id, 'screenshot', { fullPage: true });
  const fs = require('fs');
  fs.writeFileSync('/tmp/playbig-example.png', Buffer.from(ss.image, 'base64'));
  console.log('Screenshot saved to /tmp/playbig-example.png');

  // 6. Read current URL
  const { result: urlResult } = await action(id, 'url');
  console.log('Current URL:', urlResult.url);

  // 7. End the session (kills the browser)
  await request('DELETE', `/sessions/${id}`);
  console.log('Session ended.');
}

main().catch(err => { console.error(err); process.exit(1); });
