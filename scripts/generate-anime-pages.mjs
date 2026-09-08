// scripts/generate-anime-pages.mjs
//
// BOSS Anime Club - Static Anime SEO Page Generator
//
// Primary API:
//   AniList GraphQL
//
// Fallback API:
//   Jikan / MyAnimeList public API
//
// Output:
//   /anime/<slug>-<id>.html
//   /anime/index.html
//   /sitemap.xml
//
// IMPORTANT SAFETY:
// Agar dono APIs se data nahi milta, script koi existing anime file
// delete/overwrite nahi karegi.
//
// GitHub Actions ke liye designed.
//

import {
  writeFile,
  mkdir,
  readdir,
  unlink,
} from 'node:fs/promises';

import path from 'node:path';


// ============================================================
// CONFIG
// ============================================================

const SITE_URL = 'https://anime.is-cool.dev';

const OUT_DIR = path.join(process.cwd(), 'anime');

const TARGET_COUNT = 200;

// AniList allows large pages.
// 5 x 40 = 200.
const ANILIST_PER_PAGE = 40;
const ANILIST_MAX_PAGES = 5;

// Jikan normally returns 25 items per page.
// 8 x 25 = 200.
const JIKAN_PER_PAGE = 25;
const JIKAN_MAX_PAGES = 8;

const ANILIST_API = 'https://graphql.anilist.co';

const JIKAN_API = 'https://api.jikan.moe/v4/top/anime';


// ============================================================
// ANALYTICS
// ============================================================

const ANALYTICS_SCRIPT =
  '<script defer src="https://analytics.open-domains.com/script.js" ' +
  'data-website-id="c72153eb-a0fc-4580-bae2-76db6e9a799c"></script>';


// ============================================================
// BROWSER-LIKE HEADERS
// ============================================================

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
};


// ============================================================
// ANILIST QUERY
// ============================================================

const ANILIST_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        currentPage
        hasNextPage
        total
      }

      media(
        sort: POPULARITY_DESC
        type: ANIME
      ) {
        id

        title {
          romaji
          english
          native
        }

        coverImage {
          extraLarge
          large
          medium
        }

        bannerImage

        averageScore
        episodes
        format
        status
        genres

        description(asHtml: false)

        startDate {
          year
          month
          day
        }

        studios(
          isMain: true
        ) {
          nodes {
            name
          }
        }
      }
    }
  }
`;


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}


function escapeAttr(value) {
  return esc(value);
}


function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


function truncate(value, maxLength) {
  const text = String(value ?? '').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}


function slugify(title) {
  return String(title || 'untitled')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    || 'untitled';
}


function getTitle(anime) {
  return (
    anime?.title?.english ||
    anime?.title?.romaji ||
    anime?.title?.native ||
    'Untitled Anime'
  );
}


function getImage(anime) {
  return (
    anime?.coverImage?.extraLarge ||
    anime?.coverImage?.large ||
    anime?.coverImage?.medium ||
    ''
  );
}


function getStudio(anime) {
  return (
    (anime?.studios?.nodes || [])
      .map((studio) => studio?.name)
      .filter(Boolean)
      .join(', ') ||
    'Unknown Studio'
  );
}


function getYear(anime) {
  return anime?.startDate?.year || 'N/A';
}


function getScore(anime) {
  if (
    anime?.averageScore === null ||
    anime?.averageScore === undefined
  ) {
    return '—';
  }

  const score = Number(anime.averageScore);

  if (!Number.isFinite(score)) {
    return '—';
  }

  return (score / 10).toFixed(1);
}


function getEpisodes(anime) {
  return anime?.episodes || '—';
}


function getGenres(anime) {
  return Array.isArray(anime?.genres)
    ? anime.genres.filter(Boolean)
    : [];
}


function getStatusText(status) {
  const map = {
    FINISHED: 'Finished',
    RELEASING: 'Currently Airing',
    NOT_YET_RELEASED: 'Not Yet Released',
    CANCELLED: 'Cancelled',
    HIATUS: 'On Hiatus',
  };

  return map[status] || 'Unknown';
}


// ============================================================
// ANILIST FETCH
// ============================================================

async function fetchAniListPage(page, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `AniList: fetching page ${page} ` +
        `(attempt ${attempt}/${maxAttempts})...`
      );

      const response = await fetch(ANILIST_API, {
        method: 'POST',
        headers: REQUEST_HEADERS,
        body: JSON.stringify({
          query: ANILIST_QUERY,
          variables: {
            page,
            perPage: ANILIST_PER_PAGE,
          },
        }),
      });


      // --------------------------------------------------------
      // SUCCESS
      // --------------------------------------------------------

      if (response.ok) {
        let json;

        try {
          json = await response.json();
        } catch (error) {
          console.error(
            'AniList returned invalid JSON:',
            error?.message || error
          );

          if (attempt < maxAttempts) {
            await sleep(5000 * attempt);
            continue;
          }

          return null;
        }


        // ------------------------------------------------------
        // GRAPHQL ERRORS
        // ------------------------------------------------------

        if (Array.isArray(json?.errors) && json.errors.length > 0) {
          console.error(
            'AniList GraphQL error:',
            JSON.stringify(json.errors, null, 2)
          );

          return null;
        }


        return json?.data?.Page || null;
      }


      // --------------------------------------------------------
      // HTTP ERROR
      // --------------------------------------------------------

      const status = response.status;

      let body = '';

      try {
        body = await response.text();
      } catch {
        body = '';
      }


      console.error(
        `AniList HTTP ${status} on page ${page} ` +
        `(attempt ${attempt}/${maxAttempts})`
      );


      if (body) {
        console.error(
          `AniList response: ${body.slice(0, 800)}`
        );
      }


      // --------------------------------------------------------
      // 403
      // DO NOT WASTE RETRIES
      // --------------------------------------------------------

      if (status === 403) {
        console.error(
          'AniList returned HTTP 403. ' +
          'The GitHub Actions runner may be blocked/restricted. ' +
          'Switching to Jikan fallback.'
        );

        return null;
      }


      // --------------------------------------------------------
      // RETRYABLE
      // --------------------------------------------------------

      const retryable =
        status === 429 ||
        status === 408 ||
        status >= 500;


      if (retryable && attempt < maxAttempts) {
        const retryAfterHeader =
          response.headers.get('retry-after');

        const retryAfterSeconds =
          Number(retryAfterHeader);

        const waitMs =
          Number.isFinite(retryAfterSeconds) &&
          retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : 5000 * attempt;


        console.log(
          `AniList temporary error. ` +
          `Retrying in ${Math.ceil(waitMs / 1000)} seconds...`
        );

        await sleep(waitMs);
        continue;
      }


      return null;

    } catch (error) {
      console.error(
        `AniList network error on page ${page}:`,
        error?.message || error
      );


      if (attempt < maxAttempts) {
        const waitMs = 5000 * attempt;

        console.log(
          `Retrying AniList in ` +
          `${Math.ceil(waitMs / 1000)} seconds...`
        );

        await sleep(waitMs);
        continue;
      }


      return null;
    }
  }


  return null;
}


// ============================================================
// FETCH ALL FROM ANILIST
// ============================================================

async function fetchFromAniList() {
  const all = [];
  const seen = new Set();


  for (
    let page = 1;
    page <= ANILIST_MAX_PAGES;
    page++
  ) {
    const pageData =
      await fetchAniListPage(page);


    if (!pageData) {
      console.error(
        `AniList failed on page ${page}.`
      );

      return [];
    }


    const media =
      Array.isArray(pageData.media)
        ? pageData.media
        : [];


    if (media.length === 0) {
      console.error(
        `AniList returned 0 anime on page ${page}.`
      );

      break;
    }


    for (const anime of media) {
      if (!anime?.id) {
        continue;
      }

      if (seen.has(anime.id)) {
        continue;
      }

      seen.add(anime.id);
      all.push(anime);


      if (all.length >= TARGET_COUNT) {
        break;
      }
    }


    console.log(
      `AniList: collected ${all.length}/${TARGET_COUNT}`
    );


    if (all.length >= TARGET_COUNT) {
      break;
    }


    if (pageData.pageInfo?.hasNextPage === false) {
      break;
    }


    await sleep(1500);
  }


  return all.slice(0, TARGET_COUNT);
}


// ============================================================
// NORMALIZE JIKAN DATA
// ============================================================

function normalizeJikanAnime(item) {
  if (!item?.mal_id) {
    return null;
  }


  const title =
    item.title ||
    item.title_english ||
    item.title_japanese ||
    'Untitled Anime';


  const description =
    item.synopsis ||
    item.background ||
    'No synopsis available.';


  const year =
    item.year ||
    item.aired?.prop?.from?.year ||
    'N/A';


  const image =
    item.images?.jpg?.large_image_url ||
    item.images?.jpg?.image_url ||
    item.images?.webp?.large_image_url ||
    item.images?.webp?.image_url ||
    '';


  const score =
    item.score !== null &&
    item.score !== undefined
      ? Number(item.score)
      : null;


  const genres = [
    ...(item.genres || []),
    ...(item.themes || []),
  ]
    .map((genre) => genre?.name)
    .filter(Boolean);


  return {
    id: `mal-${item.mal_id}`,

    sourceId: item.mal_id,

    source: 'Jikan',

    title: {
      romaji: title,
      english:
        item.title_english ||
        title,
      native:
        item.title_japanese ||
        title,
    },

    coverImage: {
      extraLarge: image,
      large: image,
      medium: image,
    },

    bannerImage: '',

    averageScore: score !== null
      ? score * 10
      : null,

    episodes:
      item.episodes ||
      null,

    format:
      item.type ||
      'TV',

    status:
      item.status === 'Currently Airing'
        ? 'RELEASING'
        : item.status === 'Finished Airing'
          ? 'FINISHED'
          : 'UNKNOWN',

    genres,

    description,

    startDate: {
      year,
      month:
        item.aired?.prop?.from?.month ||
        null,
      day:
        item.aired?.prop?.from?.day ||
        null,
    },

    studios: {
      nodes:
        (item.studios || [])
          .map((studio) => ({
            name: studio?.name,
          }))
          .filter((studio) => studio.name),
    },
  };
}


// ============================================================
// JIKAN FETCH
// ============================================================

async function fetchJikanPage(
  page,
  maxAttempts = 4
) {
  const url =
    `${JIKAN_API}?page=${page}&limit=${JIKAN_PER_PAGE}`;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    try {
      console.log(
        `Jikan: fetching page ${page} ` +
        `(attempt ${attempt}/${maxAttempts})...`
      );


      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'BOSS-Anime-Club-SEO-Generator/1.0',
        },
      });


      if (response.ok) {
        const json = await response.json();

        return json;
      }


      const status = response.status;


      console.error(
        `Jikan HTTP ${status} on page ${page}`
      );


      if (
        status === 429 ||
        status === 408 ||
        status >= 500
      ) {
        if (attempt < maxAttempts) {
          const waitMs =
            status === 429
              ? 10000
              : 5000 * attempt;


          console.log(
            `Jikan retrying in ` +
            `${Math.ceil(waitMs / 1000)} seconds...`
          );


          await sleep(waitMs);
          continue;
        }
      }


      return null;

    } catch (error) {
      console.error(
        `Jikan network error on page ${page}:`,
        error?.message || error
      );


      if (attempt < maxAttempts) {
        const waitMs = 5000 * attempt;

        await sleep(waitMs);
        continue;
      }


      return null;
    }
  }


  return null;
}


// ============================================================
// FETCH ALL FROM JIKAN
// ============================================================

async function fetchFromJikan() {
  const all = [];
  const seen = new Set();


  for (
    let page = 1;
    page <= JIKAN_MAX_PAGES;
    page++
  ) {
    const json =
      await fetchJikanPage(page);


    if (!json) {
      console.error(
        `Jikan failed on page ${page}.`
      );

      return [];
    }


    const data =
      Array.isArray(json.data)
        ? json.data
        : [];


    if (data.length === 0) {
      console.error(
        `Jikan returned 0 anime on page ${page}.`
      );

      break;
    }


    for (const item of data) {
      const anime =
        normalizeJikanAnime(item);


      if (!anime) {
        continue;
      }


      if (seen.has(anime.id)) {
        continue;
      }


      seen.add(anime.id);
      all.push(anime);


      if (all.length >= TARGET_COUNT) {
        break;
      }
    }


    console.log(
      `Jikan: collected ${all.length}/${TARGET_COUNT}`
    );


    if (all.length >= TARGET_COUNT) {
      break;
    }


    await sleep(1500);
  }


  return all.slice(0, TARGET_COUNT);
}


// ============================================================
// MAIN API SELECTOR
// ============================================================

async function fetchAllAnime() {
  console.log('');
  console.log('==========================================');
  console.log(' BOSS Anime Club SEO Generator');
  console.log('==========================================');
  console.log('');


  // ----------------------------------------------------------
  // TRY ANILIST FIRST
  // ----------------------------------------------------------

  console.log(
    'Primary source: AniList'
  );


  const aniListAnime =
    await fetchFromAniList();


  if (aniListAnime.length > 0) {
    console.log('');
    console.log(
      `SUCCESS: AniList returned ` +
      `${aniListAnime.length} anime.`
    );
    console.log('');

    return {
      anime: aniListAnime,
      source: 'AniList',
    };
  }


  // ----------------------------------------------------------
  // FALLBACK
  // ----------------------------------------------------------

  console.log('');
  console.log(
    'AniList unavailable. Using Jikan fallback...'
  );
  console.log('');


  const jikanAnime =
    await fetchFromJikan();


  if (jikanAnime.length > 0) {
    console.log('');
    console.log(
      `SUCCESS: Jikan returned ` +
      `${jikanAnime.length} anime.`
    );
    console.log('');

    return {
      anime: jikanAnime,
      source: 'Jikan',
    };
  }


  // ----------------------------------------------------------
  // EVERYTHING FAILED
  // ----------------------------------------------------------

  console.error('');
  console.error(
    'ERROR: Both AniList and Jikan returned 0 anime.'
  );
  console.error(
    'SAFETY MODE: No files will be deleted or overwritten.'
  );
  console.error('');


  return {
    anime: [],
    source: null,
  };
}


// ============================================================
// EDITOR NOTE
// ============================================================

function buildEditorNote(
  anime,
  title,
  genres,
  studio,
  year,
  score
) {
  const genreList =
    genres.length > 0
      ? genres.slice(0, 3).join(', ')
      : 'multiple genres';


  let scoreLine =
    'does not currently have a community score';


  if (
    anime.averageScore !== null &&
    anime.averageScore !== undefined
  ) {
    const numericScore =
      Number(score);


    if (numericScore >= 7.5) {
      scoreLine =
        `holds a strong community score of ${score}/10`;
    } else if (numericScore >= 5) {
      scoreLine =
        `has a solid community score of ${score}/10`;
    } else {
      scoreLine =
        `has a community score of ${score}/10`;
    }
  }


  const statusLine = {
    FINISHED:
      'The series has completed its run',

    RELEASING:
      'New episodes are currently airing',

    NOT_YET_RELEASED:
      'The series has not yet premiered',

    CANCELLED:
      'The series was cancelled before completion',

    HIATUS:
      'The series is currently on hiatus',

  }[anime.status] ||
    'Its current airing status is being tracked';


  const studioText =
    studio || 'an unknown studio';


  const yearText =
    year !== 'N/A'
      ? ` starting in ${year}`
      : '';


  return (
    `On BOSS Anime Club, ${title} is filed under ` +
    `${genreList} and ${scoreLine}. ` +
    `${statusLine}, and it was produced by ` +
    `${studioText}${yearText}. ` +
    `Use this page to explore the anime information, ` +
    `episode details, genres and synopsis.`
  );
}


// ============================================================
// JSON-LD
// ============================================================

function buildJsonLd({
  title,
  img,
  synopsis,
  genres,
  year,
  episodes,
  url,
}) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: title,
    description: synopsis,
    genre: genres,
    url,
  };


  if (img) {
    data.image = [img];
  }


  if (year !== 'N/A') {
    data.datePublished = String(year);
  }


  if (
    episodes !== '—' &&
    Number.isFinite(Number(episodes))
  ) {
    data.numberOfEpisodes =
      Number(episodes);
  }


  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}


// ============================================================
// INDIVIDUAL PAGE HTML
// ============================================================

function pageHTML(anime) {
  const title =
    getTitle(anime);


  const img =
    getImage(anime);


  const synopsis =
    truncate(
      stripHtml(anime.description),
      500
    );


  const genres =
    getGenres(anime);


  const studio =
    getStudio(anime);


  const year =
    getYear(anime);


  const score =
    getScore(anime);


  const episodes =
    getEpisodes(anime);


  const status =
    getStatusText(anime.status);


  const slug =
    slugify(title);


  const url =
    `${SITE_URL}/anime/${slug}-${anime.id}.html`;


  const editorNote =
    buildEditorNote(
      anime,
      title,
      genres,
      studio,
      year,
      score
    );


  const speakText =
    `${title}. ${synopsis}. ${editorNote}`;


  const jsonLd =
    buildJsonLd({
      title,
      img,
      synopsis,
      genres,
      year,
      episodes,
      url,
    });


  return `<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
${esc(title)} &mdash; Watch Guide, Info &amp; Episodes | BOSS Anime Club
</title>

<meta
  name="description"
  content="${escapeAttr(
    `${title} (${year}) — ${truncate(synopsis, 150)}`
  )}"
>

<link
  rel="canonical"
  href="${escapeAttr(url)}"
>

<meta
  property="og:title"
  content="${escapeAttr(
    `${title} — BOSS Anime Club`
  )}"
>

<meta
  property="og:description"
  content="${escapeAttr(
    truncate(synopsis, 200)
  )}"
>

<meta
  property="og:image"
  content="${escapeAttr(img)}"
>

<meta
  property="og:type"
  content="video.tv_show"
>

<meta
  property="og:url"
  content="${escapeAttr(url)}"
>

<meta
  name="twitter:card"
  content="summary_large_image"
>

<meta
  name="twitter:title"
  content="${escapeAttr(
    `${title} — BOSS Anime Club`
  )}"
>

<meta
  name="twitter:description"
  content="${escapeAttr(
    truncate(synopsis, 200)
  )}"
>

<meta
  name="twitter:image"
  content="${escapeAttr(img)}"
>

<script type="application/ld+json">${jsonLd}</script>

${ANALYTICS_SCRIPT}

<style>

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  background: #0E1116;
  color: #F4F1EA;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  max-width: 760px;
  margin: 0 auto;

  padding:
    24px
    16px
    70px;

  line-height: 1.65;
}

a {
  color: #FFB454;
}

a:hover {
  color: #FFD08A;
}

h1 {
  line-height: 1.2;
  margin-bottom: 20px;
}

.cover {
  width: 220px;
  max-width: 100%;

  border-radius: 8px;

  display: block;

  margin-bottom: 20px;

  background: #171B24;
}

.meta {
  font-size: 14px;
  color: #8B93A7;

  margin-bottom: 18px;
}

.tag {
  display: inline-block;

  font-size: 12px;

  border:
    1px solid
    #2A3140;

  border-radius: 4px;

  padding:
    3px
    9px;

  margin:
    2px
    4px
    2px
    0;

  color: #AAB2C3;

  background: #11151D;
}

.synopsis {
  margin-top: 22px;
}

.editor-note {
  border-left:
    3px solid
    #FFB454;

  padding:
    12px
    15px;

  margin:
    24px
    0;

  background: #171B24;

  font-size: 14px;

  color: #E7E3DA;

  border-radius: 0 6px 6px 0;
}

.listen-row {
  margin:
    24px
    0;
}

.listen-btn {
  font-family: inherit;

  font-size: 13px;

  letter-spacing:
    0.3px;

  text-transform:
    uppercase;

  background:
    #171B24;

  border:
    1px solid
    #5B8DEF;

  color:
    #F4F1EA;

  padding:
    10px
    16px;

  border-radius:
    6px;

  cursor:
    pointer;

  display:
    inline-flex;

  align-items:
    center;

  gap:
    7px;
}

.listen-btn:hover {
  border-color:
    #6FA3FF;

  color:
    #9FC1FF;
}

.listen-btn:disabled {
  opacity:
    0.5;

  cursor:
    default;
}

.listen-status {
  font-size:
    12px;

  color:
    #8B93A7;

  margin-left:
    8px;
}

.backlink {
  margin-top:
    18px;

  display:
    block;

  text-decoration:
    none;
}

.footer {
  margin-top:
    40px;

  padding-top:
    20px;

  border-top:
    1px solid
    #222936;

  font-size:
    12px;

  color:
    #70798D;
}

@media (max-width: 600px) {

  body {
    padding:
      20px
      14px
      50px;
  }

  h1 {
    font-size:
      28px;
  }

  .cover {
    width:
      180px;
  }

}

</style>

</head>

<body>

<main>

<h1>
${esc(title)}
</h1>

${
  img
    ? `
<img
  class="cover"
  src="${escapeAttr(img)}"
  alt="${escapeAttr(title)} cover"
  loading="lazy"
  decoding="async"
>
`
    : ''
}

<div class="meta">

<strong>Score:</strong>
${esc(score)}/10

&nbsp;&middot;&nbsp;

<strong>Episodes:</strong>
${esc(episodes)}

&nbsp;&middot;&nbsp;

<strong>Year:</strong>
${esc(year)}

&nbsp;&middot;&nbsp;

<strong>Status:</strong>
${esc(status)}

&nbsp;&middot;&nbsp;

<strong>Studio:</strong>
${esc(studio)}

</div>

<div>

${
  genres
    .map(
      (genre) =>
        `<span class="tag">${esc(genre)}</span>`
    )
    .join('')
}

</div>

<section class="synopsis">

<h2>
Synopsis
</h2>

<p>
${
  esc(synopsis) ||
  'No synopsis available.'
}
</p>

</section>

<section class="editor-note">

<strong>
BOSS Anime Club Note
</strong>

<br>

${esc(editorNote)}

</section>

<div class="listen-row">

<button
  class="listen-btn"
  id="listenBtn"
  type="button"
>
&#128266; Listen
</button>

<span
  class="listen-status"
  id="listenStatus"
></span>

</div>

<a
  class="backlink"
  href="${SITE_URL}/"
>
&#9656; Open BOSS Anime Club
</a>

<a
  class="backlink"
  href="${SITE_URL}/anime/index.html"
>
&#9656; Browse all anime
</a>

<div class="footer">

BOSS Anime Club &mdash;
Anime information, guides and episode details.

</div>

</main>


<script>

(function () {

  var btn =
    document.getElementById('listenBtn');

  var status =
    document.getElementById('listenStatus');

  var text =
    ${JSON.stringify(speakText)};


  var LABEL_LISTEN =
    '\\uD83D\\uDD0A Listen';

  var LABEL_STOP =
    '\\u23F9 Stop';


  if (
    !('speechSynthesis' in window) ||
    !('SpeechSynthesisUtterance' in window)
  ) {

    btn.disabled = true;

    status.textContent =
      'Not supported on this browser/device.';

    return;

  }


  var speaking = false;


  btn.addEventListener(
    'click',
    function () {

      if (speaking) {

        window.speechSynthesis.cancel();

        speaking = false;

        btn.textContent =
          LABEL_LISTEN;

        status.textContent =
          '';

        return;

      }


      window.speechSynthesis.cancel();


      var utter =
        new SpeechSynthesisUtterance(text);


      utter.lang =
        'en-US';

      utter.rate =
        0.95;

      utter.pitch =
        1;


      utter.onstart =
        function () {

          speaking = true;

          btn.textContent =
            LABEL_STOP;

          status.textContent =
            'Playing...';

        };


      utter.onend =
        function () {

          speaking = false;

          btn.textContent =
            LABEL_LISTEN;

          status.textContent =
            '';

        };


      utter.onerror =
        function () {

          speaking = false;

          btn.textContent =
            LABEL_LISTEN;

          status.textContent =
            'Could not play audio.';

        };


      window.speechSynthesis.speak(
        utter
      );

    }
  );


})();

</script>

</body>

</html>`;
}


// ============================================================
// INDEX HTML
// ============================================================

function indexHTML(list, source) {
  const rows =
    list
      .map((anime) => {

        const title =
          getTitle(anime);

        const slug =
          slugify(title);

        const href =
          `./${slug}-${anime.id}.html`;


        return `
<li>
  <a href="${escapeAttr(href)}">
    ${esc(title)}
  </a>
</li>`;

      })
      .join('\n');


  return `<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
Browse All Anime | BOSS Anime Club
</title>

<meta
  name="description"
  content="Browse anime on BOSS Anime Club — anime information, episodes, genres, scores and more."
>

<link
  rel="canonical"
  href="${SITE_URL}/anime/index.html"
>

${ANALYTICS_SCRIPT}

<style>

* {
  box-sizing: border-box;
}

body {

  background:
    #0E1116;

  color:
    #F4F1EA;

  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  max-width:
    760px;

  margin:
    0 auto;

  padding:
    24px
    16px
    60px;

  line-height:
    1.6;
}

a {
  color:
    #FFB454;

  text-decoration:
    none;
}

a:hover {
  color:
    #FFD08A;
}

li {
  margin-bottom:
    9px;
}

.header {
  margin-bottom:
    25px;
}

.count {
  color:
    #8B93A7;

  font-size:
    14px;
}

.source {
  color:
    #70798D;

  font-size:
    12px;
}

</style>

</head>

<body>

<header class="header">

<h1>
Browse All Anime
</h1>

<p class="count">
${list.length} anime available.
</p>

<p class="source">
Data source: ${esc(source)}
</p>

<p>
<a href="${SITE_URL}/">
&larr; Back to BOSS Anime Club
</a>
</p>

</header>

<ul>

${rows}

</ul>

</body>

</html>`;
}


// ============================================================
// SITEMAP
// ============================================================

function sitemapXML(list) {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);


  const urls =
    list
      .map((anime) => {

        const title =
          getTitle(anime);

        const slug =
          slugify(title);

        const url =
          `${SITE_URL}/anime/${slug}-${anime.id}.html`;


        return `  <url>
    <loc>${esc(url)}</loc>
    <lastmod>${today}</lastmod>
  </url>`;

      })
      .join('\n');


  return `<?xml version="1.0" encoding="UTF-8"?>

<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
>

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


// ============================================================
// MAIN
// ============================================================

async function main() {

  console.log('');
  console.log('==========================================');
  console.log(' BOSS Anime Club');
  console.log(' Static SEO Page Generator');
  console.log('==========================================');
  console.log('');


  // ----------------------------------------------------------
  // FETCH DATA
  // ----------------------------------------------------------

  const result =
    await fetchAllAnime();


  const list =
    result.anime;


  const source =
    result.source;


  console.log(
    `Fetched ${list.length} anime.`
  );


  // ----------------------------------------------------------
  // CRITICAL SAFETY CHECK
  // ----------------------------------------------------------

  if (
    !Array.isArray(list) ||
    list.length === 0
  ) {

    console.error('');
    console.error(
      '=========================================='
    );
    console.error(
      ' SAFETY STOP'
    );
    console.error(
      '=========================================='
    );
    console.error(
      'No anime data was received.'
    );
    console.error(
      'No existing files were changed.'
    );
    console.error(
      'No old anime pages were deleted.'
    );
    console.error(
      '=========================================='
    );
    console.error('');

    process.exit(1);
  }


  // ----------------------------------------------------------
  // REQUIRE MINIMUM DATA
  // ----------------------------------------------------------

  if (list.length < 5) {

    console.error(
      `Only ${list.length} anime received.`
    );

    console.error(
      'This is too little data for a safe deployment.'
    );

    console.error(
      'Existing files will NOT be touched.'
    );

    process.exit(1);
  }


  // ----------------------------------------------------------
  // CREATE OUTPUT DIRECTORY
  // ----------------------------------------------------------

  await mkdir(
    OUT_DIR,
    {
      recursive: true,
    }
  );


  // ----------------------------------------------------------
  // WRITE INDIVIDUAL PAGES
  // ----------------------------------------------------------

  const currentFiles =
    new Set();


  let generatedCount = 0;


  for (const anime of list) {

    const title =
      getTitle(anime);


    const slug =
      slugify(title);


    const fileName =
      `${slug}-${anime.id}.html`;


    currentFiles.add(
      fileName
    );


    const filePath =
      path.join(
        OUT_DIR,
        fileName
      );


    await writeFile(
      filePath,
      pageHTML(anime),
      'utf8'
    );


    generatedCount++;


    if (
      generatedCount % 25 === 0 ||
      generatedCount === list.length
    ) {

      console.log(
        `Generated ${generatedCount}/${list.length} pages...`
      );

    }

  }


  // ----------------------------------------------------------
  // WRITE INDEX
  // ----------------------------------------------------------

  await writeFile(
    path.join(
      OUT_DIR,
      'index.html'
    ),

    indexHTML(
      list,
      source
    ),

    'utf8'
  );


  // ----------------------------------------------------------
  // WRITE SITEMAP
  // ----------------------------------------------------------

  await writeFile(
    path.join(
      process.cwd(),
      'sitemap.xml'
    ),

    sitemapXML(list),

    'utf8'
  );


  // ----------------------------------------------------------
  // CLEANUP STALE HTML
  // ----------------------------------------------------------

  //
  // IMPORTANT:
  // Cleanup happens ONLY after:
  //
  // 1. API returned valid data
  // 2. At least 5 anime were received
  // 3. New pages were successfully generated
  // 4. index.html was successfully generated
  // 5. sitemap.xml was successfully generated
  //
  // This prevents accidental deletion during API failure.
  //

  const existingFiles =
    await readdir(
      OUT_DIR
    );


  let deletedCount = 0;


  for (const file of existingFiles) {

    // Never delete index.
    if (file === 'index.html') {
      continue;
    }


    // Only remove generated HTML pages.
    if (!file.endsWith('.html')) {
      continue;
    }


    // Current page exists.
    if (currentFiles.has(file)) {
      continue;
    }


    try {

      await unlink(
        path.join(
          OUT_DIR,
          file
        )
      );


      deletedCount++;


      console.log(
        `Deleted stale page: ${file}`
      );

    } catch (error) {

      console.error(
        `Could not delete stale page ${file}:`,
        error?.message || error
      );

      throw error;
    }

  }


  // ----------------------------------------------------------
  // DONE
  // ----------------------------------------------------------

  console.log('');
  console.log('==========================================');
  console.log(' BUILD SUCCESS');
  console.log('==========================================');
  console.log(
    `API source       : ${source}`
  );
  console.log(
    `Anime generated  : ${generatedCount}`
  );
  console.log(
    `Stale pages      : ${deletedCount}`
  );
  console.log(
    `Index generated  : anime/index.html`
  );
  console.log(
    `Sitemap generated: sitemap.xml`
  );
  console.log('==========================================');
  console.log('');

}


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

main().catch((error) => {

  console.error('');
  console.error(
    '=========================================='
  );
  console.error(
    ' BUILD FAILED'
  );
  console.error(
    '=========================================='
  );

  console.error(
    error?.stack ||
    error?.message ||
    error
  );

  console.error(
    '=========================================='
  );
  console.error('');

  process.exit(1);

});
