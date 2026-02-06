import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Extract movies from a Letterboxd list page.
 * Returns: [{ title, year, url }]
 */
export async function fetchLetterboxdListMovies(listUrl) {
  const { data: html } = await axios.get(listUrl, {
    headers: {
      'User-Agent': 'torrent-auto-crawlerr/0.1 (+https://local)'
    },
    // Letterboxd uses gzip/br; axios handles.
    timeout: 30_000
  });

  const $ = cheerio.load(html);

  // Works for the public “grid” list layout: <ul class="poster-list"> <li> ... <img alt="Poster for Title (Year)">
  const movies = [];

  $('ul.poster-list li').each((_, li) => {
    const imgAlt = $(li).find('img').attr('alt') || '';
    const aHref = $(li).find('a').first().attr('href') || null;

    // alt usually: "Poster for Tokyo Tribe (2014)"
    let title = null;
    let year = null;
    const m = imgAlt.match(/Poster for\s+(.+?)\s*\((\d{4})\)\s*$/);
    if (m) {
      title = m[1].trim();
      year = Number(m[2]);
    } else if (imgAlt.startsWith('Poster for ')) {
      title = imgAlt.replace('Poster for ', '').trim();
    }

    if (!title) return;

    const url = aHref ? new URL(aHref, listUrl).toString() : null;
    movies.push({ title, year, url });
  });

  // Fallback: sometimes the list is in “detail” view or markup changes.
  // Try to find film links + capture nearby year via regex.
  if (movies.length === 0) {
    const seen = new Set();
    const re = /\/film\/([a-z0-9-]+)\//gi;
    let match;
    while ((match = re.exec(html))) {
      const href = `/film/${match[1]}/`;
      if (seen.has(href)) continue;
      seen.add(href);
      const url = new URL(href, listUrl).toString();
      movies.push({ title: match[1].replace(/-/g, ' '), year: null, url });
    }
  }

  // De-dup by title+year
  const dedup = new Map();
  for (const m of movies) {
    const key = `${m.title}__${m.year ?? ''}`.toLowerCase();
    if (!dedup.has(key)) dedup.set(key, m);
  }

  return [...dedup.values()];
}
