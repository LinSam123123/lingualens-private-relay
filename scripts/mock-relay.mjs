import http from 'node:http';
import assert from 'node:assert/strict';

const selfTest = process.argv.includes('--self-test');
const port = Number(process.env.PORT || (selfTest ? 0 : 17891));
const rateLimits = new Map();
const requestCounts = new Map();

const fixturePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LinguaLens Manual Fixture</title></head>
<body>
  <main>
    <h1>Private relay translation fixture</h1>
    <p id="plain">This paragraph should be translated as one stable text node.</p>
    <p id="format">Keep this <a href="#destination">working link</a> and this <strong>bold phrase</strong> intact.</p>
    <pre id="code">const untranslated = "code block";</pre>
    <label>Input stays unchanged <input id="input" value="Do not translate this input"></label>
    <div id="editable" contenteditable="true">Do not translate editable text</div>
    <p id="destination">The final paragraph verifies restore original behavior.</p>
  </main>
</body>
</html>`;

const longFixtureParagraphs = Array.from({ length: 16 }, (_, index) => `
    <p id="long-${index + 1}">Batch ${index + 1}: This deliberately repetitive paragraph supplies enough stable text for manual scheduler validation. It lets the tester pause while some requests are active and other batches remain queued, then resume without replaying completed or unknown work. The paragraph stays independent so translation progress can be counted directly.</p>`).join('');

const credentialProbePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LinguaLens Credential Isolation Probe</title></head>
<body>
  <main>
    <h1>Page-origin IndexedDB probe</h1>
    <p>This page origin is not moz-extension. Opening the extension credential database name here must not reveal the API key.</p>
    <pre id="origin"></pre>
    <pre id="result">running…</pre>
  </main>
  <script>
    const DB_NAME = 'lingualens-private-credentials';
    const originEl = document.getElementById('origin');
    const resultEl = document.getElementById('result');
    originEl.textContent = location.origin;
    Promise.resolve()
      .then(async () => {
        const listed = typeof indexedDB.databases === 'function'
          ? await indexedDB.databases()
          : [];
        const request = indexedDB.open(DB_NAME, 1);
        const db = await new Promise((resolve, reject) => {
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('secrets')) {
              request.result.createObjectStore('secrets', { keyPath: 'id' });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const names = Array.from(db.objectStoreNames);
        let relayApiKey = null;
        if (names.includes('secrets')) {
          relayApiKey = await new Promise((resolve, reject) => {
            const tx = db.transaction('secrets', 'readonly');
            const get = tx.objectStore('secrets').get('relayApiKey');
            get.onsuccess = () => resolve(get.result ?? null);
            get.onerror = () => reject(get.error);
          });
        }
        db.close();
        resultEl.textContent = JSON.stringify({
          pageOrigin: location.origin,
          isMozExtension: location.origin.startsWith('moz-extension://'),
          listedDatabaseNames: listed.map((entry) => entry?.name),
          openedDatabase: DB_NAME,
          objectStores: names,
          relayApiKeyRecord: relayApiKey,
        }, null, 2);
      })
      .catch((error) => {
        resultEl.textContent = String(error);
      });
  </script>
</body>
</html>`;

const longFixturePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LinguaLens Multi-batch Fixture</title></head>
<body>
  <main>
    <h1>Private relay multi-batch fixture</h1>${longFixtureParagraphs}
  </main>
</body>
</html>`;

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function translatedItems(body) {
  const messages = body.messages;
  const input = Array.isArray(messages)
    ? messages.at(-1)?.content
    : body.input;
  const text = typeof input === 'string'
    ? input
    : Array.isArray(input) ? input.map((item) => item?.content?.[0]?.text ?? '').join('\n') : '';
  const match = text.match(/\{[\s\S]*"items"[\s\S]*\}/);
  const items = match ? JSON.parse(match[0]).items : [];
  return items.map((item) => ({ id: item.id, text: `[translated] ${item.text}` }));
}

function success(response, protocol, body) {
  const content = JSON.stringify({ items: translatedItems(body) });
  if (protocol === 'responses') json(response, 200, { output_text: content });
  else json(response, 200, { choices: [{ message: { content } }] });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const scenario = parts[0] || 'ok';
  const endpoint = parts.slice(2).join('/');

  if (url.pathname === '/metrics') {
    json(response, 200, { requests: Object.fromEntries(requestCounts) });
    return;
  }
  if (url.pathname === '/reset' && request.method === 'POST') {
    requestCounts.clear();
    rateLimits.clear();
    json(response, 200, { reset: true });
    return;
  }
  requestCounts.set(scenario, (requestCounts.get(scenario) || 0) + 1);
  const endpointKey = `${scenario}:${endpoint || request.method || 'root'}`;
  requestCounts.set(endpointKey, (requestCounts.get(endpointKey) || 0) + 1);

  if (url.pathname === '/fixture') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixturePage);
    return;
  }
  if (url.pathname === '/fixture-long') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(longFixturePage);
    return;
  }
  if (url.pathname === '/credential-probe') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(credentialProbePage);
    return;
  }

  if (scenario === 'redirect') {
    response.writeHead(307, { Location: `/ok/v1/${endpoint}` });
    response.end();
    return;
  }
  if (scenario === 'disconnect') {
    request.socket.destroy();
    return;
  }
  if (scenario === 'header-rejected') {
    json(response, 400, { error: 'X-Translation-Request-Id is not allowed' });
    return;
  }
  if (scenario === 'gateway') {
    json(response, 503, { error: 'mock upstream unavailable' });
    return;
  }
  if (scenario === 'timeout') {
    const timer = setTimeout(() => json(response, 200, { data: [] }), 30_000);
    timer.unref();
    return;
  }
  if (endpoint === 'models') {
    json(response, 200, { data: [{ id: 'mock-model' }] });
    return;
  }

  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const requestId = request.headers['x-translation-request-id'] || 'missing';
    if (scenario === 'rate-limit') {
      const attempts = rateLimits.get(requestId) || 0;
      rateLimits.set(requestId, attempts + 1);
      if (attempts < 2) {
        json(response, 429, { error: 'mock rate limit' }, { 'Retry-After': '0' });
        return;
      }
    }
    let body;
    try { body = JSON.parse(raw); } catch { json(response, 400, { error: 'invalid JSON' }); return; }
    if (scenario === 'slow') {
      const timer = setTimeout(() => success(response, endpoint === 'responses' ? 'responses' : 'chat-completions', body), 1_500);
      timer.unref();
      return;
    }
    success(response, endpoint === 'responses' ? 'responses' : 'chat-completions', body);
  });
});

server.listen(port, '127.0.0.1', async () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : port;
  console.log(`Mock relay listening on http://127.0.0.1:${activePort}/ok/v1`);
  console.log('Scenarios: ok, slow, redirect, rate-limit, gateway, header-rejected, timeout, disconnect');
  if (!selfTest) return;

  const base = `http://127.0.0.1:${activePort}`;
  const headers = { 'Content-Type': 'application/json', 'X-Translation-Request-Id': 'self-test-id' };
  const input = JSON.stringify({ target_language: 'zh-CN', items: [{ id: 'item-1', text: 'hello' }] });
  try {
    const models = await (await fetch(`${base}/ok/v1/models`)).json();
    assert.equal(models.data[0].id, 'mock-model');
    const longFixture = await (await fetch(`${base}/fixture-long`)).text();
    assert.match(longFixture, /Batch 16:/);
    const probe = await (await fetch(`${base}/credential-probe`)).text();
    assert.match(probe, /Page-origin IndexedDB probe/);

    const chat = await (await fetch(`${base}/ok/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: input }] }),
    })).json();
    assert.match(chat.choices[0].message.content, /item-1/);

    const responses = await (await fetch(`${base}/ok/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ input }),
    })).json();
    assert.match(responses.output_text, /item-1/);

    const slow = await (await fetch(`${base}/slow/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ input }),
    })).json();
    assert.match(slow.output_text, /item-1/);

    const redirect = await fetch(`${base}/redirect/v1/models`, { redirect: 'manual' });
    assert.equal(redirect.status, 307);
    const gateway = await fetch(`${base}/gateway/v1/models`);
    assert.equal(gateway.status, 503);
    const rejected = await fetch(`${base}/header-rejected/v1/models`);
    assert.equal(rejected.status, 400);

    const rateStatuses = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      rateStatuses.push((await fetch(`${base}/rate-limit/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: input }] }),
      })).status);
    }
    assert.deepEqual(rateStatuses, [429, 429, 200]);

    await assert.rejects(fetch(`${base}/disconnect/v1/models`));
    await assert.rejects(fetch(`${base}/timeout/v1/models`, { signal: AbortSignal.timeout(50) }));
    console.log('Mock relay self-test passed.');
  } finally {
    server.close();
  }
});
