const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});
const feeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'feeds.json'), 'utf8'));

const CONFLICT_KEYWORDS = [
  'war', 'invasion', 'invade', 'strike', 'strikes', 'attack', 'attacked',
  'missile', 'missiles', 'drone', 'drones', 'troops', 'military', 'army',
  'offensive', 'ceasefire', 'clash', 'clashes', 'killed', 'wounded',
  'casualt', 'insurgent', 'rebel', 'militant', 'terrorist', 'bombing',
  'bomb', 'shelling', 'shell', 'border', 'security forces', 'coup',
  'mobiliz', 'escalat', 'conflict', 'cartel', 'violence', 'gunmen',
  'airstrike', 'artillery', 'nuclear', 'sanction', 'occupation', 'front line',
  'frontline', 'combat', 'insurgency', 'militia', 'warzone', 'skirmish'
];

const HIGH_SEVERITY = [
  'invasion', 'invade', 'war', 'killed', 'strike', 'strikes', 'attack',
  'missile', 'offensive', 'nuclear', 'bombing', 'coup', 'mobiliz', 'airstrike'
];

const FRESHNESS_HOURS_PRIMARY = 24;
const FRESHNESS_HOURS_FALLBACK = 48;

function containsConflictKeyword(text) {
  const lower = text.toLowerCase();
  return CONFLICT_KEYWORDS.some((kw) => lower.includes(kw));
}

function scoreItem(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of HIGH_SEVERITY) {
    if (lower.includes(kw)) score += 3;
  }
  for (const kw of CONFLICT_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

function hoursAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function relativeTimeLabel(hrs) {
  if (hrs === null) return 'recently';
  const h = Math.round(hrs);
  if (h <= 0) return 'just now';
  if (h === 1) return 'one hour ago';
  if (h < 24) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'one day ago' : `${d} days ago`;
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
}

function cleanSnippet(text, title) {
  if (!text) return '';
  let cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.toLowerCase() === (title || '').toLowerCase()) return '';
  const maxLen = 600;
  if (cleaned.length > maxLen) {
    let cut = cleaned.lastIndexOf('. ', maxLen);
    if (cut < 150) cut = maxLen;
    cleaned = cleaned.slice(0, cut + 1);
  }
  return cleaned;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('hard timeout')), ms)),
  ]);
}

async function fetchFeed(feed) {
  try {
    const parsed = await withTimeout(parser.parseURL(feed.url), 20000);
    return (parsed.items || []).map((item) => ({
      region: feed.region,
      source: feed.name,
      title: (item.title || '').trim(),
      link: item.link || '',
      isoDate: item.isoDate || item.pubDate || null,
      snippet: (item.contentSnippet || item.content || item.summary || '').trim(),
    }));
  } catch (err) {
    console.warn(`Feed failed, skipping: ${feed.name} (${feed.url}) - ${err.message}`);
    return [];
  }
}

async function main() {
  const allResults = await Promise.all(feeds.map(fetchFeed));
  let items = allResults.flat();

  items = items
    .filter((it) => it.title)
    .map((it) => ({ ...it, hrs: hoursAgo(it.isoDate) }))
    .filter((it) => containsConflictKeyword(`${it.title} ${it.snippet}`));

  const byRegion = {};
  for (const feed of feeds) {
    if (!byRegion[feed.region]) byRegion[feed.region] = [];
  }
  for (const it of items) {
    if (!byRegion[it.region]) byRegion[it.region] = [];
    byRegion[it.region].push(it);
  }

  const regionSummaries = [];
  const allSources = [];
  let topItem = null;
  let topScore = -1;

  for (const region of Object.keys(byRegion)) {
    let regionItems = byRegion[region];

    let windowHours = FRESHNESS_HOURS_PRIMARY;
    let fresh = regionItems.filter((it) => it.hrs !== null && it.hrs <= windowHours);
    if (fresh.length === 0) {
      windowHours = FRESHNESS_HOURS_FALLBACK;
      fresh = regionItems.filter((it) => it.hrs !== null && it.hrs <= windowHours);
    }

    const seen = new Set();
    const scored = [];
    for (const it of fresh) {
      const key = normalizeTitle(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({
        ...it,
        score: scoreItem(`${it.title} ${it.snippet}`),
        cleanedSnippet: cleanSnippet(it.snippet, it.title),
      });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.hrs - b.hrs));

    const topForRegion = scored.slice(0, 4);
    const regionMaxScore = topForRegion.length ? topForRegion[0].score : -1;

    for (const it of topForRegion) {
      allSources.push({ region, title: it.title, url: it.link });
      if (it.score > topScore) {
        topScore = it.score;
        topItem = { ...it, region };
      }
    }

    regionSummaries.push({
      region,
      maxScore: regionMaxScore,
      windowHours,
      items: topForRegion,
    });
  }
  
  regionSummaries.sort((a, b) => b.maxScore - a.maxScore);

  const centralHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  const greeting = centralHour < 12 ? 'Good morning.' : centralHour < 18 ? 'Good afternoon.' : 'Good evening.';

  const lines = [];
  const anyNews = topItem !== null;

  if (anyNews) {
    lines.push(
      `${greeting} Here is your global conflict briefing. The most significant development in the last day comes from the ${topItem.region.toLowerCase()}: ${topItem.title}, reported by ${topItem.source} ${relativeTimeLabel(topItem.hrs)}. Full details follow.`
    );
  } else {
    lines.push(`${greeting} Here is your global conflict briefing. No significant conflict-related developments were detected across tracked regions in the last day.`);
  }

  for (const rs of regionSummaries) {
    lines.push('');
    if (rs.items.length === 0) {
      lines.push(`${rs.region}: no notable new developments in the last ${rs.windowHours} hours.`);
      continue;
    }
    lines.push(`Turning to the ${rs.region}.`);
    for (const it of rs.items) {
      lines.push(`From ${it.source}, ${relativeTimeLabel(it.hrs)}: ${it.title}.`);
      if (it.cleanedSnippet) {
        lines.push(it.cleanedSnippet);
      }
    }
  }

  lines.push('');
  lines.push('This briefing is compiled automatically from regional news feeds and has not been cross-referenced by an editor. Treat single-source claims as unconfirmed. I will be back with the next update.');

  const script = lines.join('\n');

  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const headline = anyNews
    ? `${topItem.region}: ${topItem.title}`
    : 'Quiet day across all tracked regions';

  const output = {
    date: dateStr,
    headline,
    generatedAt: new Date().toISOString(),
    script,
    sources: allSources,
  };

  fs.mkdirSync(path.join(__dirname, '..', '..', 'briefing'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', '..', 'briefing', 'latest.json'),
    JSON.stringify(output, null, 2)
  );

  console.log('Briefing written. Headline:', headline);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
