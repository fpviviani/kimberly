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

  // Works for the public “grid” list layout.
  // Letterboxd markup varies:
  // - old: <img alt="Poster for Title (Year)">
  // - new: <img alt="Title"> + data-item-name="Title (Year)" on a react-component div
  const movies = [];

  $('ul.poster-list li').each((_, li) => {
    const imgAlt = ($(li).find('img').attr('alt') || '').trim();
    const aHref =
      $(li).find('a').first().attr('href') ||
      $(li).find('[data-target-link]').first().attr('data-target-link') ||
      $(li).find('[data-item-link]').first().attr('data-item-link') ||
      null;

    let title = null;
    let year = null;

    // 1) Prefer data-item-name / data-item-full-display-name when present
    const dataName = (
      $(li).find('[data-item-name]').first().attr('data-item-name') ||
      $(li).find('[data-item-full-display-name]').first().attr('data-item-full-display-name') ||
      ''
    ).trim();

    // e.g. "Céline (1992)"
    const mData = dataName.match(/^(.+?)\s*\((\d{4})\)\s*$/);
    if (mData) {
      title = mData[1].trim();
      year = Number(mData[2]);
    } else if (dataName) {
      title = dataName;
    }

    // 2) Fallback: parse from image alt
    if (!title && imgAlt) {
      const mAlt = imgAlt.match(/Poster for\s+(.+?)\s*\((\d{4})\)\s*$/);
      if (mAlt) {
        title = mAlt[1].trim();
        year = Number(mAlt[2]);
      } else if (imgAlt.startsWith('Poster for ')) {
        title = imgAlt.replace('Poster for ', '').trim();
      } else {
        // New markup often uses just the title in alt
        title = imgAlt;
      }
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
