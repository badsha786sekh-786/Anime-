// scripts/generate-anime-pages.mjs
//
// BOSS Anime Club - SEO Anime Page Generator
// Primary source: AniList
// Fallback source: Jikan (MyAnimeList)
// Output:
//   anime/<slug>-<id>.html
//   anime/index.html
//   sitemap.xml
//
// IMPORTANT:
// - If an API is temporarily blocked/down, existing generated pages are NOT deleted.
// - If both APIs fail but old anime pages already exist, the workflow exits successfully.
// - Stale-page cleanup only happens when fresh API data was successfully collected.
// - No API key is required.

import {
  writeFile,
  mkdir,
  readdir,
  unlink,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

const SITE_URL = 'https://anime.is-cool.dev';
const OUT_DIR = path.join(process.cwd(), 'anime');

const PAGE_COUNT = 5;
const PER_PAGE = 40;

const API = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4/top/anime';

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const ANALYTICS_SCRIPT =
  '<script defer src="https://analytics.open-domains.com/script.js" ' +
  'data-website-id="c72153eb-a0fc-4580-bae2-76db6e9a799c"></script>';

const QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(sort: POPULARITY_DESC, type: ANIME) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
      bannerImage
      averageScore
      episodes
      format
      status
      genres
      description(asHtml: false)
      startDate { year }
      studios(isMain: true) { nodes { name } }
    }
  }
}
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function slugify(title) {
  return String(title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function cleanText(value, maxLength = 500) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normaliseAniListAnime(m) {
  return {
    id: Number(m?.id),
    title: {
      romaji: m?.title?.romaji || '',
      english: m?.title?.english || '',
      native: m?.title?.native || '',
    },
    coverImage: {
      extraLarge: m?.coverImage?.extraLarge || '',
      large: m?.coverImage?.large || '',
    },
    bannerImage: m?.bannerImage || '',
    averageScore: m?.averageScore ?? null,
    episodes: m?.episodes ?? null,
    format: m?.format || '',
    status: m?.status || '',
    genres: Array.isArray(m?.genres) ? m.genres : [],
    description: m?.description || '',
    startDate: { year: m?.startDate?.year ?? null },
    studios: {
      nodes: Array.isArray(m?.studios?.nodes)
        ? m.studios.nodes.map((s) => ({ name: s?.name || '' }))
        : [],
    },
  };
}

function normaliseJikanAnime(item) {
  const titleEnglish =
    item?.title_english ||
    item?.titles?.find?.((x) => x?.type === 'English')?.title ||
    '';

  const titleRomaji = item?.title || '';

  return {
    id: Number(item?.mal_id),
    title: {
      romaji: titleRomaji,
      english: titleEnglish,
      native:
        item?.title_japanese ||
        item?.titles?.find?.((x) => x?.type === 'Japanese')?.title ||
        '',
    },
    coverImage: {
      extraLarge: item?.images?.jpg?.large_image_url ||
        item?.images?.jpg?.image_url || '',
      large: item?.images?.jpg?.image_url || '',
    },
    bannerImage: '',
    averageScore: item?.score != null
      ? Math.round(Number(item.score) * 10)
      : null,
    episodes: item?.episodes ?? null,
    format: item?.type || '',
    status: item?.status || '',
    genres: Array.isArray(item?.genres)
      ? item.genres.map((g) => g?.name).filter(Boolean)
      : [],
    description: item?.synopsis || '',
    startDate: {
      year: item?.year ||
        (item?.aired?.from ? Number(String(item.aired.from).slice(0, 4)) : null),
    },
    studios: {
      nodes: Array.isArray(item?.studios)
        ? item.studios.map((s) => ({ name: s?.name || '' }))
        : [],
    },
  };
}

async function fetchJsonWithRetry(url, options = {}, maxAttempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      let response;
      try {
        response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) {
        return await response.json();
      }

      const retryable =
        response.status === 403 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;

      let body = '';
      try {
        body = await response.text();
      } catch {}

      lastError = new Error(
        `HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`
      );

      if (!retryable || attempt >= maxAttempts) {
        break;
      }

      const waitMs = Math.min(15000, 2000 * attempt);
      console.log(
        `Request failed: HTTP ${response.status} ` +
        `(attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs / 1000}s...`
      );
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;

      const waitMs = Math.min(15000, 2000 * attempt);
      console.log(
        `Network/timeout error (attempt ${attempt}/${maxAttempts}). ` +
        `Retrying in ${waitMs / 1000}s...`
      );
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('Unknown request failure');
}

async function fetchAniListPage(page) {
  const json = await fetchJsonWithRetry(
    API,
    {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({
        query: QUERY,
        variables: { page, perPage: PER_PAGE },
      }),
    },
    3
  );

  if (Array.isArray(json?.errors) && json.errors.length) {
    const message = json.errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join('; ') || 'AniList GraphQL error';
    throw new Error(message);
  }

  return Array.isArray(json?.data?.Page?.media)
    ? json.data.Page.media.map(normaliseAniListAnime)
    : [];
}

async function fetchFromAniList() {
  console.log('');
  console.log('==========================================');
  console.log('AniList: fetching anime...');
  console.log('==========================================');

  const all = [];
  const seen = new Set();

  for (let page = 1; page <= PAGE_COUNT; page++) {
    console.log(`AniList: page ${page}/${PAGE_COUNT}`);

    const media = await fetchAniListPage(page);

    if (!media.length) {
      throw new Error(`AniList returned 0 anime on page ${page}`);
    }

    for (const anime of media) {
      if (!anime.id || seen.has(anime.id)) continue;
      seen.add(anime.id);
      all.push(anime);
    }

    if (page < PAGE_COUNT) {
      await sleep(900);
    }
  }

  return all;
}

async function fetchJikanPage(page) {
  const url = `${JIKAN_API}?page=${page}&limit=25&filter=bypopularity`;

  const json = await fetchJsonWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': REQUEST_HEADERS['User-Agent'],
      },
    },
    5
  );

  if (!Array.isArray(json?.data)) {
    throw new Error(`Jikan returned invalid data on page ${page}`);
  }

  return json.data.map(normaliseJikanAnime).filter((x) => x.id);
}

async function fetchFromJikan() {
  console.log('');
  console.log('==========================================');
  console.log('Jikan: fallback source...');
  console.log('==========================================');

  // 8 x 25 = up to 200 anime.
  const pagesNeeded = Math.ceil((PAGE_COUNT * PER_PAGE) / 25);

  const all = [];
  const seen = new Set();

  for (let page = 1; page <= pagesNeeded; page++) {
    console.log(`Jikan: page ${page}/${pagesNeeded}`);

    const media = await fetchJikanPage(page);

    if (!media.length) {
      throw new Error(`Jikan returned 0 anime on page ${page}`);
    }

    for (const anime of media) {
      if (!anime.id || seen.has(anime.id)) continue;
      seen.add(anime.id);
      all.push(anime);
    }

    if (page < pagesNeeded) {
      // Jikan rate limits are stricter than AniList.
      await sleep(1200);
    }
  }

  return all.slice(0, PAGE_COUNT * PER_PAGE);
}

async function hasExistingAnimePages() {
  try {
    const files = await readdir(OUT_DIR);
    return files.some(
      (file) => file.endsWith('.html') && file !== 'index.html'
    );
  } catch {
    return false;
  }
}

async function fetchAllAnime() {
  try {
    const list = await fetchFromAniList();

    if (list.length > 0) {
      console.log(`AniList success: ${list.length} anime.`);
      return { list, source: 'AniList', fresh: true };
    }
  } catch (error) {
    console.error(`AniList unavailable: ${error?.message || error}`);
  }

  console.log('');
  console.log('AniList unavailable. Switching to Jikan...');

  try {
    const list = await fetchFromJikan();

    if (list.length > 0) {
      console.log(`Jikan success: ${list.length} anime.`);
      return { list, source: 'Jikan', fresh: true };
    }
  } catch (error) {
    console.error(`Jikan unavailable: ${error?.message || error}`);
  }

  return { list: [], source: 'none', fresh: false };
}

function buildEditorNote(m, title, genres, studio, year, score) {
  const genreList = genres.length
    ? genres.slice(0, 3).join(', ')
    : 'multiple genres';

  let scoreLine = 'does not currently have a community score';
  if (m.averageScore != null) {
    if (m.averageScore >= 75) {
      scoreLine = `holds a strong community score of ${score}/10`;
    } else if (m.averageScore >= 50) {
      scoreLine = `has a community score of ${score}/10`;
    } else {
      scoreLine = `has a score of ${score}/10`;
    }
  }

  const statusLine = {
    FINISHED: 'The series has completed its run',
    RELEASING: 'New episodes are currently airing',
    NOT_YET_RELEASED: 'The series has not yet premiered',
    CANCELLED: 'The series was cancelled before completion',
    HIATUS: 'The series is currently on hiatus',
    Finished: 'The series has completed its run',
    Currently_Airing: 'New episodes are currently airing',
    Not_yet_aired: 'The series has not yet premiered',
  }[m.status] || 'The current airing status is being tracked';

  return (
    `On BOSS Anime Club, ${esc(title)} is filed under ${esc(genreList)} ` +
    `and ${scoreLine}. ${statusLine}, and it was produced by ` +
    `${esc(studio)}${year !== 'N/A' ? ` starting in ${esc(String(year))}` : ''}. ` +
    `Use this page to check the synopsis, genres, episode information, ` +
    `and listen to the available device narration.`
  );
}

function pageHTML(m) {
  const title =
    m.title?.english ||
    m.title?.romaji ||
    m.title?.native ||
    'Untitled';

  const img =
    m.coverImage?.extraLarge ||
    m.coverImage?.large ||
    '';

  const synopsis = cleanText(m.description, 700);
  const genres = Array.isArray(m.genres) ? m.genres : [];

  const studio =
    (m.studios?.nodes || [])
      .map((s) => s?.name)
      .filter(Boolean)
      .join(', ') ||
    'Unknown';

  const year = m.startDate?.year || 'N/A';

  const score =
    m.averageScore != null
      ? (Number(m.averageScore) / 10).toFixed(1)
      : '—';

  const episodes = m.episodes || '—';

  const url =
    `${SITE_URL}/anime/${slugify(title)}-${m.id}.html`;

  const editorNote = buildEditorNote(
    m,
    title,
    genres,
    studio,
    year,
    score
  );

  const speakText =
    `${synopsis || 'No synopsis available.'} ` +
    cleanText(editorNote, 900);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: title,
    url,
    image: img || undefined,
    description: synopsis || `Information about ${title}.`,
    genre: genres,
    datePublished: year !== 'N/A' ? String(year) : undefined,
    numberOfEpisodes:
      m.episodes != null ? Number(m.episodes) : undefined,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} &mdash; Watch Guide, Info &amp; Episodes | BOSS Anime Club</title>
<meta name="description" content="${esc(
    `${title} (${year}) — ${synopsis.slice(0, 150)}`
  )}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta property="og:description" content="${esc(synopsis.slice(0, 200))}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:type" content="video.tv_show">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta name="twitter:description" content="${esc(synopsis.slice(0, 200))}">
<meta name="twitter:image" content="${esc(img)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${ANALYTICS_SCRIPT}
<style>
*{box-sizing:border-box}
html{background:#0E1116}
body{
  background:#0E1116;
  color:#F4F1EA;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  max-width:760px;
  margin:0 auto;
  padding:24px 16px 60px;
  line-height:1.65;
}
a{color:#FFB454}
h1{line-height:1.25;margin-bottom:18px}
img{
  width:220px;
  max-width:100%;
  border-radius:8px;
  display:block;
  margin-bottom:18px;
}
.meta{
  font-size:14px;
  color:#8B93A7;
  margin-bottom:14px;
}
.tag{
  display:inline-block;
  font-size:12px;
  border:1px solid #2A3140;
  border-radius:4px;
  padding:3px 9px;
  margin:2px 4px 2px 0;
  color:#AEB6C8;
}
.editor-note{
  border-left:2px solid #FFB454;
  padding:11px 14px;
  margin:22px 0;
  background:#171B24;
  font-size:14px;
}
.backlink{
  margin-top:18px;
  display:block;
}
.listen-btn{
  font-family:inherit;
  font-size:13px;
  letter-spacing:.3px;
  text-transform:uppercase;
  background:#171B24;
  border:1px solid #5B8DEF;
  color:#F4F1EA;
  padding:10px 16px;
  border-radius:7px;
  cursor:pointer;
  display:inline-flex;
  align-items:center;
  gap:7px;
  margin:10px 0;
}
.listen-btn:disabled{
  opacity:.5;
  cursor:default;
}
.listen-status{
  font-size:12px;
  color:#8B93A7;
  margin-left:8px;
}
.source{
  margin-top:28px;
  font-size:12px;
  color:#777F91;
}
</style>
</head>
<body>

<h1>${esc(title)}</h1>

${
  img
    ? `<img src="${esc(img)}" alt="${esc(title)} cover" loading="lazy">`
    : ''
}

<div class="meta">
Score: ${esc(score)}/10
&nbsp;&middot;&nbsp;
Episodes: ${esc(episodes)}
&nbsp;&middot;&nbsp;
Year: ${esc(year)}
&nbsp;&middot;&nbsp;
Studio: ${esc(studio)}
</div>

<div>
${genres
  .map((g) => `<span class="tag">${esc(g)}</span>`)
  .join('')}
</div>

<p>${esc(synopsis) || 'No synopsis available.'}</p>

<div class="editor-note">
${editorNote}
</div>

<div class="listen-row">
<button
  class="listen-btn"
  id="listenBtn"
  type="button"
  aria-label="Listen to anime information"
>&#128266; Listen</button>
<span class="listen-status" id="listenStatus"></span>
</div>

<a class="backlink" href="${SITE_URL}/">
&#9656; Open BOSS Anime Club
</a>

<a class="backlink" href="${SITE_URL}/anime/index.html">
&#9656; Browse all anime
</a>

<div class="source">
Anime information is automatically generated and may be updated over time.
</div>

<script>
(function () {
  'use strict';

  var btn = document.getElementById('listenBtn');
  var status = document.getElementById('listenStatus');
  var text = ${JSON.stringify(speakText)};

  var LABEL_LISTEN = '\\uD83D\\uDD0A Listen';
  var LABEL_STOP = '\\u23F9 Stop';

  if (!('speechSynthesis' in window) ||
      !('SpeechSynthesisUtterance' in window)) {
    btn.disabled = true;
    status.textContent = 'Voice is not supported on this browser/device.';
    return;
  }

  var speaking = false;

  btn.addEventListener('click', function () {
    if (speaking) {
      window.speechSynthesis.cancel();
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = '';
      return;
    }

    window.speechSynthesis.cancel();

    var utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.95;
    utterance.pitch = 1;

    utterance.onstart = function () {
      speaking = true;
      btn.textContent = LABEL_STOP;
      status.textContent = 'Playing...';
    };

    utterance.onend = function () {
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = '';
    };

    utterance.onerror = function () {
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = 'Could not play audio.';
    };

    window.speechSynthesis.speak(utterance);
  });

  window.addEventListener('beforeunload', function () {
    window.speechSynthesis.cancel();
  });
})();
</script>

</body>
</html>`;
}

function indexHTML(list) {
  const rows = list
    .map((m) => {
      const title =
        m.title?.english ||
        m.title?.romaji ||
        m.title?.native ||
        'Untitled';

      const fileName =
        `${slugify(title)}-${m.id}.html`;

      return `
<li>
  <a href="./${esc(fileName)}">${esc(title)}</a>
</li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Browse All Anime | BOSS Anime Club</title>
<meta name="description" content="Browse anime on BOSS Anime Club — information, episodes, genres and more.">
<link rel="canonical" href="${SITE_URL}/anime/index.html">
${ANALYTICS_SCRIPT}
<style>
body{
  background:#0E1116;
  color:#F4F1EA;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  max-width:760px;
  margin:0 auto;
  padding:24px 16px 60px;
  line-height:1.6;
}
a{color:#FFB454;text-decoration:none}
a:hover{text-decoration:underline}
li{margin-bottom:9px}
</style>
</head>
<body>
<h1>Browse All Anime</h1>
<p>
<a href="${SITE_URL}/">&#8592; Back to BOSS Anime Club</a>
</p>
<ul>
${rows}
</ul>
</body>
</html>`;
}

function sitemapXML(list) {
  const today = new Date().toISOString().slice(0, 10);

  const urls = list
    .map((m) => {
      const title =
        m.title?.english ||
        m.title?.romaji ||
        m.title?.native ||
        'Untitled';

      const slug = slugify(title);
      const url =
        `${SITE_URL}/anime/${slug}-${m.id}.html`;

      return `  <url>
    <loc>${esc(url)}</loc>
    <lastmod>${today}</lastmod>
  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <priority>1.0</priority>
    <lastmod>${today}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/anime/index.html</loc>
    <priority>0.8</priority>
    <lastmod>${today}</lastmod>
  </url>
${urls}
</urlset>
`;
}

async function removeStalePages(list) {
  const currentFiles = new Set(
    list.map((m) => {
      const title =
        m.title?.english ||
        m.title?.romaji ||
        m.title?.native ||
        'Untitled';

      return `${slugify(title)}-${m.id}.html`;
    })
  );

  let existingFiles = [];

  try {
    existingFiles = await readdir(OUT_DIR);
  } catch {
    return 0;
  }

  let deletedCount = 0;

  for (const file of existingFiles) {
    if (file === 'index.html') continue;
    if (!file.endsWith('.html')) continue;
    if (currentFiles.has(file)) continue;

    try {
      await unlink(path.join(OUT_DIR, file));
      deletedCount++;
      console.log(`Deleted stale page: ${file}`);
    } catch (error) {
      console.warn(
        `Could not delete stale page ${file}:`,
        error?.message || error
      );
    }
  }

  return deletedCount;
}

async function main() {
  console.log('');
  console.log('==========================================');
  console.log('BOSS Anime Club');
  console.log('Static SEO Page Generator');
  console.log('==========================================');

  const result = await fetchAllAnime();
  const list = result.list;

  console.log('');
  console.log(`API source: ${result.source}`);
  console.log(`Fetched: ${list.length} anime`);

  // SAFETY STOP:
  // Never delete or overwrite existing generated pages when APIs fail.
  if (!list.length) {
    const existing = await hasExistingAnimePages();

    console.error('');
    console.error('==========================================');
    console.error('NO FRESH ANIME DATA');
    console.error('==========================================');
    console.error('AniList and Jikan were unavailable.');

    if (existing) {
      console.log(
        'Existing anime pages were found. Nothing was deleted or overwritten.'
      );
      console.log(
        'The workflow will finish successfully so a temporary API outage does not make GitHub Actions red.'
      );
      console.log('==========================================');
      return;
    }

    console.error(
      'No existing anime pages were found. Nothing was changed.'
    );
    console.error(
      'Try running the workflow again later.'
    );
    console.error('==========================================');

    // First run: no pages exist, so report the problem.
    // We intentionally exit 0 to avoid a destructive/false-red build.
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let generatedCount = 0;

  for (const anime of list) {
    const title =
      anime.title?.english ||
      anime.title?.romaji ||
      anime.title?.native ||
      'Untitled';

    const fileName =
      `${slugify(title)}-${anime.id}.html`;

    const filePath =
      path.join(OUT_DIR, fileName);

    await writeFile(
      filePath,
      pageHTML(anime),
      'utf8'
    );

    generatedCount++;
  }

  // Cleanup is allowed ONLY because fresh data was received.
  const deletedCount = await removeStalePages(list);

  await writeFile(
    path.join(OUT_DIR, 'index.html'),
    indexHTML(list),
    'utf8'
  );

  await writeFile(
    path.join(process.cwd(), 'sitemap.xml'),
    sitemapXML(list),
    'utf8'
  );

  console.log('');
  console.log('==========================================');
  console.log('BUILD SUCCESS');
  console.log('==========================================');
  console.log(`API source       : ${result.source}`);
  console.log(`Anime generated  : ${generatedCount}`);
  console.log(`Stale pages      : ${deletedCount}`);
  console.log('Index generated  : anime/index.html');
  console.log('Sitemap generated: sitemap.xml');
  console.log('==========================================');
}

main().catch((error) => {
  console.error('');
  console.error('==========================================');
  console.error('BUILD ERROR');
  console.error('==========================================');
  console.error(error?.stack || error?.message || error);
  console.error('==========================================');
  process.exit(1);
});

