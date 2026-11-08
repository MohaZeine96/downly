const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let items = [], qsRun = {}, settings = {}, queues = [], filter = 'all', sel = new Set(), lastId = null, visIds = [];
let sort = { key: null, dir: 1 }, hist = [], pendingMeta = {}, grabFiles = [], qEdit = [], qIdx = 0, powerTimer = null;
let probeId = '', probeReady = false, probeRows = [], scheduleIds = [];
const CATS = ['Compressed', 'Documents', 'Music', 'Programs', 'Video', 'Pictures', 'General'];
const ACTIVE = ['downloading', 'connecting', 'merging', 'queued'];
const rows = new Map();

// ---------- helpers ----------
const fmtSize = n => {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i ? n.toFixed(2) : n.toFixed(0)) + ' ' + u[i];
};
const fmtTime = s => {
  if (s == null || !isFinite(s)) return '-';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const isYouTubeMusicUrl = value => {
  try { return new URL(value).hostname.toLowerCase() === 'music.youtube.com'; }
  catch { return false; }
};
const fmtDate = t => { if (!t) return '-'; const d = new Date(t); return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const ICON = { zip: '🗜️', rar: '🗜️', '7z': '🗜️', mp4: '🎬', mkv: '🎬', avi: '🎬', ts: '🎬', webm: '🎬', mp3: '🎵', flac: '🎵', wav: '🎵', pdf: '📕', exe: '⚙️', msi: '⚙️', iso: '💿', jpg: '🖼️', png: '🖼️', gif: '🖼️', doc: '📄', docx: '📄', txt: '📄' };
const icon = n => ICON[(n.split('.').pop() || '').toLowerCase()] || '📦';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = d => d.status === 'complete' ? 100 : d.size ? Math.min(100, d.done / d.size * 100) : 0;
const qName = id => (queues.find(q => q.id === id) || { name: id }).name;
const toast = msg => {
  const d = document.createElement('div'); d.textContent = msg; $('#toast').appendChild(d);
  setTimeout(() => d.remove(), 4000);
};
const open = id => $(id).classList.add('on');
const close = id => $(id).classList.remove('on');
const anyModal = () => !!document.querySelector('.modal.on');
const fillQueues = sel => { sel.innerHTML = queues.map(q => `<option value="${esc(q.id)}">${esc(q.name)}</option>`).join(''); };

function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.15, c.currentTime + i * 0.16); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + i * 0.16 + 0.15);
      o.start(c.currentTime + i * 0.16); o.stop(c.currentTime + i * 0.16 + 0.16);
    });
  } catch (e) {}
}

// ---------- filtering / sorting ----------
function matches(d, f) {
  if (f === 'all') return true;
  if (f === 'active') return ACTIVE.includes(d.status);
  if (f === 'unfinished') return d.status !== 'complete';
  if (f === 'done') return d.status === 'complete';
  if (f.startsWith('cat:')) return d.category === f.slice(4);
  if (f.startsWith('q:')) return d.queue === f.slice(2);
  return true;
}
const sortVal = (d, k) => k === 'progress' ? pct(d) : k === 'eta' ? (d.eta == null ? 1e12 : d.eta) : d[k];

// ---------- sidebar ----------
function renderSide() {
  const cnt = f => items.filter(d => matches(d, f)).length;
  const row = (f, label) => `<div class="i ${filter === f ? 'on' : ''}" data-f="${esc(f)}"><span>${label}</span><b>${cnt(f)}</b></div>`;
  let h = '<h4>Downloads</h4>' + row('all', 'All downloads') + row('active', 'In progress') + row('unfinished', 'Unfinished') + row('done', 'Finished');
  h += '<h4>Categories</h4>' + CATS.map(c => row('cat:' + c, c)).join('');
  h += '<h4>Queues</h4>' + queues.map(q => `<div class="i ${filter === 'q:' + q.id ? 'on' : ''}" data-f="q:${esc(q.id)}"><span>${esc(q.name)}${qsRun[q.id] ? '<span class="run">● running</span>' : ''}</span><b>${cnt('q:' + q.id)}</b></div>`).join('');
  const el = $('#side');
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
$('#side').addEventListener('click', e => {
  const d = e.target.closest('[data-f]'); if (!d) return;
  filter = d.dataset.f; render();
});

// ---------- table ----------
function render() {
  let vis = items.filter(d => matches(d, filter));
  if (sort.key) vis = vis.slice().sort((a, b) => { const x = sortVal(a, sort.key), y = sortVal(b, sort.key); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  visIds = vis.map(d => d.id);
  const seen = new Set(), tb = $('#tb');
  vis.forEach((d, i) => {
    seen.add(d.id);
    let tr = rows.get(d.id);
    if (!tr) {
      tr = document.createElement('tr'); tr.className = 'row'; tr.dataset.id = d.id;
      tr.innerHTML = '<td></td><td></td><td><div class="bar"><i></i><em></em></div></td><td></td><td></td><td></td><td></td><td></td>';
      rows.set(d.id, tr);
    }
    if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] || null);
    const c = tr.children, p = pct(d);
    c[0].textContent = icon(d.name) + ' ' + d.name; c[0].title = d.url;
    c[1].textContent = fmtSize(d.size);
    const bar = c[2].firstChild;
    bar.className = 'bar' + (d.status === 'complete' ? ' c' : d.status === 'paused' ? ' p' : d.status === 'error' ? ' e' : '');
    bar.firstChild.style.width = p + '%';
    bar.lastChild.textContent = d.size ? p.toFixed(1) + '%' : (d.status === 'complete' ? '100%' : fmtSize(d.done));
    c[3].textContent = d.speed ? fmtSize(d.speed) + '/s' : '-';
    c[4].textContent = fmtTime(d.eta);
    const scheduled = d.scheduleDays && d.scheduleDays.length;
    c[5].textContent = d.status === 'error' ? 'Error: ' + d.error : scheduled ? 'Scheduled' : d.status[0].toUpperCase() + d.status.slice(1);
    c[5].title = scheduled ? `Starts ${d.scheduleStartTime} on ${d.scheduleDays.map(day => DAYS[day]).join(', ')}${d.scheduleEndTime ? `; ends ${d.scheduleEndTime}` : ''}` : d.error || '';
    c[5].className = 'st-' + d.status;
    c[6].textContent = qName(d.queue);
    c[7].textContent = fmtDate(d.added);
    tr.classList.toggle('sel', sel.has(d.id));
  });
  for (const [id, tr] of rows) if (!seen.has(id)) { tr.remove(); rows.delete(id); }
  $('#empty').style.display = vis.length ? 'none' : 'block';
  renderSide(); renderDetails(); drawChart();
  const speed = items.reduce((a, d) => a + d.speed, 0);
  $('#sCount').textContent = `${items.filter(d => d.status === 'downloading').length} active • ${items.filter(d => d.status === 'queued').length} queued • ${items.length} total`;
  $('#sSpeed').textContent = 'Speed: ' + (speed ? fmtSize(speed) + '/s' : '0 B/s') + (settings.speedLimitKB ? `  (limit ${settings.speedLimitKB} KB/s)` : '');
}

document.querySelector('thead').addEventListener('click', e => {
  const th = e.target.closest('th'); if (!th) return;
  const k = th.dataset.k;
  sort = sort.key === k ? (sort.dir === 1 ? { key: k, dir: -1 } : { key: null, dir: 1 }) : { key: k, dir: 1 };
  render();
});

$('#tb').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const id = tr.dataset.id;
  if (e.shiftKey && lastId && visIds.includes(lastId)) {
    const a = visIds.indexOf(lastId), b = visIds.indexOf(id);
    if (!e.ctrlKey) sel.clear();
    visIds.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(x => sel.add(x));
  } else if (e.ctrlKey || e.metaKey) { sel.has(id) ? sel.delete(id) : sel.add(id); lastId = id; }
  else { sel.clear(); sel.add(id); lastId = id; }
  render();
});
$('#tb').addEventListener('dblclick', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const d = items.find(x => x.id === tr.dataset.id);
  if (d && d.status === 'complete') api.act([d.id], 'open'); else openProps();
});

// ---------- details + chart ----------
function renderDetails() {
  const d = items.find(x => x.id === lastId && sel.has(x.id));
  const el = $('#det');
  if (!d) { el.textContent = 'Select a download to see details.'; return; }
  const segs = d.segs.map(g => {
    const w = g.len ? Math.min(100, g.d / g.len * 100) : pct(d);
    return `<div><i style="width:${w}%"></i></div>`;
  }).join('');
  el.innerHTML = `<div class="l"><span class="k">Name</span>${esc(d.name)}</div>
    <div class="l"><span class="k">URL</span>${esc(d.url)}</div>
    <div class="l"><span class="k">Saved to</span>${esc(d.path || d.folder)}</div>
    <div class="l"><span class="k">Downloaded</span>${fmtSize(d.done)} of ${fmtSize(d.size)} — ${d.segs.length || 1} connection${d.segs.length > 1 ? 's' : ''}${d.kind === 'hls' ? ' (HLS stream)' : ''}${d.resumable ? '' : ' — resume not supported'}</div>
    <div class="segs">${segs}</div>`;
}
function drawChart() {
  const cv = $('#chart'), box = $('#chartBox');
  const w = box.clientWidth - 20, h = box.clientHeight - 12;
  if (w <= 0 || h <= 0) return;
  if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d'), cs = getComputedStyle(document.body);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...hist) * 1.15, step = w / 119;
  ctx.beginPath(); ctx.moveTo(w - (hist.length - 1) * step, h);
  hist.forEach((v, i) => ctx.lineTo(w - (hist.length - 1 - i) * step, h - 16 - (v / max) * (h - 24)));
  ctx.lineTo(w, h); ctx.closePath();
  ctx.fillStyle = cs.getPropertyValue('--acc').trim() + '44'; ctx.fill();
  ctx.beginPath();
  hist.forEach((v, i) => { const x = w - (hist.length - 1 - i) * step, y = h - 16 - (v / max) * (h - 24); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = cs.getPropertyValue('--acc').trim(); ctx.lineWidth = 1.5; ctx.stroke();
  $('#chartLbl').textContent = 'Total speed — peak ' + fmtSize(Math.max(0, ...hist)) + '/s';
}

// ---------- toolbar actions ----------
const act = (a, arg) => { if (sel.size) api.act([...sel], a, arg); };
$('#bResume').onclick = () => act('resume');
$('#bPause').onclick = () => act('pause');
$('#bStopAll').onclick = () => api.act(items.map(d => d.id), 'pause');
$('#bStartQ').onclick = () => {
  const id = filter.startsWith('q:') ? filter.slice(2) : 'main';
  api.queueCtl(id, 'start'); toast(`Started queue “${qName(id)}”`);
};
$('#bScheduleDownload').onclick = () => openDownloadSchedule([...sel]);
$('#bRemove').onclick = () => { act('remove'); sel.clear(); };
$('#bDelete').onclick = () => { if (sel.size && confirm('Delete the selected download(s) AND their files from disk?')) { act('delete'); sel.clear(); } };
$('#bProps').onclick = () => openProps();
$('#bImport').onclick = async () => { const r = await api.importList(); if (r) toast(`Imported ${r.added} link(s)` + (r.dup ? `, ${r.dup} duplicate(s) skipped` : '')); };
$('#bExport').onclick = async () => { const n = await api.exportList(); if (n) toast(`Exported ${n} link(s)`); };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal').classList.remove('on'));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#ctx').style.display = 'none'; $$('.modal.on').forEach(m => { if (m.id !== 'mPower') m.classList.remove('on'); }); }
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'Delete') { act('remove'); sel.clear(); }
  if (e.key === 'Enter') { const d = items.find(x => sel.has(x.id)); if (d && d.status === 'complete') api.act([d.id], 'open'); }
  if (e.ctrlKey && e.key === 'a') { e.preventDefault(); visIds.forEach(id => sel.add(id)); render(); }
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); $('#bAdd').click(); }
});

// ---------- context menu ----------
document.addEventListener('click', () => { $('#ctx').style.display = 'none'; });
$('#tb').addEventListener('contextmenu', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  e.preventDefault();
  const clickedId = tr.dataset.id;
  if (!sel.has(clickedId)) { sel.clear(); sel.add(clickedId); render(); }
  lastId = clickedId;
  const contextIds = [...sel];
  const one = items.find(x => x.id === lastId);
  const done = one && one.status === 'complete';
  const hasScheduled = contextIds.some(id => items.some(d => d.id === id && d.scheduleDays && d.scheduleDays.length));
  const entries = [
    ['Show download progress', () => showProgress([clickedId])], '-',
    ['Schedule download…', () => openDownloadSchedule(contextIds)], ...(hasScheduled ? [['Cancel scheduled start', () => api.act(contextIds, 'unschedule')]] : []), '-',
    ['Open', () => act('open'), !done], ['Open folder', () => act('folder')], '-',
    ['Resume', () => act('resume')], ['Pause', () => act('pause')], ['Restart from beginning', () => confirm('Restart the selected download(s) from zero?') && act('restart')],
    ['Refresh address / properties…', () => openProps()], '-',
    ...queues.map(q => ['Move to queue: ' + q.name, () => act('moveQueue', q.id)]), '-',
    ['Copy URL', () => { act('copyurl'); toast('URL copied'); }], '-',
    ['Remove from list', () => { act('remove'); sel.clear(); }],
    ['Delete file too', () => { if (confirm('Delete download and file?')) { act('delete'); sel.clear(); } }]
  ];
  const m = $('#ctx'); m.innerHTML = '';
  entries.forEach(en => {
    if (en === '-') { m.appendChild(document.createElement('hr')); return; }
    const d = document.createElement('div'); d.textContent = en[0]; if (en[2]) d.className = 'dis';
    d.onclick = en[1]; m.appendChild(d);
  });
  m.style.display = 'block';
  m.style.left = Math.min(e.clientX, innerWidth - 230) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 10) + 'px';
});

// ---------- Add dialog ----------
function openAdd(prefill, videoMode = false) {
  if ($('#mAdd').classList.contains('on') && prefill) { $('#aUrl').value = ($('#aUrl').value.trim() + '\n' + prefill.map(i => i.url).join('\n')).trim(); }
  else {
    $('#aUrl').value = prefill ? prefill.map(i => i.url).join('\n') : '';
    $('#aDir').value = settings.folder; $('#aConns').value = settings.conns; $('#aLimit').value = 0;
    $('#aRef').value = ''; $('#aCookie').value = ''; $('#aComment').value = '';
    fillQueues($('#aQueue')); $('#aQueue').value = filter.startsWith('q:') ? filter.slice(2) : 'main';
    pendingMeta = {};
    $('#aVideo').checked = videoMode;
    $('#aVideoMode').value = 'video';
    $('#aVideoQuality').value = 'best';
    $('#aAudioQuality').value = '192';
    applyYouTubeMusicDefaults();
    updateVideoOptions();
  }
  if (prefill) prefill.forEach(i => { pendingMeta[i.url] = i; });
  applyYouTubeMusicDefaults();
  updateVideoOptions();
  invalidateProbe();
  $('#aProbe').textContent = $('#aVideo').checked ? 'Check video URL' : 'Check size';
  open('#mAdd'); $('#aUrl').focus();
}
$('#bAdd').onclick = async () => {
  const c = await api.clipboardUrl();
  openAdd(c ? [{ url: c }] : null);
};
$('#bVideo').onclick = () => openAdd(null, true);
$('#aBrowse').onclick = async () => { const d = await api.pickFolder(); if (d) $('#aDir').value = d; };
function invalidateProbe() {
  probeId = ''; probeReady = false; probeRows = [];
  for (const meta of Object.values(pendingMeta)) {
    delete meta.probed; delete meta.probedName; delete meta.size;
    delete meta.ranged; delete meta.kind; delete meta.hls;
  }
  $('#aProbeList').hidden = true; $('#aProbeList').textContent = '';
  $('#aProbe').disabled = false; $('#aProbe').textContent = 'Check size';
  $('#aOk').disabled = true; $('#aLater').disabled = true;
}

function renderProbeRows() {
  $('#aProbeList').hidden = false;
  $('#aProbeList').innerHTML = probeRows.map(row => {
    const r = row.result || {};
    const label = r.name || r.url || row.url;
    const status = r.error ? 'Error: ' + r.error
      : row.waiting ? 'Checking…'
      : r.engine === 'yt-dlp' ? 'Size determined when download starts'
      : r.kind === 'hls' ? 'Size unavailable (stream)'
      : r.size > 0 ? fmtSize(r.size)
      : 'Size unavailable';
    return `<div class="probe-row"><span title="${esc(label)}">${esc(label)}</span><span>${esc(status)}</span></div>`;
  }).join('');
}

async function checkSizes() {
  const urls = $('#aUrl').value.split(/\s+/).filter(url => /^https?:\/\/\S+$/i.test(url));
  if (!urls.length) return alert('Please enter at least one valid http(s) URL.');
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  probeId = id; probeReady = false;
  probeRows = urls.map(url => ({ url, waiting: true, result: null }));
  renderProbeRows();
  $('#aProbe').disabled = true; $('#aProbe').textContent = 'Checking…';
  $('#aOk').disabled = true; $('#aLater').disabled = true;
  try {
    const input = urls.map(url => {
      const youtubeMusic = isYouTubeMusicUrl(url);
      const engine = youtubeMusic || $('#aVideo').checked ? 'yt-dlp' : 'http';
      const item = { url, ...(pendingMeta[url] || {}), engine };
      if (engine === 'yt-dlp') {
        item.videoMode = youtubeMusic ? 'audio' : $('#aVideoMode').value;
        item.videoQuality = $('#aVideoQuality').value;
        item.audioQuality = $('#aAudioQuality').value;
      }
      return item;
    });
    const results = await api.probe(input, { referer: $('#aRef').value, cookie: $('#aCookie').value }, id);
    if (probeId !== id) return;
    probeRows = results.map(result => ({ url: result.url, result }));
    for (const result of results) {
      if (!result.probed) continue;
      const meta = pendingMeta[result.url] || {};
      pendingMeta[result.url] = {
        ...meta, probed: true, probedName: result.name, size: result.size || 0,
        ranged: result.ranged, kind: result.kind, hls: result.hls, engine: result.engine || 'http'
      };
    }
    probeReady = true;
    renderProbeRows();
    $('#aOk').disabled = false; $('#aLater').disabled = false;
  } catch (e) {
    if (probeId !== id) return;
    probeRows = urls.map(url => ({ url, result: { url, error: e.message || String(e) } }));
    renderProbeRows();
    probeReady = true;
    $('#aOk').disabled = false; $('#aLater').disabled = false;
  } finally {
    if (probeId === id) { $('#aProbe').disabled = false; $('#aProbe').textContent = 'Recheck sizes'; }
  }
}

function applyYouTubeMusicDefaults() {
  const urls = $('#aUrl').value.split(/\s+/).filter(Boolean);
  if (!urls.some(isYouTubeMusicUrl)) return;
  $('#aVideo').checked = true;
  $('#aVideoMode').value = 'audio';
}
$('#aUrl').addEventListener('input', () => {
  applyYouTubeMusicDefaults();
  updateVideoOptions();
  invalidateProbe();
  $('#aProbe').textContent = $('#aVideo').checked ? 'Check video URL' : 'Check size';
});
['#aRef', '#aCookie'].forEach(selector => $(selector).addEventListener('input', invalidateProbe));
$('#aVideo').addEventListener('change', () => {
  updateVideoOptions();
  invalidateProbe();
  $('#aProbe').textContent = $('#aVideo').checked ? 'Check video URL' : 'Check size';
});
function updateVideoOptions() {
  const enabled = $('#aVideo').checked;
  const audio = $('#aVideoMode').value === 'audio';
  const youtubeMusic = $('#aUrl').value.split(/\s+/).some(isYouTubeMusicUrl);
  $('#aVideoOptions').hidden = !enabled;
  $('#aVideoQualityWrap').hidden = audio;
  $('#aAudioQualityWrap').hidden = !audio;
  $('#aAudioHint').hidden = !enabled || !audio;
  $('#aYouTubeMusicHint').hidden = !youtubeMusic;
}
$('#aVideoMode').addEventListener('change', updateVideoOptions);
$('#aProbe').onclick = checkSizes;

async function doAdd(start) {
  if (!probeReady) { await checkSizes(); return; }
  const meta = Object.fromEntries(Object.entries(pendingMeta).map(([url, item]) => [url, {
    ...item,
    ...(item.engine === 'yt-dlp' ? {
      videoMode: $('#aVideoMode').value,
      videoQuality: $('#aVideoQuality').value,
      audioQuality: $('#aAudioQuality').value
    } : {})
  }]));
  const r = await api.add($('#aUrl').value, {
    folder: $('#aDir').value, conns: +$('#aConns').value || 8, queue: $('#aQueue').value, start,
    speedLimitKB: +$('#aLimit').value || 0, referer: $('#aRef').value, cookie: $('#aCookie').value, comment: $('#aComment').value, meta
  });
  if (!r.added && !r.dup) return alert('Please enter at least one valid http(s) URL.');
  close('#mAdd');
  if (r.ids && r.ids.length) {
    showProgress(r.ids);
  }
  toast(`Added ${r.added} download(s)` + (r.dup ? ` — ${r.dup} already in the list` : '') + (start ? '' : ' (waiting for queue start)'));
}
$('#aOk').onclick = () => doAdd(true);
$('#aLater').onclick = () => doAdd(false);
$('#sYtDlpBrowse').onclick = async () => {
  const executable = await api.pickYtDlp();
  if (executable) $('#sYtDlp').value = executable;
};

function showProgress(ids) {
  if (!ids.length) return;
  api.openProgress(ids).catch(e => alert(`Could not open progress window: ${e.message || e}`));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$('#scheduleDays').innerHTML = DAYS.map((day, i) => `<label><input type="checkbox" data-day="${i}"> ${day}</label>`).join('');
function syncScheduleDays() {
  const every = $('#scheduleEveryDay').checked;
  $$('#scheduleDays input').forEach(input => { input.disabled = every; });
  if (every) $$('#scheduleDays input').forEach(input => { input.checked = true; });
}
$('#scheduleEveryDay').onchange = syncScheduleDays;
$('#scheduleDays').addEventListener('change', () => {
  $('#scheduleEveryDay').checked = $$('#scheduleDays input').every(input => input.checked);
  syncScheduleDays();
});
function openDownloadSchedule(ids) {
  scheduleIds = ids.filter(id => items.some(d => d.id === id && d.status !== 'complete'));
  if (!scheduleIds.length) return toast('Select an unfinished download to schedule');
  const selected = scheduleIds.map(id => items.find(d => d.id === id));
  const existing = selected.find(d => d.scheduleDays && d.scheduleDays.length);
  const hasScheduled = !!existing;
  $('#scheduleCount').textContent = `Schedule ${scheduleIds.length} unfinished download${scheduleIds.length === 1 ? '' : 's'}.`;
  const days = existing ? existing.scheduleDays : DAYS.map((_, i) => i);
  $('#scheduleEveryDay').checked = days.length === 7;
  $$('#scheduleDays input').forEach(input => { input.checked = days.includes(+input.dataset.day); });
  syncScheduleDays();
  $('#scheduleAt').value = existing ? existing.scheduleStartTime : '09:00';
  $('#scheduleEndAt').value = existing ? existing.scheduleEndTime : '';
  $('#scheduleClear').disabled = !hasScheduled;
  open('#mDownloadSchedule');
}
$('#scheduleSave').onclick = async () => {
  const days = $('#scheduleEveryDay').checked ? DAYS.map((_, i) => i) : $$('#scheduleDays input:checked').map(input => +input.dataset.day);
  const startTime = $('#scheduleAt').value;
  const endTime = $('#scheduleEndAt').value;
  const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  if (!days.length) return alert('Choose at least one day of the week.');
  if (!/^\d{2}:\d{2}$/.test(startTime)) return alert('Choose a valid start time.');
  if (endTime && (!/^\d{2}:\d{2}$/.test(endTime) || toMinutes(endTime) <= toMinutes(startTime)))
    return alert('End time must be later than the start time.');
  try {
    await api.act(scheduleIds, 'schedule', { days, startTime, endTime });
    close('#mDownloadSchedule');
    toast(`Scheduled for ${days.length === 7 ? 'every day' : days.map(day => DAYS[day]).join(', ')} at ${startTime}${endTime ? ` until ${endTime}` : ''}`);
  } catch (e) { alert(`Could not schedule downloads: ${e.message || e}`); }
};
$('#scheduleClear').onclick = async () => {
  try {
    await api.act(scheduleIds, 'unschedule');
    close('#mDownloadSchedule');
    toast('Scheduled start canceled');
  } catch (e) { alert(`Could not cancel scheduled start: ${e.message || e}`); }
};

// ---------- Batch ----------
$('#bBatch').onclick = () => {
  $('#bTpl').value = ''; $('#bInfo').textContent = '0 URLs'; $('#bDir').value = settings.folder;
  fillQueues($('#bQueue')); open('#mBatch'); $('#bTpl').focus();
};
$('#bTpl').oninput = async () => {
  const l = await api.expand($('#bTpl').value);
  const ok = l.filter(u => /^https?:\/\//i.test(u));
  $('#bInfo').textContent = ok.length ? `${ok.length} URLs — ${ok[0]}${ok.length > 1 ? '  …  ' + ok[ok.length - 1] : ''}` : 'Enter a full http(s) URL template';
};
$('#bBrowse').onclick = async () => { const d = await api.pickFolder(); if (d) $('#bDir').value = d; };
async function doBatch(start) {
  const l = (await api.expand($('#bTpl').value)).filter(u => /^https?:\/\//i.test(u));
  if (!l.length) return alert('Enter a valid URL template.');
  if (l.length > 500 && !confirm(`Add ${l.length} downloads?`)) return;
  const r = await api.addItems(l.map(url => ({ url })), { folder: $('#bDir').value, queue: $('#bQueue').value, start });
  close('#mBatch'); toast(`Added ${r.added} download(s)` + (r.dup ? `, ${r.dup} duplicate(s) skipped` : ''));
}
$('#bOk').onclick = () => doBatch(true);
$('#bLater').onclick = () => doBatch(false);

// ---------- Grabber ----------
$('#bGrab').onclick = () => {
  fillQueues($('#gQueue')); $('#gList').innerHTML = ''; grabFiles = []; $('#gInfo').textContent = 'Enter a page URL and click Explore.';
  open('#mGrab'); $('#gUrl').focus();
};
$('#gGo').onclick = async () => {
  const url = $('#gUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) return alert('Enter a valid http(s) URL.');
  $('#gGo').style.display = 'none'; $('#gStop').style.display = ''; $('#gList').innerHTML = ''; $('#gInfo').textContent = 'Exploring…';
  const r = await api.grab({
    url, depth: +$('#gDepth').value, sameSite: $('#gSame').checked, custom: $('#gCustom').value,
    types: $$('#gTypes input:checked').map(i => i.value)
  });
  $('#gGo').style.display = ''; $('#gStop').style.display = 'none';
  if (r.error) { $('#gInfo').textContent = r.error; return; }
  grabFiles = r.files;
  $('#gInfo').textContent = `Found ${grabFiles.length} file(s).`;
  $('#gList').innerHTML = grabFiles.map((f, i) => `<div><input type="checkbox" data-i="${i}" checked><span title="${esc(f.url)}">${esc(f.name)}</span></div>`).join('');
};
$('#gStop').onclick = () => api.grabCancel();
api.onGrab(p => { $('#gInfo').textContent = `Exploring… ${p.pages} page(s), ${p.files} file(s) found`; });
$('#gAll').onchange = e => $$('#gList input').forEach(i => { i.checked = e.target.checked; });
$('#gAdd').onclick = async () => {
  const pick = $$('#gList input:checked').map(i => grabFiles[+i.dataset.i]);
  if (!pick.length) return alert('Nothing selected.');
  const r = await api.addItems(pick.map(f => ({ url: f.url, referer: f.ref })), { queue: $('#gQueue').value });
  close('#mGrab'); toast(`Added ${r.added} download(s)` + (r.dup ? `, ${r.dup} duplicate(s) skipped` : ''));
};

// ---------- Properties ----------
function openProps() {
  const d = items.find(x => x.id === lastId && sel.has(x.id)) || items.find(x => sel.has(x.id));
  if (!d) return toast('Select a download first');
  lastId = d.id;
  $('#pInfo').innerHTML = `${esc(d.name)}<br>${fmtSize(d.size)} • ${esc(d.status)} • ${esc(d.category)} • ${esc(d.path || d.folder)}<br>Added ${fmtDate(d.added)}${d.completed ? ' • Completed ' + fmtDate(d.completed) : ''}`;
  $('#pUrl').value = d.url; $('#pRef').value = d.referer; $('#pCookie').value = d.cookie; $('#pComment').value = d.comment;
  $('#pConns').value = d.conns; $('#pLimit').value = d.speedLimitKB;
  fillQueues($('#pQueue')); $('#pQueue').value = d.queue;
  open('#mProps');
}
const readProps = refresh => ({
  url: $('#pUrl').value, referer: $('#pRef').value, cookie: $('#pCookie').value, comment: $('#pComment').value,
  conns: +$('#pConns').value, speedLimitKB: +$('#pLimit').value, queue: $('#pQueue').value, refresh
});
$('#pSave').onclick = async () => { await api.props(lastId, readProps(false)); close('#mProps'); };
$('#pRefresh').onclick = async () => { await api.props(lastId, readProps(true)); close('#mProps'); };

// ---------- Options ----------
$('#sTabs').addEventListener('click', e => {
  const t = e.target.closest('[data-p]'); if (!t) return;
  $$('#sTabs div').forEach(x => x.classList.toggle('on', x === t));
  $$('#mSet .pane').forEach(p => p.classList.toggle('on', p.dataset.p === t.dataset.p));
});
const siteRow = (s = {}) => {
  const d = document.createElement('div'); d.className = 'siterow';
  d.innerHTML = `<input placeholder="host (example.com)" value="${esc(s.host || '')}"><input placeholder="user" value="${esc(s.user || '')}"><input type="password" placeholder="password" value="${esc(s.pass || '')}"><button class="btn d">✕</button>`;
  d.lastChild.onclick = () => d.remove(); return d;
};
$('#sSiteAdd').onclick = () => $('#sSites').appendChild(siteRow());
$('#bSet').onclick = async () => {
  settings = await api.getSettings(); const info = await api.info(); const s = settings, p = s.proxy;
  $('#sDir').value = s.folder; $('#sCats').checked = s.useCategories; $('#sConns').value = s.conns; $('#sMax').value = s.maxActive;
  $('#sYtDlp').value = s.ytDlpPath || 'yt-dlp';
  $('#sConf').value = s.conflict; $('#sTheme').value = s.theme; $('#sNotify').checked = s.notify; $('#sSound').checked = s.sound;
  $('#sClip').checked = s.clipboardMonitor; $('#sTray').checked = s.minimizeToTray; $('#sBoot').checked = s.startWithOS; $('#sPost').value = s.postCmd;
  $('#sLim').value = s.speedLimitKB; $('#sTime').value = s.timeout; $('#sRetry').value = s.retries;
  $('#pxOn').checked = p.enabled; $('#pxHost').value = p.host; $('#pxPort').value = p.port; $('#pxUser').value = p.user; $('#pxPass').value = p.pass;
  $('#sExts').value = s.captureExts; $('#sPort').value = s.port; $('#sExtDlg').checked = s.extShowDialog;
  $('#sCatDirs').innerHTML = CATS.filter(c => c !== 'General').map(c => `<div><label>${c}</label><input data-cat="${c}" value="${esc((s.categoryFolders || {})[c] || '')}" placeholder="default"></div>`).join('');
  $('#sSites').innerHTML = ''; (s.sites || []).forEach(x => $('#sSites').appendChild(siteRow(x)));
  $('#sExtInfo').textContent = info.port ? `Integration server is listening on 127.0.0.1:${info.port}` : 'Integration server is NOT running (port in use?) — choose another port.';
  open('#mSet');
};
$('#sBrowse').onclick = async () => { const d = await api.pickFolder(); if (d) $('#sDir').value = d; };
$('#sExt').onclick = () => api.showExtension();
$('#sOk').onclick = async () => {
  const cf = {}; $$('#sCatDirs input').forEach(i => { if (i.value.trim()) cf[i.dataset.cat] = i.value.trim(); });
  const sites = $$('#sSites .siterow').map(r => { const i = r.querySelectorAll('input'); return { host: i[0].value.trim().toLowerCase(), user: i[1].value, pass: i[2].value }; }).filter(x => x.host);
  settings = await api.setSettings({
    folder: $('#sDir').value, useCategories: $('#sCats').checked, categoryFolders: cf, conns: +$('#sConns').value || 8, maxActive: +$('#sMax').value || 3,
    ytDlpPath: $('#sYtDlp').value.trim() || 'yt-dlp',
    conflict: $('#sConf').value, theme: $('#sTheme').value, notify: $('#sNotify').checked, sound: $('#sSound').checked,
    clipboardMonitor: $('#sClip').checked, minimizeToTray: $('#sTray').checked, startWithOS: $('#sBoot').checked, postCmd: $('#sPost').value,
    speedLimitKB: +$('#sLim').value || 0, timeout: +$('#sTime').value || 20, retries: +$('#sRetry').value || 0,
    proxy: { enabled: $('#pxOn').checked, host: $('#pxHost').value.trim(), port: +$('#pxPort').value || 8080, user: $('#pxUser').value, pass: $('#pxPass').value },
    captureExts: $('#sExts').value, port: +$('#sPort').value || 7395, extShowDialog: $('#sExtDlg').checked, sites
  });
  document.body.dataset.theme = settings.theme; close('#mSet'); toast('Options saved');
};

// ---------- Scheduler ----------
$('#qDays').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" data-d="${i}"> ${d}</label>`).join('');
function readQ() {
  const q = qEdit[qIdx]; if (!q) return;
  q.name = $('#qName').value || 'Queue'; q.enabled = $('#qEn').checked; q.startTime = $('#qStart').value; q.stopTime = $('#qStop').value;
  q.days = $$('#qDays input:checked').map(i => +i.dataset.d); q.maxActive = +$('#qMax').value || 0; q.action = $('#qAct').value;
}
function showQ() {
  $('#qList').innerHTML = qEdit.map((q, i) => `<div class="${i === qIdx ? 'sel' : ''}" data-i="${i}"><span>${esc(q.name)}${q.running ? ' ●' : ''}</span></div>`).join('');
  const q = qEdit[qIdx];
  $('#qName').value = q.name; $('#qEn').checked = q.enabled; $('#qStart').value = q.startTime || ''; $('#qStop').value = q.stopTime || '';
  $$('#qDays input').forEach(i => { i.checked = (q.days || []).includes(+i.dataset.d); });
  $('#qMax').value = q.maxActive || 0; $('#qAct').value = q.action || 'none'; $('#qDel').disabled = q.id === 'main';
}
$('#bSched').onclick = async () => { qEdit = await api.getQueues(); qIdx = 0; showQ(); open('#mSched'); };
$('#qList').addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (!d) return; readQ(); qIdx = +d.dataset.i; showQ(); });
$('#qNew').onclick = () => {
  readQ(); qEdit.push({ id: 'q' + Date.now(), name: 'New queue', enabled: false, startTime: '', stopTime: '', days: [0, 1, 2, 3, 4, 5, 6], maxActive: 0, action: 'none' });
  qIdx = qEdit.length - 1; showQ();
};
$('#qDel').onclick = () => { if (qEdit[qIdx].id === 'main') return; qEdit.splice(qIdx, 1); qIdx = 0; showQ(); };
$('#qRun').onclick = async () => { readQ(); await api.setQueues(qEdit); await api.queueCtl(qEdit[qIdx].id, 'start'); toast('Queue started'); };
$('#qHalt').onclick = async () => { readQ(); await api.setQueues(qEdit); await api.queueCtl(qEdit[qIdx].id, 'stop'); toast('Queue stopped'); };
$('#qSave').onclick = async () => {
  readQ();
  for (const q of qEdit) if (q.enabled && !q.startTime) return alert(`Queue “${q.name}”: set a start time or disable the schedule.`);
  await api.setQueues(qEdit); queues = await api.getQueues(); close('#mSched'); renderSide(); toast('Scheduler saved');
};

// ---------- power countdown ----------
api.onPower(({ action, queue }) => {
  const label = { exit: 'exit the program', sleep: 'put the computer to sleep', hibernate: 'hibernate the computer', shutdown: 'shut down the computer' }[action] || action;
  let n = 30; $('#pwTitle').textContent = `Queue “${queue}” finished`;
  const tick = () => { $('#pwText').textContent = `All downloads are complete. The app will ${label} in ${n} seconds.`; };
  tick(); open('#mPower'); clearInterval(powerTimer);
  const finish = go => { clearInterval(powerTimer); close('#mPower'); if (go) api.power(action); };
  powerTimer = setInterval(() => { n--; tick(); if (n <= 0) finish(true); }, 1000);
  $('#pwCancel').onclick = () => finish(false); $('#pwNow').onclick = () => finish(true);
});

// ---------- drag & drop ----------
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('drop'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('drop');
  const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '');
  const urls = t.split(/\s+/).filter(u => /^https?:\/\//i.test(u));
  if (urls.length) openAdd(urls.map(url => ({ url }))); else toast('No links found in dropped item');
});

// ---------- events from main ----------
api.onUpdate(p => {
  items = p.items; qsRun = {}; p.qs.forEach(q => { qsRun[q.id] = q.running; });
  hist.push(p.speed); if (hist.length > 120) hist.shift();
  const ids = new Set(items.map(x => x.id)); sel = new Set([...sel].filter(id => ids.has(id)));
  render();
});
api.onProbeProgress(({ probeId: id, index, result }) => {
  if (id !== probeId || !probeRows[index - 1]) return;
  probeRows[index - 1] = { url: result.url, result, waiting: false };
  renderProbeRows();
});
api.onComplete(c => { if (c.sound) beep(); toast('✔ Completed: ' + c.name); });
api.onPrefill(list => openAdd(list));
api.onClip(url => { if (!anyModal()) openAdd([{ url }]); });
api.onToast(toast);

(async () => {
  settings = await api.getSettings(); queues = await api.getQueues();
  document.body.dataset.theme = settings.theme || 'dark'; renderSide();
  setInterval(async () => { const q = await api.getQueues(); if (JSON.stringify(q.map(x => [x.id, x.name])) !== JSON.stringify(queues.map(x => [x.id, x.name]))) { queues = q; renderSide(); } }, 4000);
})();
