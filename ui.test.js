import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, leagues } from './server.js';
import { normalizeScoreboardEvent, renderScoreCard } from './scoreboard-view.js';

const server = createServer();

test('rendered scoreboard cards agree with live scoreboard API data', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const now = new Date();
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const results = await Promise.all(Object.keys(leagues).map(async league => {
    const response = await fetch(`${origin}/api/scoreboard?league=${league}&date=${day}`);
    assert.equal(response.status, 200, `${league} scoreboard API should return HTTP 200`);
    const data = await response.json();
    assert.ok(Array.isArray(data.events), `${league} scoreboard should include events`);
    return { league, events: data.events };
  }));

  let checkedGames = 0;
  for (const { league, events } of results) {
    for (const rawEvent of events) {
      const event = normalizeScoreboardEvent(rawEvent, league);
      const html = renderScoreCard(event, {
        leagueName: leagues[league][0],
        leagueIcon: '◈',
        hasStream: false,
        isSaved: false,
        streamLimitReached: false,
      });
      assert.ok(html.includes(`data-game="${event.id}"`), `${event.id} should render as a card`);
      assert.ok(html.includes(`Open Game Center for ${event.name}`));
      assert.ok(html.includes(`class="status ${event.state === 'in' ? 'live' : ''}"`));
      for (const competitor of event.competitions[0].competitors) {
        assert.ok(html.includes(competitor.team.shortDisplayName || competitor.team.displayName));
        if (competitor.score != null) assert.ok(html.includes(competitor.score));
      }
      checkedGames++;
    }
  }
  if (checkedGames === 0) assert.ok(results.every(({ events }) => events.length === 0));
  else assert.ok(checkedGames > 0, 'at least one API event should have a matching rendered card');
});
