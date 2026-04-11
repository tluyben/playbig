/**
 * console-logs.js
 * Demonstrates: capturing browser console output and page errors.
 *
 * Run: node examples/console-logs.js
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
  const session = await request('POST', '/sessions', { url: 'about:blank' });
  const id = session.id;
  console.log('Session:', id);

  // Inject console output into the page
  await action(id, 'evaluate', {
    code: `() => {
      console.log('hello from the browser');
      console.warn('this is a warning');
      console.error('this is an error');
      console.info('some info', { key: 'value' });
      // Trigger a page error
      setTimeout(() => { throw new Error('deliberate page error'); }, 100);
    }`,
  });

  // Give the error a moment to fire
  await action(id, 'waitForTimeout', { ms: 300 });

  // Retrieve all logs
  const { logs, pageErrors } = await request('GET', `/sessions/${id}/logs`);
  console.log(`\nConsole logs (${logs.length}):`);
  logs.forEach(l => console.log(`  [${l.type}] ${l.text}`));

  console.log(`\nPage errors (${pageErrors.length}):`);
  pageErrors.forEach(e => console.log(' ', e.message));

  // Filter by type
  const { logs: errLogs } = await request('GET', `/sessions/${id}/logs?type=error`);
  console.log(`\nError-only logs: ${errLogs.length}`);

  // Poll for new logs since a timestamp
  const since = Date.now();
  await action(id, 'evaluate', {
    code: `() => console.log('new message after polling started')`,
  });

  const { logs: newLogs } = await request('GET', `/sessions/${id}/logs?since=${since}`);
  console.log(`\nNew logs since polling start: ${newLogs.length}`);
  newLogs.forEach(l => console.log(`  [${l.type}] ${l.text}`));

  // Use exec to run server-side Playwright code that emits to console
  await action(id, 'exec', {
    code: `
      await page.evaluate(() => console.log('exec example: server-side playwright code'));
      const title = await page.title();
      return { title };
    `,
  });

  const { logs: allLogs } = await request('GET', `/sessions/${id}/logs`);
  console.log(`\nTotal console logs captured: ${allLogs.length}`);

  await request('DELETE', `/sessions/${id}`);
  console.log('\nSession ended.');
}

main().catch(err => { console.error(err); process.exit(1); });
