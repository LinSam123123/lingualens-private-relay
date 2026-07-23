import http from 'node:http';
import assert from 'node:assert/strict';

const port = Number(process.env.PORT || 17891);
const rateLimits = new Map();

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
    success(response, endpoint === 'responses' ? 'responses' : 'chat-completions', body);
  });
});

server.listen(port, '127.0.0.1', async () => {
  console.log(`Mock relay listening on http://127.0.0.1:${port}/ok/v1`);
  console.log('Scenarios: ok, redirect, rate-limit, gateway, header-rejected, timeout, disconnect');
  if (!process.argv.includes('--self-test')) return;

  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Translation-Request-Id': 'self-test-id' };
  const input = JSON.stringify({ target_language: 'zh-CN', items: [{ id: 'item-1', text: 'hello' }] });
  try {
    const models = await (await fetch(`${base}/ok/v1/models`)).json();
    assert.equal(models.data[0].id, 'mock-model');

    const chat = await (await fetch(`${base}/ok/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: input }] }),
    })).json();
    assert.match(chat.choices[0].message.content, /item-1/);

    const responses = await (await fetch(`${base}/ok/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ input }),
    })).json();
    assert.match(responses.output_text, /item-1/);

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
