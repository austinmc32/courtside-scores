const leagues = { nba: 'basketball/nba', wnba: 'basketball/wnba', nfl: 'football/nfl', mlb: 'baseball/mlb', nhl: 'hockey/nhl', epl: 'soccer/eng.1', mls: 'soccer/usa.1' };
const streamSports = { nba: 'basketball', wnba: 'basketball', nfl: 'american-football', mlb: 'baseball', nhl: 'hockey', epl: 'football', mls: 'football' };
const sources = new Set(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'intel']);
const cacheTtlMs = 20_000;
const maxCacheEntries = 200;
const apiCache = new Map();
const inFlight = new Map();

function upstreamUrl(url) {
  if (url.pathname === '/api/watch/matches') {
    const sport = streamSports[url.searchParams.get('league')];
    if (!sport) throw new Error('Invalid league');
    return new URL(`https://streamed.pk/api/matches/${sport}`);
  }
  if (url.pathname === '/api/watch/streams') {
    const source = url.searchParams.get('source');
    const id = url.searchParams.get('id');
    if (!sources.has(source) || !/^[a-zA-Z0-9_-]{1,250}$/.test(id || '')) throw new Error('Invalid stream source or ID');
    return new URL(`https://streamed.pk/api/stream/${source}/${encodeURIComponent(id)}`);
  }
  const league = url.searchParams.get('league');
  if (!leagues[league]) throw new Error('Invalid league');
  if (url.pathname === '/api/summary') {
    const event = url.searchParams.get('event');
    if (!/^\d{1,15}$/.test(event || '')) throw new Error('Invalid event');
    const target = new URL(`https://site.api.espn.com/apis/site/v2/sports/${leagues[league]}/summary`);
    target.searchParams.set('event', event);
    return target;
  }
  const date = url.searchParams.get('date');
  if (!/^\d{8}$/.test(date || '')) throw new Error('Invalid date');
  const target = new URL(`https://site.api.espn.com/apis/site/v2/sports/${leagues[league]}/scoreboard`);
  target.searchParams.set('dates', date);
  target.searchParams.set('limit', '100');
  return target;
}

async function loadUpstream(target) {
  const key = target.href;
  const existing = apiCache.get(key);
  if (existing && Date.now() - existing.time < cacheTtlMs) {
    apiCache.delete(key);
    apiCache.set(key, existing);
    return existing.body;
  }
  if (existing) apiCache.delete(key);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(target, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
      const body = await response.text();
      const entry = { time: Date.now(), body };
      apiCache.set(key, entry);
      while (apiCache.size > maxCacheEntries) apiCache.delete(apiCache.keys().next().value);
      return body;
    })().finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  return pending;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (['/api/scoreboard', '/api/summary', '/api/watch/matches', '/api/watch/streams'].includes(url.pathname)) {
      let target;
      try {
        target = upstreamUrl(url);
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      try {
        const body = await loadUpstream(target);
        return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: 'Sports feed is unavailable. Please try again.' }, { status: 502 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
