const $ = s => document.querySelector(s);
const DEF = { enabled: true, sniff: true, port: 7395, minSizeMB: 0, exts: '' };
const fmt = n => { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
let tab, media = [];

async function init() {
  const s = await chrome.storage.local.get(DEF);
  $('#enabled').checked = s.enabled; $('#sniff').checked = s.sniff; $('#port').value = s.port; $('#min').value = s.minSizeMB;
  // pull the extension list from the app when it is running and the user has no custom list yet
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  $('#dot').classList.toggle('on', !!st.alive); $('#st').textContent = st.alive ? 'Connected to IDM Clone' : 'App not running';
  if (!s.exts) { try { const r = await fetch(`http://127.0.0.1:${s.port}/ping`); const j = await r.json(); $('#exts').value = j.exts || ''; } catch {} }
  else $('#exts').value = s.exts;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = 'media:' + tab.id;
  media = (await chrome.storage.session.get(key))[key] || [];
  render();
}
function render() {
  const l = $('#list'); l.innerHTML = '';
  $('#all').style.display = media.length > 1 ? '' : 'none';
  if (!media.length) { l.innerHTML = '<div class="empty">No videos or audio detected on this page.<br>Play a video, then reopen this popup.</div>'; return; }
  media.forEach(m => {
    const d = document.createElement('div'); d.className = 'it';
    const ext = m.kind === 'HLS' ? '.ts' : '';
    d.innerHTML = `<div class="t"><b></b><small>${m.kind}${m.size ? ' • ' + fmt(m.size) : ''}</small></div><button>Download</button>`;
    d.querySelector('b').textContent = m.title || m.url; d.querySelector('b').title = m.url;
    d.querySelector('button').onclick = () => send([m], ext);
    l.appendChild(d);
  });
}
async function send(list, ext) {
  const items = list.map(m => ({ url: m.url, referer: tab.url, filename: m.title ? m.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) + (m.kind === 'HLS' ? '.ts' : '') : '' }));
  const r = await chrome.runtime.sendMessage({ type: 'send', items });
  $('#st').textContent = r && r.ok ? 'Sent to IDM Clone ✔' : (r && r.error) || 'Failed';
}
$('#all').onclick = () => send(media);
const save = () => chrome.storage.local.set({
  enabled: $('#enabled').checked, sniff: $('#sniff').checked, port: +$('#port').value || 7395, minSizeMB: +$('#min').value || 0, exts: $('#exts').value
});
['enabled', 'sniff', 'port', 'min', 'exts'].forEach(id => $('#' + id).addEventListener('change', save));
init();
