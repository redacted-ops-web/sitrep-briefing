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
const countries = JSON.parse(fs.readFileSync(path.join(__dirname, 'countries.json'), 'utf8'));

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

function detectCountries(text) {
  const lower = text.toLowerCase();
  const matches = [];
  for (const c of countries) {
    const terms = [c.name.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())];
    if (terms.some((t) => lower.includes(t))) {
      matches.push(c);
    }
  }
  return matches;
}

function updateCountryBlips(freshCountryNames, countryLookup) {
  const statePath = path.join(__dirname, '..', '..', 'briefing', 'country_blips.json');
  let state = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      state = {};
    }
  }

  const now = Date.now();
    const DECAY_FACTOR = 0.9;
  const MAX_AGE_HOURS = 48;

  for (const name of Object.keys(state)) {
    if (freshCountryNames.has(name)) continue;
    const entry = state[name];
    const hoursSince = (now - entry.lastSeenAt) / (1000 * 60 * 60);
    if (hoursSince > MAX_AGE_HOURS) {
      delete state[name];
      continue;
    }
    entry.brightness = entry.brightness * DECAY_FACTOR;
    if (entry.brightness < 0.03) {
      delete state[name];
    }
  }

  for (const name of freshCountryNames) {
    const info = countryLookup[name];
    if (!info) continue;
    state[name] = {
      lat: info.lat,
      lon: info.lon,
      capital: info.capital,
      brightness: 1.0,
      lastSeenAt: now,
    };
  }

  fs.mkdirSync(path.join(__dirname, '..', '..', 'briefing'), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  return Object.entries(state).map(([name, s]) => ({
    country: name,
    capital: s.capital,
    lat: s.lat,
    lon: s.lon,
    brightness: Math.round(s.brightness * 100) / 100,
  }));
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

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'with',
  'after', 'amid', 'as', 'is', 'are', 'over', 'into', 'from', 'by', 'at',
  'its', 'his', 'her', 'their', 'says', 'say', 'said', 'will', 'more',
  'than', 'that', 'this', 'has', 'have', 'been', 'be', 'new', 'first',
  'toward', 'towards', 'day', 'ld', 'last'
]);

function stemWord(w) {
  return w.length > 5 ? w.slice(0, 5) : w;
}

function titleSignature(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .map(stemWord)
  );
}

function signatureSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) {
    if (b.has(w)) inter++;
  }
  return inter / Math.min(a.size, b.size);
}

function clusterStories(items, threshold = 0.55) {
  const n = items.length;
  const sigs = items.map((it) => titleSignature(it.title));
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (signatureSimilarity(sigs[i], sigs[j]) >= threshold) union(i, j);
    }
  }
  const groups = {};
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups[root]) groups[root] = [];
    groups[root].push(items[i]);
  }
  return Object.values(groups);
}

async function main() {
  const taxonomy = JSON.parse(fs.readFileSync(path.join(__dirname, 'region-taxonomy.json'), 'utf8'));
  const continentOrder = Object.keys(taxonomy);
  const regionToContinent = {};
  for (const continent of continentOrder) {
    for (const region of taxonomy[continent]) {
      regionToContinent[region] = continent;
    }
  }

  const allResults = await Promise.all(feeds.map(fetchFeed));
  let items = allResults.flat();

  items = items
    .filter((it) => it.title)
    .map((it) => ({ ...it, hrs: hoursAgo(it.isoDate) }))
    .filter((it) => scoreItem(`${it.title} ${it.snippet}`) >= 3);

  const hasFeed = {};
  for (const feed of feeds) hasFeed[feed.region] = true;

  const byRegion = {};
  for (const continent of continentOrder) {
    for (const region of taxonomy[continent]) {
      byRegion[region] = [];
    }
  }
  for (const it of items) {
    if (!byRegion[it.region]) byRegion[it.region] = [];
    byRegion[it.region].push(it);
  }

  const countryLookup = {};
  for (const c of countries) countryLookup[c.name] = c;

  const windowHoursByRegion = {};
  const freshScoredAll = [];

  for (const region of Object.keys(byRegion)) {
    const regionItems = byRegion[region];

    let windowHours = FRESHNESS_HOURS_PRIMARY;
    let fresh = regionItems.filter((it) => it.hrs !== null && it.hrs <= windowHours);
    if (fresh.length === 0) {
      windowHours = FRESHNESS_HOURS_FALLBACK;
      fresh = regionItems.filter((it) => it.hrs !== null && it.hrs <= windowHours);
    }
    windowHoursByRegion[region] = windowHours;

    const seen = new Set();
    for (const it of fresh) {
      const key = normalizeTitle(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      freshScoredAll.push({
        ...it,
        score: scoreItem(`${it.title} ${it.snippet}`),
        cleanedSnippet: cleanSnippet(it.snippet, it.title),
      });
    }
  }

  const clusters = clusterStories(freshScoredAll);

  const freshCountryNames = new Set();
  const stories = clusters.map((groupItems) => {
    groupItems.sort((a, b) => (b.score - a.score) || (a.hrs - b.hrs));
    const best = groupItems[0];
    const sourceNames = [...new Set(groupItems.map((g) => g.source))];
    const combinedText = groupItems.map((g) => `${g.title} ${g.snippet}`).join(' ');
    const matchedCountries = detectCountries(combinedText);
    for (const m of matchedCountries) freshCountryNames.add(m.name);
    return {
      title: best.title,
      region: best.region,
      hrs: Math.min(...groupItems.map((g) => g.hrs)),
      score: best.score,
      sources: sourceNames,
      cleanedSnippet: best.cleanedSnippet,
      items: groupItems,
    };
  });

  const blips = updateCountryBlips(freshCountryNames, countryLookup);

  const allSources = [];
  for (const story of stories) {
    for (const it of story.items) {
      allSources.push({ region: story.region, title: it.title, url: it.link });
    }
  }

  const regionSummaries = {};
  for (const region of Object.keys(byRegion)) {
    const regionStories = stories
      .filter((s) => s.region === region)
      .sort((a, b) => (b.score - a.score) || (a.hrs - b.hrs))
      .slice(0, 4);
    regionSummaries[region] = {
      region,
      continent: regionToContinent[region] || 'Unmapped',
      hasFeed: !!hasFeed[region],
      maxScore: regionStories.length ? regionStories[0].score : -1,
      windowHours: windowHoursByRegion[region] || FRESHNESS_HOURS_PRIMARY,
            items: regionStories,
    };
  }

  let topItem = null;
  let topScore = -1;
  const regionTopItems = [];
  for (const region of Object.keys(regionSummaries)) {
    const rs = regionSummaries[region];
    if (rs.items.length === 0) continue;
    regionTopItems.push({ region, item: rs.items[0] });
    if (rs.items[0].score > topScore) {
      topScore = rs.items[0].score;
      topItem = { ...rs.items[0], region };
    }
  }

  const centralHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
  const greeting = centralHour < 12 ? 'Good morning.' : centralHour < 18 ? 'Good afternoon.' : 'Good evening.';

  const lines = [];
  const anyNews = topItem !== null;

  if (anyNews) {
    lines.push(`${greeting} This is your global conflict briefing.`);
    lines.push('');
    lines.push('BOTTOM LINE UP FRONT:');
    const bluf = regionTopItems
      .slice()
      .sort((a, b) => b.item.score - a.item.score)
      .slice(0, 3);
    for (const b of bluf) {
      lines.push(`- ${b.region}: ${b.item.title}.`);
    }
    lines.push('');
    lines.push('Full breakdown follows.');
  } else {
    lines.push(`${greeting} This is your global conflict briefing. No significant conflict-related developments were detected across tracked regions in the last day.`);
  }

  for (const continent of continentOrder) {
    const regionsInContinent = taxonomy[continent].map((r) => regionSummaries[r]);
    const regionsWithFeed = regionsInContinent.filter((r) => r.hasFeed);

    if (regionsWithFeed.length === 0) {
      continue;
    }

    lines.push('');
    lines.push(continent.toUpperCase());
    const sortedRegions = regionsWithFeed.slice().sort((a, b) => b.maxScore - a.maxScore);
    for (const rs of sortedRegions) {
      if (rs.items.length === 0) {
        lines.push(`${rs.region}: no notable developments in the last ${rs.windowHours} hours.`);
        continue;
      }
      lines.push(`${rs.region} - bottom line: ${rs.items[0].title}.`);
      for (const story of rs.items) {
        lines.push(`- ${story.sources.join(', ')}, ${relativeTimeLabel(story.hrs)}: ${story.title}.`);
        if (story.cleanedSnippet) {
          lines.push(story.cleanedSnippet);
        }
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
    blips,
  };

  fs.mkdirSync(path.join(__dirname, '..', '..', 'briefing'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', '..', 'briefing', 'latest.json'),
    JSON.stringify(output, null, 2)
  );

  console.log('Briefing written. Headline:', headline, '- Blips:', blips.length, '- Stories:', stories.length);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
