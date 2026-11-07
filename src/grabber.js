// Site grabber: crawls pages from a start URL and collects downloadable file links.
const { request, readBody } = require('./downloader');
const { extOf } = require('./utils');
const path = require('path');

const PAGE_EXT = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'xhtml']);

function extractLinks(html, base) {
  const out = new Set();
  const add = raw => {
    if (!raw) return;
    raw = raw.trim().replace(/&amp;/g, '&');
    if (/^(javascript|mailto|data|tel):/i.test(raw)) return;
    try {
      const u = new URL(raw, base);
      if (/^https?:$/.test(u.protocol)) { u.hash = ''; out.add(u.href); }
    } catch {}
  };
  let m;
  const re1 = /(?:href|src|data-src|data-href|data-url|poster)\s*=\s*["']([^"']+)["']/gi;
  while ((m = re1.exec(html))) add(m[1]);
  const re2 = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = re2.exec(html))) add(m[1]);
  const re3 = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = re3.exec(html))) m[1].split(',').forEach(p => add(p.trim().split(/\s+/)[0]));
  return [...out];
}

async function crawl(startUrl, o, emit, cancelled) {
  const exts = new Set(o.exts);
  const visited = new Set(), files = new Map();
  const queue = [{ url: startUrl, d: 0 }];
  const host0 = new URL(startUrl).hostname.replace(/^www\./, '');
  let pages = 0;
  while (queue.length && pages < (o.maxPages || 150) && !cancelled()) {
    const { url, d } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let html = '';
    try {
      const { res, req } = await request(url, {});
      if (res.statusCode >= 400 || !/html|xml|text/i.test(res.headers['content-type'] || '')) { req.destroy(); continue; }
      html = (await readBody(res, 3e6)).toString('utf8'); req.destroy();
    } catch { continue; }
    pages++; emit({ pages, files: files.size, url });
    for (const l of extractLinks(html, url)) {
      const e = extOf(l);
      if (exts.has(e)) {
        if (!files.has(l)) {
          let name = 'file'; try { name = decodeURIComponent(path.basename(new URL(l).pathname)); } catch {}
          files.set(l, { url: l, ref: url, name });
        }
      } else if (d < o.depth && PAGE_EXT.has(e)) {
        const h = new URL(l).hostname.replace(/^www\./, '');
        if (o.sameSite && h !== host0) continue;
        if (!visited.has(l)) queue.push({ url: l, d: d + 1 });
      }
    }
  }
  return [...files.values()];
}

module.exports = { crawl, extractLinks };
