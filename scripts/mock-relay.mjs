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

const mixedShortItems = Array.from({ length: 24 }, (_, index) => `
    <li id="nav-${index + 1}">Short nav ${index + 1}</li>`).join('');
const mixedLongParagraphs = Array.from({ length: 8 }, (_, index) => {
  const body = `Mixed long paragraph ${index + 1}. Keep names, numbers, and punctuation. This paragraph is long enough to sit beside short navigation nodes so batching can be compared without using a private page. `.repeat(6);
  return `
    <p id="mixed-long-${index + 1}">${body}</p>`;
}).join('');
const mixedFixturePage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>LinguaLens Mixed Batch Fixture</title></head>
<body>
  <main>
    <h1>Mixed short nodes and long paragraphs</h1>
    <p id="format">Keep this <a href="#mixed-end">working link</a> and this <strong>bold phrase</strong> intact.</p>
    <ul>${mixedShortItems}
    </ul>${mixedLongParagraphs}
    <p id="mixed-end">The final paragraph verifies restore original behavior.</p>
  </main>
</body>
</html>`;

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

const dynamicFixturePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dynamic translation fixture</title>
<style>
  #drawer-trigger[aria-expanded="false"] + #drawer-panel { display: none; }
  #animated-panel { transform: translateX(-200vw); transition: transform 1.1s linear; }
  #animated-panel[data-state="closed"] { visibility: hidden; }
  #animated-panel[data-state="open"] { transform: translateX(0); }
</style></head>
<body>
<nav>
  <button id="add">Add paragraph</button>
  <button id="replace">Replace source</button>
  <button id="reveal">Reveal hidden text</button>
  <button id="append">Append twenty rows</button>
  <button id="reuse">Reuse virtual row</button>
  <button id="spa">Next SPA chapter</button>
  <a href="/fixture-dynamic?chapter=2">Next document</a>
  <a href="/fixture-dynamic-redirect">Same-origin redirect</a>
  <a href="http://localhost:17891/fixture-dynamic">Different origin</a>
</nav>
<main>
  <h1>Dynamic translation chapter</h1>
  <p id="source">Original source paragraph with a <a href="#end">working link</a> and <strong>bold words</strong>.</p>
  <p id="virtual">Virtual list row number one.</p>
  <p id="hidden" hidden>Previously hidden text should be translated after becoming visible.</p>
  <details id="native-details"><summary>Expandable article section</summary>
    <p id="details-body">Native details article text should translate after opening.</p>
  </details>
  <button id="drawer-trigger" aria-expanded="false" aria-controls="drawer-panel">Toggle article drawer</button>
  <section id="drawer-panel" class="dropdown-content">
    <p>CSS-controlled article prose must not be confused with menu controls.</p>
  </section>
  <button id="animate-drawer">Reveal sliding drawer</button>
  <section id="animated-panel" data-state="closed">
    <p>Article prose should translate when the reveal animation finishes.</p>
  </section>
  <div id="rows"></div>
  <div style="height:2400px"></div>
  <p id="end">Offscreen content becomes eligible when it approaches the viewport.</p>
  <input value="This input must not change">
  <pre>const code = "never translated";</pre>
</main>
<script>
  let count = 0;
  const rows = document.getElementById('rows');
  function add() {
    const p = document.createElement('p');
    p.textContent = 'New paragraph ' + (++count) + ' added after the initial page translation.';
    rows.append(p);
  }
  document.getElementById('add').onclick = add;
  document.getElementById('replace').onclick = () => {
    document.getElementById('source').firstChild.textContent = 'Website replacement ' + (++count) + ' preserves the existing link and bold words: ';
  };
  document.getElementById('reveal').onclick = () => { document.getElementById('hidden').hidden = false; };
  document.getElementById('drawer-trigger').onclick = (event) => {
    event.target.setAttribute('aria-expanded', String(event.target.getAttribute('aria-expanded') !== 'true'));
  };
  document.getElementById('animate-drawer').onclick = () => {
    document.getElementById('animated-panel').dataset.state = 'open';
  };
  document.getElementById('append').onclick = () => { for (let i = 0; i < 20; i++) add(); };
  document.getElementById('reuse').onclick = () => {
    document.getElementById('virtual').firstChild.textContent = 'Virtual list reused content ' + (++count) + '.';
  };
  document.getElementById('spa').onclick = () => {
    history.pushState({}, '', '?spa=' + (++count));
    document.getElementById('virtual').firstChild.textContent = 'New SPA chapter content ' + count + '.';
    add();
  };
  setTimeout(add, 3000);
  setTimeout(() => { document.getElementById('hidden').hidden = false; }, 5000);
</script>
</body></html>`;

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
  const items = translatedItems(body);
  const metadata = body?.service_tier === 'priority' ? { service_tier: 'priority' } : {};
  if (body?.stream === true) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const writeLine = (line) => {
      if (protocol === 'responses') {
        response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: line })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: line }, finish_reason: null }] })}\n\n`);
      }
    };
    const finish = () => {
      if (protocol === 'responses') {
        response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', ...metadata } })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...metadata })}\n\n`);
        response.write('data: [DONE]\n\n');
      }
      response.end();
    };
    if (items.length < 2) {
      for (const item of items) writeLine(`${JSON.stringify(item)}\n`);
      finish();
      return;
    }
    let index = 0;
    const step = () => {
      if (index < items.length) {
        writeLine(`${JSON.stringify(items[index])}\n`);
        index += 1;
        const timer = setTimeout(step, 200);
        timer.unref();
        return;
      }
      finish();
    };
    step();
    return;
  }
  const content = JSON.stringify({ items });
  if (protocol === 'responses') json(response, 200, { output_text: content, ...metadata });
  else json(response, 200, { choices: [{ message: { content } }], ...metadata });
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
  if (url.pathname === '/fixture-dynamic') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(dynamicFixturePage);
    return;
  }
  if (url.pathname === '/fixture-dynamic-redirect') {
    response.writeHead(302, { Location: '/fixture-dynamic?chapter=redirect' });
    response.end();
    return;
  }
  if (url.pathname === '/fixture-long') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(longFixturePage);
    return;
  }
  if (url.pathname === '/fixture-mixed') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(mixedFixturePage);
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
    if (scenario === 'priority-rejected' && body.service_tier === 'priority') {
      json(response, 422, { error: 'service_tier priority is not supported by this mock relay' });
      return;
    }
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
  console.log('Scenarios: ok, slow, redirect, rate-limit, gateway, header-rejected, priority-rejected, timeout, disconnect');
  if (!selfTest) return;

  const base = `http://127.0.0.1:${activePort}`;
  const headers = { 'Content-Type': 'application/json', 'X-Translation-Request-Id': 'self-test-id' };
  const input = JSON.stringify({ target_language: 'zh-CN', items: [{ id: 'item-1', text: 'hello' }] });
  try {
    const models = await (await fetch(`${base}/ok/v1/models`)).json();
    assert.equal(models.data[0].id, 'mock-model');
    const dynamicFixture = await (await fetch(`${base}/fixture-dynamic`)).text();
    assert.match(dynamicFixture, /Next SPA chapter/);
    assert.match(dynamicFixture, /Virtual list reused content/);
    assert.match(dynamicFixture, /Different origin/);
    assert.match(dynamicFixture, /<details id="native-details">/);
    assert.match(dynamicFixture, /aria-controls="drawer-panel"/);
    assert.match(dynamicFixture, /data-state="closed"/);
    const pageRedirect = await fetch(`${base}/fixture-dynamic-redirect`, { redirect: 'manual' });
    assert.equal(pageRedirect.status, 302);
    assert.equal(pageRedirect.headers.get('location'), '/fixture-dynamic?chapter=redirect');
    const longFixture = await (await fetch(`${base}/fixture-long`)).text();
    assert.match(longFixture, /Batch 16:/);
    const mixedFixture = await (await fetch(`${base}/fixture-mixed`)).text();
    assert.match(mixedFixture, /Short nav 24/);
    assert.match(mixedFixture, /Mixed long paragraph 8/);
    assert.match(mixedFixture, /working link/);
    assert.match(mixedFixture, /bold phrase/);
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

    for (const protocol of ['chat/completions', 'responses']) {
      const body = protocol === 'responses'
        ? { input, service_tier: 'priority' }
        : { messages: [{ role: 'user', content: input }], service_tier: 'priority' };
      const fast = await (await fetch(`${base}/ok/v1/${protocol}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      })).json();
      assert.equal(fast.service_tier, 'priority');
      const stream = await (await fetch(`${base}/ok/v1/${protocol}`, {
        method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }),
      })).text();
      assert.match(stream, /"service_tier":"priority"/);
      const rejected = await fetch(`${base}/priority-rejected/v1/${protocol}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      assert.equal(rejected.status, 422);
    }

    const streamed = await fetch(`${base}/ok/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: input }] }),
    });
    assert.equal(streamed.headers.get('content-type').includes('text/event-stream'), true);
    const streamedText = await streamed.text();
    assert.match(streamedText, /finish_reason":"stop"/);
    assert.match(streamedText, /\[DONE\]/);
    assert.equal(streamedText.includes('Bearer'), false);

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
