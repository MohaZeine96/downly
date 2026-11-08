// Downly browser integration (Chrome / Edge / Brave / Opera, Manifest V3)
const DEF = {
  enabled: true, sniff: true, port: 7395, minSizeMB: 0, excludeHosts: '',
  exts: 'zip rar 7z tar gz bz2 xz tgz iso exe msi dmg pkg deb rpm apk pdf doc docx xls xlsx ppt pptx epub mp3 flac wav m4a mp4 mkv avi mov wmv flv webm m4v mpg mpeg'
};
const skip = new Set(); // URLs we re-hand to the browser after a failed handoff
const MEDIA_EXT = /\.(mp4|webm|mkv|m4v|mov|m3u8|mp3|m4a|aac|flac|ogg|opus)(\?|#|$)/i;

const getSettings = () => chrome.storage.local.get(DEF);
const base = s => `http://127.0.0.1:${s.port}`;

async function api(s, path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(base(s) + path, {
      method: body ? 'POST' : 'GET', signal: ctl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined
    });
    return await r.json();
  } finally { clearTimeout(t); }
}
async function alive(s) { try { const j = await api(s, '/ping'); return !!(j && j.ok); } catch { return false; } }
async function cookieHeader(url) {
  try { return (await chrome.cookies.getAll({ url })).map(c => c.name + '=' + c.value).join('; '); } catch { return ''; }
}
const extOf = u => { try { const m = new URL(u).pathname.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; } catch { return ''; } };
const baseName = p => (p || '').split(/[\\/]/).pop();

async function sendItems(list, s, silent) {
  const items = [];
  for (const it of list) items.push({ ...it, cookie: await cookieHeader(it.url), ua: navigator.userAgent });
  return api(s, '/add', { items, silent: !!silent });
}

// ---- capture browser downloads ----
chrome.downloads.onCreated.addListener(async item => {
  try {
    const s = await getSettings(); if (!s.enabled) return;
    const url = item.finalUrl || item.url;
    if (!/^https?:/i.test(url) || skip.has(url) || item.byExtensionId === chrome.runtime.id) return;
    const host = new URL(url).hostname;
    if (s.excludeHosts.split(/[\s,]+/).filter(Boolean).some(h => host === h || host.endsWith('.' + h))) return;
    const list = s.exts.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const mime = (item.mime || '').toLowerCase();
    const wanted = list.includes(extOf(url)) || list.includes(extOf(item.filename)) || /octet-stream|x-msdownload|zip|x-rar|x-7z/.test(mime);
    if (!wanted) return;
    if (item.fileSize > 0 && item.fileSize < s.minSizeMB * 1048576) return;
    if (!(await alive(s))) return; // app not running: let the browser handle it
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
    try { await sendItems([{ url, referer: item.referrer || '', filename: baseName(item.filename) }], s, false); }
    catch { skip.add(url); chrome.downloads.download({ url }); }
  } catch (e) { /* ignore */ }
});

// ---- context menus ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'idm-link', title: 'Download with Downly', contexts: ['link', 'video', 'audio', 'image'] });
  chrome.contextMenus.create({ id: 'idm-page', title: 'Download all links on this page…', contexts: ['page'] });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const s = await getSettings();
  if (!(await alive(s))) return notify('Downly is not running. Start the app first.');
  if (info.menuItemId === 'idm-link') {
    const url = info.linkUrl || info.srcUrl; if (!url) return;
    await sendItems([{ url, referer: info.pageUrl || (tab && tab.url) || '' }], s, false);
  } else if (info.menuItemId === 'idm-page' && tab) {
    const exts = new Set(s.exts.toLowerCase().split(/[\s,]+/).filter(Boolean));
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [...new Set([...document.querySelectorAll('a[href],video[src],audio[src],source[src]')].map(e => e.href || e.src))]
    });
    const urls = ((res[0] && res[0].result) || []).filter(u => /^https?:/i.test(u) && exts.has(extOf(u)));
    if (!urls.length) return notify('No downloadable links found on this page.');
    await sendItems(urls.map(url => ({ url, referer: tab.url })), s, false);
  }
});
function notify(msg) {
  chrome.notifications && chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Downly', message: msg });
}

// ---- media sniffer ----
async function addMedia(tabId, entry) {
  const key = 'media:' + tabId;
  const cur = (await chrome.storage.session.get(key))[key] || [];
  if (cur.some(m => m.url === entry.url)) return;
  cur.unshift(entry); if (cur.length > 40) cur.pop();
  await chrome.storage.session.set({ [key]: cur });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b9cff' });
  chrome.action.setBadgeText({ tabId, text: String(cur.length) });
}
chrome.webRequest.onResponseStarted.addListener(async d => {
  try {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const s = await getSettings(); if (!s.sniff) return;
    const h = n => { const x = (d.responseHeaders || []).find(x => x.name.toLowerCase() === n); return x ? x.value : ''; };
    const ct = h('content-type').toLowerCase(), len = +h('content-length') || 0;
    if (/mp2t|mpd|dash/.test(ct) || /\.(ts|mpd|m4s)(\?|#|$)/i.test(d.url)) return; // stream fragments
    const hls = /mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(d.url);
    const media = /^(video|audio)\//.test(ct) || hls || (MEDIA_EXT.test(d.url) && !/text|html|json/.test(ct));
    if (!media) return;
    if (!hls && len && len < 150 * 1024) return;
    let title = ''; try { title = (await chrome.tabs.get(d.tabId)).title || ''; } catch {}
    const kind = hls ? 'HLS' : (ct.split('/')[1] || extOf(d.url) || 'media').split(';')[0].toUpperCase();
    await addMedia(d.tabId, { url: d.url, kind, size: len, title, page: d.initiator || '' });
  } catch (e) { /* ignore */ }
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(id => chrome.storage.session.remove('media:' + id));
chrome.tabs.onUpdated.addListener((id, ch) => {
  if (ch.status === 'loading' && ch.url) { chrome.storage.session.remove('media:' + id); chrome.action.setBadgeText({ tabId: id, text: '' }); }
});

// ---- popup messages ----
chrome.runtime.onMessage.addListener((msg, _, reply) => {
  (async () => {
    const s = await getSettings();
    if (msg.type === 'status') return reply({ alive: await alive(s) });
    if (msg.type === 'send') {
      if (!(await alive(s))) return reply({ ok: false, error: 'Downly is not running' });
      const r = await sendItems(msg.items, s, !!msg.silent); return reply(r);
    }
  })().catch(e => reply({ ok: false, error: String(e) }));
  return true;
});
