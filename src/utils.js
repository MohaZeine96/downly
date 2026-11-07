// Shared helpers: file categories, extension sets, batch URL pattern expansion.
const path = require('path');

const CATEGORY_EXTS = {
  Compressed: 'zip rar 7z tar gz bz2 xz tgz zipx cab',
  Documents: 'pdf doc docx xls xlsx ppt pptx txt rtf epub odt ods csv mobi',
  Music: 'mp3 wav flac aac ogg m4a wma opus',
  Programs: 'exe msi dmg pkg deb rpm apk appimage iso bin jar',
  Video: 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m3u8 3gp',
  Pictures: 'jpg jpeg png gif webp bmp svg tiff ico'
};
const CATEGORIES = Object.keys(CATEGORY_EXTS).concat('General');
const EXT2CAT = {};
for (const [c, s] of Object.entries(CATEGORY_EXTS)) s.split(' ').forEach(e => { EXT2CAT[e] = c; });

const TYPE_SETS = {
  images: 'jpg jpeg png gif webp bmp svg',
  video: CATEGORY_EXTS.Video.replace(' m3u8', ''),
  audio: CATEGORY_EXTS.Music,
  docs: CATEGORY_EXTS.Documents,
  archives: CATEGORY_EXTS.Compressed + ' iso',
  programs: 'exe msi dmg pkg deb rpm apk appimage'
};

function extOf(s) {
  let p = String(s || '');
  try { p = new URL(p).pathname; } catch {}
  return path.extname(p).slice(1).toLowerCase();
}
const categoryOf = name => EXT2CAT[extOf(name)] || 'General';
const DEFAULT_CAPTURE = Object.values(CATEGORY_EXTS).join(' ');
const isDownloadable = url => !!EXT2CAT[extOf(url)];

// "http://x/img[001-100].jpg"  /  "file[a-e].zip"  (multiple tokens allowed)
function expandPattern(tpl, limit = 5000) {
  const re = /\[(\d+)-(\d+)\]|\[([a-zA-Z])-([a-zA-Z])\]/;
  let out = [String(tpl)];
  for (let guard = 0; guard < 6; guard++) {
    const next = [];
    let any = false;
    for (const s of out) {
      const m = s.match(re);
      if (!m) { next.push(s); continue; }
      any = true;
      let vals = [];
      if (m[1] !== undefined) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10), w = m[1].length;
        const step = a <= b ? 1 : -1;
        for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
          vals.push(m[1][0] === '0' ? String(i).padStart(w, '0') : String(i));
          if (vals.length > limit) break;
        }
      } else {
        const a = m[3].charCodeAt(0), b = m[4].charCodeAt(0), step = a <= b ? 1 : -1;
        for (let i = a; step > 0 ? i <= b : i >= b; i += step) vals.push(String.fromCharCode(i));
      }
      for (const v of vals) { next.push(s.replace(re, v)); if (next.length > limit) break; }
    }
    out = next.slice(0, limit);
    if (!any) break;
  }
  return out;
}

module.exports = { CATEGORIES, CATEGORY_EXTS, TYPE_SETS, extOf, categoryOf, DEFAULT_CAPTURE, isDownloadable, expandPattern };
