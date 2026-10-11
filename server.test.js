import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createServer, feedUrl, leagues, streamUrl, streamSports } from './server.js';

test('all supported leagues route to scoreboards', () => {
  for (const league of Object.keys(leagues)) {
    const url = feedUrl(new URL(`http://localhost/api/scoreboard?league=${league}&date=20261006`));
    assert.equal(url.hostname, 'site.api.espn.com');
    assert.equal(url.searchParams.get('dates'), '20261006');
    assert.ok(url.pathname.endsWith(`${leagues[league]}/scoreboard`));
  }
});

test('game summaries route by event ID', () => {
  const url = feedUrl(new URL('http://localhost/api/summary?league=nba&event=401810001'));
  assert.equal(url.searchParams.get('event'), '401810001');
  assert.ok(url.pathname.endsWith('/summary'));
});

test('stream sports cover every scoreboard league', () => {
  assert.deepEqual(Object.keys(streamSports), Object.keys(leagues));
  for (const league of Object.keys(leagues)) {
    assert.equal(streamUrl(new URL(`http://localhost/api/watch/matches?league=${league}`)).pathname, `/api/matches/${streamSports[league]}`);
  }
});

test('stream source routing and validation', () => {
  assert.equal(streamUrl(new URL('http://localhost/api/watch/streams?source=alpha&id=team-a-vs-b')).href, 'https://streamed.pk/api/stream/alpha/team-a-vs-b');
  for (const query of ['/api/watch/matches?league=bad', '/api/watch/streams?source=bad&id=test', '/api/watch/streams?source=alpha&id=../secret']) {
    assert.throws(() => streamUrl(new URL(`http://localhost${query}`)));
  }
});

test('invalid parameters are rejected', () => {
  for (const query of ['/api/scoreboard?league=invalid&date=20261006', '/api/scoreboard?league=nba&date=bad', '/api/summary?league=nba&event=../secrets']) {
    assert.throws(() => feedUrl(new URL(`http://localhost${query}`)));
  }
});

async function withServer(options, callback) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function rawRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    request.on('error', reject);
  });
}

test('API responses negotiate gzip and respect q=0', async () => {
  const payload = { events: [{ id: 'event-1', padding: 'a'.repeat(300) }] };
  await withServer({ fetchImpl: async () => jsonResponse(payload) }, async origin => {
    const url = `${origin}/api/scoreboard?league=nba&date=20261006`;
    const plain = await rawRequest(url, { 'accept-encoding': 'gzip;q=0' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plain.body), payload);

    const compressed = await rawRequest(url, { 'accept-encoding': 'gzip' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.deepEqual(JSON.parse(gunzipSync(compressed.body)), payload);
  });
});

test('static responses negotiate gzip and preserve conditional revalidation', async () => {
  await withServer({}, async origin => {
    const response = await rawRequest(`${origin}/app.js`, { 'accept-encoding': 'gzip' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(gunzipSync(response.body).toString(), /render\(/);
    const revalidated = await rawRequest(`${origin}/app.js`, { 'if-none-match': response.headers.etag });
    assert.equal(revalidated.status, 304);
  });
});

test('concurrent identical API requests share one upstream fetch', async () => {
  let calls = 0;
  let releaseFetch;
  const wait = new Promise(resolve => { releaseFetch = resolve; });
  const fetchImpl = async () => {
    calls++;
    await wait;
    return jsonResponse({ events: [{ id: 'shared' }] });
  };
  await withServer({ fetchImpl }, async origin => {
    const request = () => fetch(`${origin}/api/scoreboard?league=nba&date=20261006`);
    const first = request();
    while (calls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const second = request();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    releaseFetch();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(await Promise.all(responses.map(response => response.json())), [{ events: [{ id: 'shared' }] }, { events: [{ id: 'shared' }] }]);
  });
});

test('gzip is skipped when its quality is zero and honored when explicitly enabled', async () => {
  await withServer({ fetchImpl: async () => jsonResponse({ events: [] }) }, async origin => {
    const disabled = await rawRequest(`${origin}/api/scoreboard?league=nba&date=20261006`, { 'accept-encoding': 'gzip;q=0, br;q=1' });
    assert.equal(disabled.headers['content-encoding'], undefined);
    const enabled = await rawRequest(`${origin}/api/scoreboard?league=nba&date=20261006`, { 'accept-encoding': 'br, gzip;q=0.5' });
    assert.equal(enabled.headers['content-encoding'], 'gzip');
  });
});

test('upstream failures are not cached and a later request can retry', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => ++calls === 1 ? jsonResponse({ error: 'unavailable' }, 503) : jsonResponse({ events: [] }) }, async origin => {
    const url = `${origin}/api/scoreboard?league=nba&date=20261006`;
    assert.equal((await fetch(url)).status, 502);
    const retry = await fetch(url);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { events: [] });
    assert.equal(calls, 2);
  });
});
