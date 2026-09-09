// scripts/generate-anime-pages.mjs
//
// BOSS Anime Club - SEO static anime page generator
//
// Primary source: AniList GraphQL
// Fallback source: Jikan / MyAnimeList API
//
// IMPORTANT:
// - AniList/Jikan temporary 403/429/5xx errors do NOT delete old pages.
// - Partial API results are accepted and generated.
// - Stale-page cleanup happens ONLY when a complete 200-anime dataset is fetched.
// - If both APIs fail completely, the workflow exits successfully and preserves
//   the existing anime pages/index/sitemap.
//
// Output:
//   anime/<slug>-<id>.html
//   anime/index.html
//   sitemap.xml

import {
  writeFile,
  mkdir,
  readdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const SITE_URL = 'https://anime.is-cool.dev';
const OUT_DIR = path.join(process.cwd(), 'anime');

const ANILIST_PAGES = 5;
const ANILIST_PER_PAGE = 40;

const JIKAN_PAGES = 8;
const JIKAN_PER_PAGE = 25;

const ANILIST_API = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4/top/anime';

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
};

const ANALYTICS_SCRIPT =
  '<script defer src="https://analytics.open-domains.com/script.js" data-website-id="c72153eb-a0fc-4580-bae2-76db6e9a799c"></script>';

const ANILIST_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      currentPage
      lastPage
      hasNextPage
    }
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

function cleanText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(title) {
  return String(title || 'untitled')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'untitled';
}

function normalizeAniListAnime(m) {
  return {
    id: Number(m?.id),
    title: m?.title?.english || m?.title?.romaji || m?.title?.native || 'Untitled',
    image: m?.coverImage?.extraLarge || m?.coverImage?.large || '',
    banner: m?.bannerImage || '',
    score: Number.isFinite(m?.averageScore) ? Number(m.averageScore) / 10 : null,
    episodes: m?.episodes ?? null,
    format: m?.format || '',
    status: m?.status || '',
    genres: Array.isArray(m?.genres) ? m.genres : [],
    synopsis: cleanText(m?.description || ''),
    year: m?.startDate?.year ?? null,
    studios: Array.isArray(m?.studios?.nodes)
      ? m.studios.nodes.map((s) => s?.name).filter(Boolean)
      : [],
    source: 'AniList',
  };
}

function normalizeJikanAnime(m) {
  const genres = [
    ...(Array.isArray(m?.genres) ? m.genres.map((g) => g?.name) : []),
    ...(Array.isArray(m?.themes) ? m.themes.map((g) => g?.name) : []),
  ].filter(Boolean);

  const studios = Array.isArray(m?.studios)
    ? m.studios.map((s) => s?.name).filter(Boolean)
    : [];

  return {
    id: Number(m?.mal_id),
    title: m?.title_english || m?.title || m?.title_japanese || 'Untitled',
    image: m?.images?.jpg?.large_image_url ||
      m?.images?.jpg?.image_url ||
      m?.images?.webp?.large_image_url ||
      '',
    banner: '',
    score: Number.isFinite(m?.score) ? Number(m.score) : null,
    episodes: m?.episodes ?? null,
    format: m?.type || '',
    status: m?.status || '',
    genres,
    synopsis: cleanText(m?.synopsis || ''),
    year: m?.year ?? (m?.aired?.from ? Number(String(m.aired.from).slice(0, 4)) : null),
    studios,
    source: 'Jikan',
  };
}

async function fetchJsonWithRetry(url, options = {}, maxAttempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          ...REQUEST_HEADERS,
          ...(options.headers || {}),
        },
      });

      const text = await res.text();

      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON response.
      }

      if (res.ok) {
        return { ok: true, status: res.status, json };
      }

      const retryable =
        res.status === 403 ||
        res.status === 408 ||
        res.status === 429 ||
        res.status >= 500;

      const message =
        json?.errors?.[0]?.message ||
        json?.message ||
        `HTTP ${res.status}`;

      lastError = new Error(message);

      console.error(
        `Request failed: ${url} -> HTTP ${res.status} (attempt ${attempt}/${maxAttempts})`
      );

      if (!retryable || attempt === maxAttempts) break;

      const waitMs = Math.min(15000, 2000 * attempt * attempt);
      console.log(`Retrying in ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      console.error(
        `Network error: ${url} (attempt ${attempt}/${maxAttempts}): ${error?.message || error}`
      );

      if (attempt === maxAttempts) break;

      const waitMs = Math.min(15000, 2000 * attempt * attempt);
      console.log(`Retrying in ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }

  return {
    ok: false,
    status: 0,
    json: null,
    error: lastError,
  };
}

async function fetchAniListPage(page) {
  console.log(`AniList: fetching page ${page}/${ANILIST_PAGES}...`);

  const result = await fetchJsonWithRetry(
    ANILIST_API,
    {
      method: 'POST',
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: {
          page,
          perPage: ANILIST_PER_PAGE,
        },
      }),
    },
    3
  );

  if (!result.ok) return null;

  const media = result.json?.data?.Page?.media;
  if (!Array.isArray(media)) return null;

  return media.map(normalizeAniListAnime).filter((a) => a.id);
}

async function fetchFromAniList() {
  const all = [];
  const seen = new Set();
  let complete = true;

  for (let page = 1; page <= ANILIST_PAGES; page++) {
    const data = await fetchAniListPage(page);

    if (!data || data.length === 0) {
      complete = false;
      console.warn(`AniList unavailable/empty on page ${page}.`);
      break;
    }

    for (const anime of data) {
      if (!seen.has(anime.id)) {
        seen.add(anime.id);
        all.push(anime);
      }
    }

    await sleep(900);
  }

  return {
    anime: all,
    complete: complete && all.length >= ANILIST_PAGES * ANILIST_PER_PAGE,
    source: 'AniList',
  };
}

async function fetchJikanPage(page) {
  const url = `${JIKAN_API}?page=${page}&limit=${JIKAN_PER_PAGE}`;

  console.log(`Jikan: fetching page ${page}/${JIKAN_PAGES}...`);

  const result = await fetchJsonWithRetry(url, {}, 4);

  if (!result.ok) return null;

  const data = result.json?.data;
  if (!Array.isArray(data)) return null;

  return data.map(normalizeJikanAnime).filter((a) => a.id);
}

async function fetchFromJikan() {
  const all = [];
  const seen = new Set();
  let complete = true;

  for (let page = 1; page <= JIKAN_PAGES; page++) {
    const data = await fetchJikanPage(page);

    if (!data || data.length === 0) {
      complete = false;
      console.warn(`Jikan unavailable/empty on page ${page}.`);
      break;
    }

    for (const anime of data) {
      if (!seen.has(anime.id)) {
        seen.add(anime.id);
        all.push(anime);
      }
    }

    // Jikan rate-limit friendly delay.
    await sleep(1200);
  }

  return {
    anime: all,
    complete: complete && all.length >= JIKAN_PAGES * JIKAN_PER_PAGE,
    source: 'Jikan',
  };
}

async function fetchAllAnime() {
  console.log('');
  console.log('==============================================');
  console.log('BOSS Anime Club - SEO Generator');
  console.log('==============================================');

  const aniList = await fetchFromAniList();

  if (aniList.anime.length > 0) {
    console.log(
      `AniList returned ${aniList.anime.length} anime. Complete: ${aniList.complete}`
    );
    return aniList;
  }

  console.warn('');
  console.warn('AniList unavailable. Switching to Jikan fallback...');
  console.warn('');

  const jikan = await fetchFromJikan();

  if (jikan.anime.length > 0) {
    console.log(
      `Jikan returned ${jikan.anime.length} anime. Complete: ${jikan.complete}`
    );
    return jikan;
  }

  console.error('');
  console.error('BOTH APIS FAILED.');
  console.error('No new anime data was received.');
  console.error('Existing generated files will be preserved.');
  console.error('');

  return {
    anime: [],
    complete: false,
    source: 'none',
  };
}

function buildEditorNote(anime) {
  const title = anime.title;
  const genres = anime.genres.length
    ? anime.genres.slice(0, 3).join(', ')
    : 'multiple genres';

  const scoreText =
    anime.score != null
      ? `has a community score of ${anime.score.toFixed(1)}/10`
      : 'does not currently have a community score';

  const statusText = {
    FINISHED: 'The series has completed its run',
    RELEASING: 'New episodes are currently airing',
    'NOT_YET_RELEASED': 'The series has not yet premiered',
    CANCELLED: 'The series was cancelled before completion',
    HIATUS: 'The series is currently on hiatus',
    Finished: 'The series has completed its run',
    'Currently Airing': 'New episodes are currently airing',
    'Not yet aired': 'The series has not yet premiered',
  }[anime.status] || 'Its current airing status is tracked on this page';

  const studio = anime.studios.length
    ? anime.studios.join(', ')
    : 'an unlisted studio';

  const yearText = anime.year ? ` starting in ${anime.year}` : '';

  return `On BOSS Anime Club, ${title} is listed under ${genres} and ${scoreText}. ${statusText}, and it was produced by ${studio}${yearText}. This page provides a concise anime guide with synopsis, score, episodes, genres and studio information.`;
}

function pageHTML(anime) {
  const title = anime.title || 'Untitled';
  const image = anime.image || '';
  const synopsis =
    anime.synopsis.slice(0, 500) || 'No synopsis is currently available.';
  const score =
    anime.score != null ? anime.score.toFixed(1) : '—';
  const episodes =
    anime.episodes != null ? String(anime.episodes) : '—';
  const year =
    anime.year != null ? String(anime.year) : 'N/A';
  const studio =
    anime.studios.length ? anime.studios.join(', ') : 'Unknown';
  const genres =
    anime.genres.length ? anime.genres : ['Anime'];

  const url = `${SITE_URL}/anime/${slugify(title)}-${anime.id}.html`;
  const editorNote = buildEditorNote(anime);
  const speakText = cleanText(`${synopsis} ${editorNote}`);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: title,
    image: image || undefined,
    description: synopsis,
    genre: genres,
    datePublished: anime.year ? String(anime.year) : undefined,
    numberOfEpisodes: anime.episodes ?? undefined,
    aggregateRating: anime.score != null
      ? {
          '@type': 'AggregateRating',
          ratingValue: anime.score.toFixed(1),
          bestRating: '10',
          worstRating: '0',
        }
      : undefined,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="https://i.ibb.co/gLCc0JMk/favicon.jpg" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="https://i.ibb.co/DfcR4K8p/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="https://i.ibb.co/spHRWLbb/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="https://i.ibb.co/BKNyQpj6/favicon-48.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://i.ibb.co/JFrhqwwT/favicon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="https://i.ibb.co/VYFv3GrN/apple-touch-icon.png">

<title>${esc(title)} &mdash; Watch Guide, Info &amp; Episodes | BOSS Anime Club</title>
<meta name="description" content="${esc(title)} (${esc(year)}) &mdash; ${esc(synopsis.slice(0, 155))}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow">
<meta property="og:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta property="og:description" content="${esc(synopsis.slice(0, 200))}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:type" content="video.tv_show">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta name="twitter:description" content="${esc(synopsis.slice(0, 200))}">
<meta name="twitter:image" content="${esc(image)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${ANALYTICS_SCRIPT}
<style>
*{box-sizing:border-box}
body{background:#0E1116;color:#F4F1EA;font-family:Arial,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px 60px;line-height:1.65}
a{color:#FFB454}
img{max-width:260px;width:100%;border-radius:8px;display:block;margin:0 0 18px}
h1{line-height:1.25}
.meta{font-size:14px;color:#9AA3B5;margin-bottom:16px}
.tags{margin:12px 0}
.tag{display:inline-block;font-size:12px;border:1px solid #2A3140;border-radius:5px;padding:3px 9px;margin:3px;color:#AAB3C5}
.editor-note{border-left:3px solid #FFB454;padding:12px 15px;margin:22px 0;background:#171B24;font-size:14px}
.listen-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}
.listen-btn{font:inherit;font-size:13px;text-transform:uppercase;background:#171B24;border:1px solid #5B8DEF;color:#F4F1EA;padding:10px 16px;border-radius:7px;cursor:pointer}
.listen-btn:hover{border-color:#8BB2FF}
.listen-btn:disabled{opacity:.5;cursor:not-allowed}
.listen-status{font-size:12px;color:#8B93A7}
.backlink{display:block;margin-top:14px;text-decoration:none}
.source{margin-top:28px;font-size:12px;color:#737C8F}
</style>
</head>
<body>
<h1>${esc(title)}</h1>

${image ? `<img src="${esc(image)}" alt="${esc(title)} cover" loading="lazy">` : ''}

<div class="meta">
Score: ${esc(score)}/10
&nbsp;&middot;&nbsp; Episodes: ${esc(episodes)}
&nbsp;&middot;&nbsp; Year: ${esc(year)}
&nbsp;&middot;&nbsp; Studio: ${esc(studio)}
</div>

<div class="tags">
${genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
</div>

<h2>Synopsis</h2>
<p>${esc(synopsis)}</p>

<div class="editor-note">${esc(editorNote)}</div>

<div class="listen-row">
<button class="listen-btn" id="listenBtn" type="button">&#128266; Listen</button>
<span class="listen-status" id="listenStatus"></span>
</div>

<a class="backlink" href="${esc(SITE_URL)}/">&#9656; Open BOSS Anime Club</a>
<a class="backlink" href="${esc(SITE_URL)}/anime/index.html">&#9656; Browse all anime</a>

<div class="source">
Anime information is automatically generated and may be updated over time.
</div>

<script>
(function(){
  var btn = document.getElementById('listenBtn');
  var status = document.getElementById('listenStatus');
  var text = ${JSON.stringify(speakText)};
  var LABEL_LISTEN = '\\uD83D\\uDD0A Listen';
  var LABEL_STOP = '\\u23F9 Stop';

  if (!('speechSynthesis' in window)) {
    btn.disabled = true;
    status.textContent = 'Speech is not supported on this browser/device.';
    return;
  }

  var speaking = false;

  btn.addEventListener('click', function(){
    if (speaking) {
      window.speechSynthesis.cancel();
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = '';
      return;
    }

    window.speechSynthesis.cancel();

    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 1;
    utter.pitch = 1;

    utter.onstart = function(){
      speaking = true;
      btn.textContent = LABEL_STOP;
      status.textContent = 'Playing...';
    };

    utter.onend = function(){
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = '';
    };

    utter.onerror = function(){
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = 'Could not play audio.';
    };

    window.speechSynthesis.speak(utter);
  });
})();
</script>
</body>
</html>`;
}

function indexHTML(list, source) {
  const rows = list.map((anime) => {
    const title = anime.title || 'Untitled';
    const file = `${slugify(title)}-${anime.id}.html`;
    return `<li><a href="./${esc(file)}">${esc(title)}</a></li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="https://i.ibb.co/gLCc0JMk/favicon.jpg" sizes="any">
<link rel="icon" type="image/png" sizes="16x16" href="https://i.ibb.co/DfcR4K8p/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="https://i.ibb.co/spHRWLbb/favicon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="https://i.ibb.co/BKNyQpj6/favicon-48.png">
<link rel="icon" type="image/png" sizes="192x192" href="https://i.ibb.co/JFrhqwwT/favicon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="https://i.ibb.co/VYFv3GrN/apple-touch-icon.png">

<title>Browse All Anime | BOSS Anime Club</title>
<meta name="description" content="Browse anime on BOSS Anime Club with synopsis, episodes, genres, scores and studio information.">
<link rel="canonical" href="${SITE_URL}/anime/index.html">
<meta name="robots" content="index,follow">
${ANALYTICS_SCRIPT}
<style>
body{background:#0E1116;color:#F4F1EA;font-family:Arial,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px 60px;line-height:1.6}
a{color:#FFB454;text-decoration:none}
li{margin-bottom:8px}
.info{color:#8B93A7;font-size:13px}
</style>
</head>
<body>
<h1>Browse All Anime</h1>
<p><a href="${SITE_URL}/">&#9664; Back to BOSS Anime Club</a></p>
<p class="info">Generated from ${esc(source)}. ${list.length} anime pages are currently available.</p>
<ul>
${rows}
</ul>
</body>
</html>`;
}

function sitemapXML(list) {
  const today = new Date().toISOString().slice(0, 10);

  const urls = list.map((anime) => {
    const title = anime.title || 'Untitled';
    const file = `${slugify(title)}-${anime.id}.html`;

    return `  <url>
    <loc>${esc(SITE_URL)}/anime/${esc(file)}</loc>
    <lastmod>${today}</lastmod>
  </url>`;
  }).join('\n');

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
</urlset>`;
}

async function removeStalePages(currentFiles) {
  const existingFiles = await readdir(OUT_DIR);
  let deletedCount = 0;

  for (const file of existingFiles) {
    if (file === 'index.html') continue;
    if (!file.endsWith('.html')) continue;

    if (!currentFiles.has(file)) {
      try {
        await unlink(path.join(OUT_DIR, file));
        deletedCount++;
        console.log(`Deleted stale page: ${file}`);
      } catch (error) {
        console.warn(`Could not delete ${file}: ${error?.message || error}`);
      }
    }
  }

  return deletedCount;
}

async function main() {
  const result = await fetchAllAnime();

  if (result.anime.length === 0) {
    console.log('==============================================');
    console.log('NO DATA - SAFE STOP');
    console.log('==============================================');
    console.log('No files were deleted or overwritten.');
    console.log('Existing anime pages, index and sitemap are preserved.');
    console.log('GitHub Actions will finish successfully.');
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  const currentFiles = new Set();
  let generatedCount = 0;

  for (const anime of result.anime) {
    const fileName = `${slugify(anime.title)}-${anime.id}.html`;
    currentFiles.add(fileName);

    await writeFile(
      path.join(OUT_DIR, fileName),
      pageHTML(anime),
      'utf8'
    );

    generatedCount++;
  }

  // IMPORTANT:
  // Never clean old pages from partial API data.
  // Cleanup is allowed only when all requested pages were successfully fetched.
  let deletedCount = 0;

  if (result.complete && result.anime.length >= 200) {
    deletedCount = await removeStalePages(currentFiles);
  } else {
    console.log('');
    console.log('Partial API dataset detected.');
    console.log('SAFE MODE: stale anime pages were NOT deleted.');
  }

  await writeFile(
    path.join(OUT_DIR, 'index.html'),
    indexHTML(result.anime, result.source),
    'utf8'
  );

  await writeFile(
    path.join(process.cwd(), 'sitemap.xml'),
    sitemapXML(result.anime),
    'utf8'
  );

  console.log('');
  console.log('==============================================');
  console.log('BUILD SUCCESS');
  console.log('==============================================');
  console.log(`API source       : ${result.source}`);
  console.log(`Anime generated  : ${generatedCount}`);
  console.log(`Stale deleted    : ${deletedCount}`);
  console.log('Index generated  : anime/index.html');
  console.log('Sitemap generated: sitemap.xml');
  console.log(`Dataset complete : ${result.complete ? 'YES' : 'NO (safe partial mode)'}`);
  console.log('==============================================');
}

main().catch((error) => {
  // Do not destroy generated files if something unexpected happens.
  console.error('');
  console.error('==============================================');
  console.error('GENERATOR ERROR');
  console.error('==============================================');
  console.error(error?.stack || error?.message || error);
  console.error('Existing files were not intentionally deleted.');
  process.exit(1);
});

