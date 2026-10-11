import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const gzip = promisify(gzipCallback);
export const leagues = { nba:'basketball/nba', wnba:'basketball/wnba', nfl:'football/nfl', mlb:'baseball/mlb', nhl:'hockey/nhl', epl:'soccer/eng.1', mls:'soccer/usa.1' };
const API_CACHE_TTL_MS = 20_000;
const MAX_API_CACHE_ENTRIES = 200;

function cacheApiResponse(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_API_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function acceptsGzip(header = '') {
  return header.split(',').some(encoding => {
    const [name, ...parameters] = encoding.trim().toLowerCase().split(';');
    if (name !== 'gzip') return false;
    const quality = parameters.map(part => part.trim()).find(part => part.startsWith('q='));
    return !quality || Number(quality.slice(2)) > 0;
  });
}

async function getApiResponse(target, fetchImpl, cache, inFlight) {
  const key = target.href;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.time < API_CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  if (cached) cache.delete(key);

  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Sports feed returned ${response.status}`);
      const entry = { time: Date.now(), raw: Buffer.from(JSON.stringify(await response.json())), gzipPromise: null };
      cacheApiResponse(cache, key, entry);
      return entry;
    })().finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  return pending;
}
export const streamSports = {nba:'basketball',wnba:'basketball',nfl:'american-football',mlb:'baseball',nhl:'hockey',epl:'football',mls:'football'};
export function streamUrl(url) {
  if (url.pathname === '/api/watch/matches') {
    const sport = streamSports[url.searchParams.get('league')];
    if (!sport) throw new Error('Invalid league');
    return new URL(`https://streamed.pk/api/matches/${sport}`);
  }
  const source = url.searchParams.get('source');
  const id = url.searchParams.get('id');
  if (!['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','intel'].includes(source) || !/^[a-zA-Z0-9_-]{1,250}$/.test(id || '')) throw new Error('Invalid stream source or ID');
  return new URL(`https://streamed.pk/api/stream/${source}/${encodeURIComponent(id)}`);
}
export function feedUrl(url) {
  const league = url.searchParams.get('league');
  if (!leagues[league]) throw new Error('Invalid league');
  const endpoint = url.pathname === '/api/summary' ? 'summary' : 'scoreboard';
  const target = new URL(`https://site.api.espn.com/apis/site/v2/sports/${leagues[league]}/${endpoint}`);
  if (endpoint === 'summary') {
    const event = url.searchParams.get('event');
    if (!/^\d{1,15}$/.test(event || '')) throw new Error('Invalid event');
    target.searchParams.set('event', event);
  } else {
    const date = url.searchParams.get('date');
    if (!/^\d{8}$/.test(date || '')) throw new Error('Invalid date');
    target.searchParams.set('dates', date);
    target.searchParams.set('limit', '100');
  }
  return target;
}
export function createServer({ fetchImpl = fetch } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const staticCache = new Map();
  return http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (['/api/scoreboard', '/api/summary','/api/watch/matches','/api/watch/streams'].includes(url.pathname)) {
    let target;
    try { target = url.pathname.startsWith('/api/watch/') ? streamUrl(url) : feedUrl(url); } catch (error) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:error.message})); return; }
    try {
      const entry = await getApiResponse(target, fetchImpl, cache, inFlight);
      if (acceptsGzip(req.headers['accept-encoding'])) {
        entry.gzipPromise ??= gzip(entry.raw);
        const compressed = await entry.gzipPromise;
        res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store','Content-Encoding':'gzip','Vary':'Accept-Encoding'});
        res.end(compressed);
        return;
      }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Accept-Encoding'});
      res.end(entry.raw);
    } catch { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Sports feed is unavailable. Please try again.'})); }
    return;
  }
  const files = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
  const file = files[url.pathname] || (url.pathname === '/scoreboard-view.js' ? 'scoreboard-view.js' : undefined);
  if (!file) {res.writeHead(404);res.end('Not found');return;}
  try {
    const path = new URL(file,import.meta.url);
    const info = await stat(path);
    let entry = staticCache.get(file);
    if (!entry || entry.mtime !== info.mtimeMs) {
      const content = await readFile(path);
      const etag = `"${createHash('sha1').update(content).digest('base64url')}"`;
      entry = {mtime:info.mtimeMs, etag, content, gzipPromise:null};
      staticCache.set(file,entry);
    }
    if (req.headers['if-none-match']?.split(',').some(tag => tag.trim() === entry.etag || tag.trim() === '*')) { res.writeHead(304, {'ETag':entry.etag,'Vary':'Accept-Encoding'}); res.end(); return; }
    const headers = {'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-cache','ETag':entry.etag,'Vary':'Accept-Encoding'};
    if (acceptsGzip(req.headers['accept-encoding'])) {
      entry.gzipPromise ??= gzip(entry.content);
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(await entry.gzipPromise);
      return;
    }
    res.writeHead(200, headers);
    res.end(entry.content);
  } catch {res.writeHead(500);res.end('Unable to load application');}
  });
}
const server = createServer();
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) server.listen(Number(process.env.PORT || 3000),process.env.HOST || '0.0.0.0',()=>console.log(`Courtside listening on ${process.env.HOST || '0.0.0.0'}:${process.env.PORT || 3000}`));
