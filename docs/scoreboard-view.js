export function normalizeScoreboardEvent(event, league) {
  return { ...event, league, state: event.status.type.state, eventTime: Date.parse(event.date) || 0 };
}

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
}

const timeFormatters = new Map();
const localGameTimeOptions = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
export function localTime(value, options = {}) {
  const key = JSON.stringify(options);
  let formatter = timeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    timeFormatters.set(key, formatter);
  }
  return formatter.format(new Date(value));
}

export function localGameTime(value) {
  return localTime(value, localGameTimeOptions);
}

export function renderScoreCard(game, { leagueName, leagueIcon, hasStream, isSaved, streamLimitReached }) {
  const competition = game.competitions[0];
  const teams = [...competition.competitors].sort((a, b) => a.homeAway === 'away' ? -1 : 1);
  return `<article class="card" data-game="${escapeHtml(game.id)}" tabindex="0" aria-label="Open Game Center for ${escapeHtml(game.name)}"><div class="card-stream-actions"><span class="stream-indicator">${hasStream ? 'IN MULTISTREAM' : 'GAME STREAM'}</span><button data-quick-add="${escapeHtml(game.id)}" class="quick-add ${hasStream ? 'added' : ''}" aria-pressed="${hasStream}" ${hasStream || streamLimitReached ? 'disabled' : ''}>${hasStream ? '✓ In multistream' : '＋ Add to multistream'}</button></div><div class="card-top"><span class="league-name">${leagueIcon} &nbsp; ${escapeHtml(leagueName)}</span><span class="status ${game.state === 'in' ? 'live' : ''}">${game.state === 'in' ? '<i class="pulse"></i>' : ''}${escapeHtml(game.state === 'pre' ? localGameTime(game.date) : game.status.type.shortDetail)}</span></div><div class="teams">${teams.map(team => `<div class="team ${game.state === 'post' && !team.winner ? 'loser' : ''}">${team.team.logo ? `<img class="logo" src="${escapeHtml(team.team.logo)}" alt="" loading="lazy" decoding="async">` : '<span class="logo">◈</span>'}<div><div class="team-name">${escapeHtml(team.team.shortDisplayName || team.team.displayName)}</div><div class="record">${escapeHtml(team.records?.[0]?.summary || team.homeAway.toUpperCase())}</div></div><span class="score">${game.state === 'pre' ? '–' : escapeHtml(team.score)}</span></div>`).join('')}</div><div class="card-bottom"><button data-detail="${escapeHtml(game.id)}">Game center &nbsp; ↗</button><span class="venue">${escapeHtml(competition.broadcasts?.[0]?.names?.join(', ') || competition.venue?.fullName || '')}</span><button class="follow ${isSaved ? 'saved' : ''}" data-save="${escapeHtml(game.id)}" aria-label="${isSaved ? 'Unfollow' : 'Follow'} ${escapeHtml(game.shortName)}" aria-pressed="${isSaved}">${isSaved ? '★' : '☆'}</button></div></article>`;
}
