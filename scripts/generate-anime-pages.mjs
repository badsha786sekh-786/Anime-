// generate-anime-pages.mjs
//
// Ye script AniList se top popular + trending anime ka data leti hai, aur har
// anime ke liye ek ALAG static HTML page banati hai (JavaScript ke bina bhi
// pura content dikhta hai) — taaki Google har anime ko individually crawl aur
// index kar sake. Ye GitHub Actions se daily automatically chalti hai.
//
// Output: /anime/<slug>-<id>.html  (ek file per anime)
//         /anime/index.html        (sabhi anime ki list, links ke saath)
//         /sitemap.xml             (Google ko sabhi URLs batane ke liye)
//
// Kuch bhi manually chalane ki zaroorat nahi — GitHub Actions workflow
// (.github/workflows/generate-pages.yml) ise apne aap chalata hai.
//
// NOTE: Special symbols (arrows, speaker, stop icon) yahan HTML entities
// (jaise &#9656;) ya JS unicode escapes (jaise \u23F9) ke roop mein likhe
// gaye hain, raw emoji/unicode characters ke bajaye. Wajah: jab is file ko
// GitHub ke mobile web-editor mein copy-paste kiya jaata hai, raw unicode
// characters kabhi-kabhi corrupt (mojibake) ho jaate hain. Entities/escapes
// plain ASCII hote hain, isliye copy-paste mein kabhi kharab nahi hote.
//
// NOTE (cleanup): Har run mein, agar koi purani anime page ab top-200
// popularity list mein nahi hai, to uski file automatically delete ho jaati
// hai — taaki repo mein "dead weight" (stale/unused files) jama na ho. Ye
// har roz (daily workflow run ke saath) apne aap hota hai, kisi manual check
// ki zaroorat nahi.
//
// NOTE (analytics): Har generated page (individual anime pages + the
// browse-all index) mein OpenDomains ka analytics script bhi inject hota
// hai, taaki inn pages ka traffic bhi track ho sake, homepage ki tarah.

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const SITE_URL = 'https://anime.is-cool.dev';
const OUT_DIR = path.join(process.cwd(), 'anime');
const PAGE_COUNT = 5;      // AniList se kitne "pages" fetch karne hain
const PER_PAGE = 40;       // har page mein kitne anime (max ~50 AniList allow karta hai)

const API = 'https://graphql.anilist.co';

const ANALYTICS_SCRIPT = '<script defer src="https://analytics.open-domains.com/script.js" data-website-id="c72153eb-a0fc-4580-bae2-76db6e9a799c"></script>';

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

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function slugify(title) {
  return String(title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

async function fetchAllAnime() {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= PAGE_COUNT; page++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { page, perPage: PER_PAGE } }),
    });
    if (!res.ok) {
      console.error(`AniList request failed on page ${page}: HTTP ${res.status}`);
      break;
    }
    const json = await res.json();
    const media = json?.data?.Page?.media || [];
    if (media.length === 0) break;
    for (const m of media) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        all.push(m);
      }
    }
    // AniList free API: be polite between calls.
    await new Promise((r) => setTimeout(r, 700));
  }
  return all;
}

// Har page ke liye thoda "apna" unique text banata hai (AniList ke raw
// description ke alawa) — isse Google ko duplicate-content nahi lagta,
// kyunki ye text sirf is site par hai aur data ke hisaab se generate hota hai.
function buildEditorNote(m, title, genres, studio, year, score) {
  const genreList = genres.length ? genres.slice(0, 3).join(', ') : 'multiple genres';
  const scoreLine = m.averageScore != null
    ? (m.averageScore >= 75
        ? `holds a strong community score of ${score}/10`
        : m.averageScore >= 50
          ? `sits at a solid ${score}/10 with viewers`
          : `has a score of ${score}/10 on AniList`)
    : 'has not yet accumulated enough ratings for a community score';
  const statusLine = {
    FINISHED: 'The series has completed its run',
    RELEASING: 'New episodes are currently airing',
    NOT_YET_RELEASED: 'The series has not yet premiered',
    CANCELLED: 'The series was cancelled before completion',
    HIATUS: 'The series is currently on hiatus',
  }[m.status] || 'Current airing status is being tracked';

  return `On BOSS Anime Club, ${esc(title)} is filed under ${esc(genreList)} and ${scoreLine}. `
    + `${statusLine}, and it was produced by ${esc(studio)}${year !== 'N/A' ? ` starting in ${esc(String(year))}` : ''}. `
    + `Save this page to your BOSS Anime Club playlist to track episodes and get English or Hindi narration for the synopsis.`;
}

function pageHTML(m) {
  const title = m.title?.english || m.title?.romaji || m.title?.native || 'Untitled';
  const img = m.coverImage?.extraLarge || m.coverImage?.large || '';
  const synopsis = (m.description || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').slice(0, 300);
  const genres = m.genres || [];
  const studio = (m.studios?.nodes || []).map((s) => s.name).join(', ') || 'Unknown';
  const year = m.startDate?.year || 'N/A';
  const score = m.averageScore != null ? (m.averageScore / 10).toFixed(1) : '—';
  const episodes = m.episodes || '—';
  const url = `${SITE_URL}/anime/${slugify(title)}-${m.id}.html`;
  const editorNote = buildEditorNote(m, title, genres, studio, year, score);
  // Speech synthesis reads this: synopsis + editor note, stripped of markup.
  const speakText = `${synopsis} ${editorNote}`.replace(/<[^>]+>/g, '');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: title,
    image: img,
    description: synopsis,
    genre: genres,
    datePublished: m.startDate?.year ? String(m.startDate.year) : undefined,
    numberOfEpisodes: m.episodes || undefined,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} &mdash; Watch Guide, Info &amp; Episodes | BOSS Anime Club</title>
<meta name="description" content="${esc(title)} (${esc(year)}) &mdash; ${esc(synopsis.slice(0, 150))}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta property="og:description" content="${esc(synopsis.slice(0, 200))}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:type" content="video.tv_show">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} &mdash; BOSS Anime Club">
<meta name="twitter:description" content="${esc(synopsis.slice(0, 200))}">
<meta name="twitter:image" content="${esc(img)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${ANALYTICS_SCRIPT}
<style>
  body{background:#0E1116;color:#F4F1EA;font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 60px;line-height:1.6;}
  a{color:#FFB454;}
  img{max-width:220px;border-radius:4px;display:block;margin-bottom:16px;}
  .tag{display:inline-block;font-size:12px;border:1px solid #2A3140;border-radius:2px;padding:2px 8px;margin:2px 4px 2px 0;color:#8B93A7;}
  .meta{font-size:14px;color:#8B93A7;margin-bottom:16px;}
  .editor-note{border-left:2px solid #FFB454;padding:10px 14px;margin:20px 0;background:#171B24;font-size:14px;color:#F4F1EA;}
  .backlink{margin-top:32px;display:block;}
  .listen-btn{
    font-family:inherit;font-size:13px;letter-spacing:0.3px;text-transform:uppercase;
    background:#171B24;border:1px solid #5B8DEF;color:#F4F1EA;padding:9px 16px;
    border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;margin:16px 0;
  }
  .listen-btn:hover{border-color:#6FA3FF;color:#9FC1FF;}
  .listen-btn:disabled{opacity:0.5;cursor:default;}
  .listen-status{font-size:12px;color:#8B93A7;margin-left:8px;}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<img src="${esc(img)}" alt="${esc(title)} cover" loading="lazy">
<div class="meta">Score: ${esc(score)}/10 &nbsp;&middot;&nbsp; Episodes: ${esc(episodes)} &nbsp;&middot;&nbsp; Year: ${esc(year)} &nbsp;&middot;&nbsp; Studio: ${esc(studio)}</div>
<div>${genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>
<p>${esc(synopsis) || 'No synopsis available.'}</p>
<div class="editor-note">${editorNote}</div>

<button class="listen-btn" id="listenBtn" type="button">&#128266; Listen (device voice)</button>
<span class="listen-status" id="listenStatus"></span>

<a class="backlink" href="${SITE_URL}/">&#9656; Open in the BOSS Anime Club app to search, save playlists, and listen to narration</a>
<a class="backlink" href="${SITE_URL}/anime/index.html">&#9656; Browse all anime</a>

<script>
(function(){
  var btn = document.getElementById('listenBtn');
  var status = document.getElementById('listenStatus');
  var text = ${JSON.stringify(speakText)};
  var LABEL_LISTEN = '\\uD83D\\uDD0A Listen (device voice)';
  var LABEL_STOP = '\\u23F9 Stop';
  if(!('speechSynthesis' in window)){
    btn.disabled = true;
    status.textContent = 'Not supported on this browser/device.';
    return;
  }
  var speaking = false;
  btn.addEventListener('click', function(){
    if(speaking){
      window.speechSynthesis.cancel();
      speaking = false;
      btn.textContent = LABEL_LISTEN;
      status.textContent = '';
      return;
    }
    window.speechSynthesis.cancel();
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.onstart = function(){ speaking = true; btn.textContent = LABEL_STOP; status.textContent = 'Playing...'; };
    utter.onend = function(){ speaking = false; btn.textContent = LABEL_LISTEN; status.textContent = ''; };
    utter.onerror = function(){ speaking = false; btn.textContent = LABEL_LISTEN; status.textContent = 'Could not play audio.'; };
    window.speechSynthesis.speak(utter);
  });
})();
</script>
</body>
</html>`;
}

function indexHTML(list) {
  const rows = list
    .map((m) => {
      const title = m.title?.english || m.title?.romaji || 'Untitled';
      const slug = slugify(title);
      return `<li><a href="./${slug}-${m.id}.html">${esc(title)}</a></li>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Browse All Anime | BOSS Anime Club</title>
<meta name="description" content="Browse the full list of anime on BOSS Anime Club &mdash; info, episodes, genres and more.">
<link rel="canonical" href="${SITE_URL}/anime/index.html">
${ANALYTICS_SCRIPT}
<style>
  body{background:#0E1116;color:#F4F1EA;font-family:sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 60px;}
  a{color:#FFB454;text-decoration:none;}
  li{margin-bottom:8px;}
</style>
</head>
<body>
<h1>Browse All Anime</h1>
<p><a href="${SITE_URL}/">&larr; Back to BOSS Anime Club</a></p>
<ul>
${rows}
</ul>
</body>
</html>`;
}

function sitemapXML(list) {
  const today = new Date().toISOString().slice(0, 10); // e.g. "2026-08-31"
  const urls = list
    .map((m) => {
      const title = m.title?.english || m.title?.romaji || 'Untitled';
      const slug = slugify(title);
      return `  <url><loc>${SITE_URL}/anime/${slug}-${m.id}.html</loc><lastmod>${today}</lastmod></url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><priority>1.0</priority><lastmod>${today}</lastmod></url>
  <url><loc>${SITE_URL}/anime/index.html</loc><priority>0.8</priority><lastmod>${today}</lastmod></url>
${urls}
</urlset>`;
}

async function main() {
  console.log('Fetching anime list from AniList...');
  const list = await fetchAllAnime();
  console.log(`Fetched ${list.length} anime.`);

  await mkdir(OUT_DIR, { recursive: true });

  const currentFiles = new Set();
  for (const m of list) {
    const title = m.title?.english || m.title?.romaji || 'Untitled';
    const slug = slugify(title);
    const fileName = `${slug}-${m.id}.html`;
    currentFiles.add(fileName);
    const filePath = path.join(OUT_DIR, fileName);
    await writeFile(filePath, pageHTML(m), 'utf8');
  }

  // Cleanup: koi bhi purani anime page jo ab top-200 popularity list mein
  // nahi hai, use delete kar do — taaki dead weight jama na ho. index.html
  // ko chhod dete hain kyunki wo har baar niche dobara likha jaata hai.
  const existingFiles = await readdir(OUT_DIR);
  let deletedCount = 0;
  for (const file of existingFiles) {
    if (file === 'index.html') continue;
    if (!file.endsWith('.html')) continue;
    if (!currentFiles.has(file)) {
      await unlink(path.join(OUT_DIR, file));
      deletedCount++;
      console.log(`Deleted stale page: ${file}`);
    }
  }

  await writeFile(path.join(OUT_DIR, 'index.html'), indexHTML(list), 'utf8');
  await writeFile(path.join(process.cwd(), 'sitemap.xml'), sitemapXML(list), 'utf8');

  console.log(`Done. Generated ${list.length} anime pages, deleted ${deletedCount} stale pages, + index + sitemap.xml.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
