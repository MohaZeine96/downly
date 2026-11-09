const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, Notification, nativeImage, safeStorage } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http');
const { spawn } = require('child_process');
const { Download, limiter, cfg } = require('./downloader');
const { crawl } = require('./grabber');
const { categoryOf, DEFAULT_CAPTURE, isDownloadable, expandPattern, TYPE_SETS } = require('./utils');

let win, progressWindow, tray, server, serverPort = 0, downloads = [], settings, quitting = false;
const qstate = new Map(), lastStatus = new Map();
let progressIds = [];
let grabCancelled = false, clipSeen = '';

const DEFAULT_QUEUE = () => ({ id: 'main', name: 'Main queue', enabled: false, startTime: '', stopTime: '', days: [0, 1, 2, 3, 4, 5, 6], maxActive: 0, action: 'none' });
const dir = () => app.getPath('userData');
const F = n => path.join(dir(), n);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function readClipboardText() {
  const text = await clipboard.readText();
  return typeof text === 'string' ? text : '';
}
const toast = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('toast', msg); };

// ---- secrets (passwords) ----
const enc = s => {
  if (!s) return '';
  try { if (safeStorage && safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64'); } catch {}
  return 'b64:' + Buffer.from(s).toString('base64');
};
const dec = s => {
  if (!s || typeof s !== 'string') return '';
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString();
  } catch {}
  return s;
};

// ---- settings ----
function defaults() {
  return {
    folder: app.getPath('downloads'), useCategories: true, categoryFolders: {}, conns: 8, maxActive: 3, speedLimitKB: 0, ytDlpPath: 'yt-dlp',
    timeout: 20, retries: 5, conflict: 'rename', proxy: { enabled: false, host: '', port: 8080, user: '', pass: '' },
    sites: [], notify: true, sound: true, minimizeToTray: true, startWithOS: false, clipboardMonitor: true,
    theme: 'dark', postCmd: '', port: 7395, extShowDialog: true, captureExts: DEFAULT_CAPTURE, queues: [DEFAULT_QUEUE()]
  };
}
function loadSettings() {
  const d = defaults(), s = readJSON(F('settings.json'), {});
  const o = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  settings = { ...d, ...o, proxy: { ...d.proxy, ...(o.proxy || {}) } };
  settings.proxy.pass = dec(settings.proxy.pass);
  settings.sites = (Array.isArray(settings.sites) ? settings.sites : []).map(x => ({ ...x, pass: dec(x.pass) }));
  if (!Array.isArray(settings.queues) || !settings.queues.some(q => q.id === 'main')) settings.queues = [DEFAULT_QUEUE(), ...(Array.isArray(settings.queues) ? settings.queues : [])];
}
function resolveYtDlpPath(configuredPath) {
  const executable = String(configuredPath || '').trim();
  if (executable && executable !== 'yt-dlp' && executable !== 'yt-dlp.exe') return executable;
  for (const candidate of [
    path.join(process.resourcesPath || '', 'yt-dlp.exe'),
    path.join(path.dirname(app.getPath('exe')), 'yt-dlp.exe'),
    path.join(app.getAppPath(), 'yt-dlp.exe')
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return executable || 'yt-dlp';
}
function resolveFfmpegPath() {
  for (const candidate of [
    path.join(process.resourcesPath || '', 'ffmpeg.exe'),
    path.join(path.dirname(app.getPath('exe')), 'ffmpeg.exe'),
    path.join(app.getAppPath(), 'ffmpeg.exe')
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return '';
}
function save() {
  try {
    fs.writeFileSync(F('downloads.json'), JSON.stringify(downloads));
    const copy = JSON.parse(JSON.stringify(settings));
    copy.proxy.pass = enc(copy.proxy.pass);
    copy.sites.forEach(x => { x.pass = enc(x.pass); });
    fs.writeFileSync(F('settings.json'), JSON.stringify(copy));
  } catch (e) { /* ignore */ }
}
const getQ = id => settings.queues.find(q => q.id === id) || settings.queues[0];
function qs(id) {
  if (!qstate.has(id)) {
    const q = getQ(id);
    qstate.set(id, { running: q.id === 'main' && !(q.enabled && q.startTime), hadWork: false, lastStart: '', lastStop: '' });
  }
  return qstate.get(id);
}

function applySettings() {
  limiter.bps = (settings.speedLimitKB || 0) * 1024;
  cfg.proxy = settings.proxy.enabled && settings.proxy.host ? { ...settings.proxy, port: +settings.proxy.port || 8080 } : null;
  cfg.timeout = Math.max(5, +settings.timeout || 20);
  cfg.retries = Math.max(0, +settings.retries || 0);
  cfg.ytDlpPath = resolveYtDlpPath(settings.ytDlpPath);
  cfg.ytDlpFfmpegPath = resolveFfmpegPath();
  cfg.ytDlpSpeedLimitKB = settings.speedLimitKB > 0 ? settings.speedLimitKB / Math.max(1, settings.maxActive) : 0;
  cfg.confirmOverwrite = async filePath => {
    const options = {
      type: 'question',
      title: 'File already exists',
      message: `“${path.basename(filePath)}” already exists.`,
      detail: `Do you want to overwrite it?\n${filePath}`,
      buttons: ['Overwrite', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result.response === 0;
  };
  cfg.conflict = settings.conflict;
  cfg.authFor = host => {
    const s = settings.sites.find(x => x.host && x.user && (host === x.host || host.endsWith('.' + x.host)));
    return s ? { user: s.user, pass: s.pass } : null;
  };
  cfg.folderFor = (name, base) => {
    const cat = categoryOf(name);
    if (cat === 'General') return { folder: base, category: cat };
    return { folder: settings.categoryFolders[cat] || path.join(base, cat), category: cat };
  };
  try { app.setLoginItemSettings({ openAtLogin: !!settings.startWithOS }); } catch {}
  if (serverPort !== settings.port) startServer();
}

// ---- adding downloads ----
function isYouTubeMusicUrl(value) {
  try { return new URL(value).hostname.toLowerCase() === 'music.youtube.com'; }
  catch { return false; }
}

function addDownloads(items, opts = {}) {
  let added = 0, dup = 0;
  const ids = [];
  const base = opts.folder || settings.folder;
  const auto = settings.useCategories && (!opts.folder || opts.folder === settings.folder);
  for (const it of items) {
    const o = typeof it === 'string' ? { url: it } : it;
    const url = String(o.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const youtubeMusic = isYouTubeMusicUrl(url);
    if (downloads.some(d => d.url === url && d.status !== 'complete')) { dup++; continue; }
    const d = new Download({
      url, folder: base, baseFolder: base, autoFolder: auto, conns: opts.conns || settings.conns,
      queue: getQ(opts.queue || 'main').id, referer: o.referer || opts.referer || '', cookie: o.cookie || opts.cookie || '',
      ua: o.ua || '', name: o.probedName || o.filename || o.name || '', size: o.probed ? o.size : 0,
      ranged: !!o.ranged, kind: o.kind || 'http', engine: youtubeMusic ? 'yt-dlp' : o.engine || 'http', hls: o.hls || null, probed: !!o.probed,
      videoMode: youtubeMusic ? 'audio' : o.videoMode, videoQuality: o.videoQuality, audioQuality: o.audioQuality,
      speedLimitKB: opts.speedLimitKB || 0, comment: opts.comment || '', status: 'queued'
    });
    downloads.push(d);
    ids.push(d.id);
    if (opts.start === false) d.later = true;
    added++;
  }
  if (added) save();
  return { added, dup, ids };
}

// ---- scheduler / queue pump ----
const ACTIVE = ['connecting', 'downloading', 'merging'];
function powerAction(action) {
  const p = process.platform, run = (c, a) => { try { spawn(c, a, { detached: true, stdio: 'ignore' }).unref(); } catch {} };
  if (action === 'exit') return app.quit();
  if (action === 'shutdown') return p === 'win32' ? run('shutdown', ['/s', '/t', '0']) : p === 'darwin' ? run('osascript', ['-e', 'tell app "System Events" to shut down']) : run('shutdown', ['-h', 'now']);
  if (action === 'sleep') return p === 'win32' ? run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']) : p === 'darwin' ? run('pmset', ['sleepnow']) : run('systemctl', ['suspend']);
  if (action === 'hibernate') return p === 'win32' ? run('shutdown', ['/h']) : p === 'darwin' ? run('pmset', ['sleepnow']) : run('systemctl', ['hibernate']);
}

function onComplete(d) {
  if (settings.notify && Notification && Notification.isSupported()) {
    try { new Notification({ title: 'Download complete', body: d.path ? path.basename(d.path) : d.name }).show(); } catch {}
  }
  if (win && !win.isDestroyed()) win.webContents.send('dl:complete', { name: d.name, sound: settings.sound });
  if (settings.postCmd && d.path) {
    const cmd = settings.postCmd.replace(/\{file\}/g, '"' + d.path + '"');
    try { spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
}

function scheduleTick() {
  const now = new Date(), pad = n => String(n).padStart(2, '0');
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes()), dayKey = now.toDateString();
  for (const q of settings.queues) {
    if (!q.enabled || !(q.days || []).includes(now.getDay())) continue;
    const st = qs(q.id);
    if (q.startTime === hm && st.lastStart !== dayKey) { st.lastStart = dayKey; st.running = true; st.hadWork = false; downloads.forEach(d => { if (d.queue === q.id) d.later = false; }); toast(`Queue “${q.name}” started`); }
    if (q.stopTime === hm && st.lastStop !== dayKey) {
      st.lastStop = dayKey; st.running = false;
      downloads.filter(d => d.queue === q.id && ACTIVE.includes(d.status)).forEach(d => { d.pause(); d.status = 'queued'; });
      toast(`Queue “${q.name}” stopped`);
    }
  }
}

function pump() {
  let active = downloads.filter(d => ACTIVE.includes(d.status)).length;
  let slots = Math.max(1, settings.maxActive) - active;
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const minute = now.getHours() * 60 + now.getMinutes();
  for (const d of downloads) {
    if (d.scheduleDays && d.scheduleDays.length) {
      if (d.scheduleForcedDay && d.scheduleForcedDay !== dayKey) {
        d.force = false;
        d.scheduleForcedDay = '';
      }
      const start = d.scheduleStartTime.split(':').map(Number);
      const startMinute = start[0] * 60 + start[1];
      const isDay = d.scheduleDays.includes(now.getDay());
      const end = d.scheduleEndTime ? d.scheduleEndTime.split(':').map(Number) : null;
      const endMinute = end ? end[0] * 60 + end[1] : null;
      if (isDay && endMinute !== null && minute >= endMinute) {
        if (d.status !== 'complete' && d.status !== 'error' && d.status !== 'paused') d.pause();
        if (d.status !== 'complete' && d.status !== 'error') d.status = 'paused';
        d.scheduleLastEndDay = dayKey;
        d.scheduleForcedDay = '';
        d.force = false;
        continue;
      }
      if (isDay && minute >= startMinute && d.scheduleLastStartDay !== dayKey) {
        d.scheduleLastStartDay = dayKey;
        if (d.status === 'queued' || d.status === 'paused') {
          d.status = 'queued';
          d.later = false;
          d.force = true;
          d.scheduleForcedDay = dayKey;
        }
      }
      if (d.status === 'queued' && !d.force && d.scheduleLastStartDay !== dayKey) continue;
    }
    if (d.status !== 'queued' || d.later || slots <= 0) continue;
    const q = getQ(d.queue), st = qs(q.id);
    if (!(st.running || d.force)) continue;
    if (q.maxActive > 0 && downloads.filter(x => x.queue === q.id && ACTIVE.includes(x.status)).length >= q.maxActive) continue;
    d.start(); slots--;
  }
  for (const d of downloads) {
    d.tickSpeed();
    const prev = lastStatus.get(d.id);
    if (prev !== d.status) { lastStatus.set(d.id, d.status); if (d.status === 'complete' && prev) onComplete(d); }
    if (ACTIVE.includes(d.status)) qs(d.queue).hadWork = true;
  }
  const cancelledIds = downloads.filter(d => d.status === 'cancelled').map(d => d.id);
  if (cancelledIds.length) {
    const cancelled = new Set(cancelledIds);
    downloads = downloads.filter(d => !cancelled.has(d.id));
    cancelledIds.forEach(id => lastStatus.delete(id));
    save();
  }
  // queue finished?
  for (const q of settings.queues) {
    const st = qs(q.id);
    if (!st.hadWork) continue;
    const pending = downloads.some(d => d.queue === q.id && (d.status === 'queued' || ACTIVE.includes(d.status)));
    if (!pending) {
      st.hadWork = false;
      if (q.id !== 'main') st.running = false;
      if (q.action && q.action !== 'none') {
        if (win && !win.isDestroyed()) { win.show(); win.webContents.send('power:pending', { action: q.action, queue: q.name }); }
        else powerAction(q.action);
      }
    }
  }
  if (win && !win.isDestroyed()) {
    const speed = downloads.reduce((a, d) => a + d.speed, 0);
    win.webContents.send('dl:update', {
      items: downloads.map(d => d.snapshot()),
      qs: settings.queues.map(q => ({ id: q.id, running: qs(q.id).running })), speed
    });
    win.setTitle(speed > 0 ? `Downly — ${(speed / 1048576).toFixed(2)} MB/s` : 'Downly');
  }
  sendProgressUpdate();
}

// ---- browser-extension server ----
function startServer() {
  try { if (server) server.close(); } catch {}
  serverPort = settings.port;
  server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }
    if (origin && !/^(chrome|moz|edge|safari-web)-extension:\/\//.test(origin)) { res.writeHead(403); return res.end(); }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/ping') return json(200, { ok: true, app: 'Downly', exts: settings.captureExts });
    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        try {
          const p = JSON.parse(body), items = (p.items || []).filter(i => i && /^https?:/i.test(i.url));
          if (!items.length) return json(400, { ok: false });
          if (settings.extShowDialog && !p.silent) {
            if (win) { win.show(); win.focus(); win.webContents.send('add:prefill', items); }
            return json(200, { ok: true, dialog: true });
          }
          const r = addDownloads(items, {});
          if (win) win.webContents.send('toast', `Added ${r.added} download(s) from browser`);
          return json(200, { ok: true, ...r });
        } catch { json(400, { ok: false }); }
      });
      return;
    }
    json(404, { ok: false });
  });
  server.on('error', e => { serverPort = 0; toast('Browser integration port ' + settings.port + ' unavailable: ' + e.code); });
  server.listen(settings.port, '127.0.0.1');
}

// ---- window / tray ----
function showWindow() { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } }
function sendProgressUpdate() {
  if (!progressWindow || progressWindow.isDestroyed() || !progressWindow.webContents || progressWindow.webContents.isLoading()) return;
  const wanted = new Set(progressIds);
  const items = downloads.filter(d => wanted.has(d.id)).map(d => d.snapshot());
  progressWindow.webContents.send('progress:update', {
    items,
    speed: items.reduce((total, item) => total + item.speed, 0),
    maxActive: settings.maxActive,
    speedLimitKB: settings.speedLimitKB
  });
}
function showProgressWindow(ids) {
  progressIds = [...new Set((Array.isArray(ids) ? ids : []).filter(id => downloads.some(d => d.id === id)))];
  if (!progressIds.length) return false;
  if (!progressWindow || progressWindow.isDestroyed()) {
    progressWindow = new BrowserWindow({
      width: 650, height: 520, minWidth: 480, minHeight: 300, backgroundColor: '#14171c',
      title: 'Download progress',
      webPreferences: { preload: path.join(__dirname, 'progress-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    progressWindow.setMenu(null);
    progressWindow.loadFile(path.join(__dirname, 'progress.html'));
    progressWindow.webContents.once('did-finish-load', sendProgressUpdate);
    progressWindow.on('closed', () => { progressWindow = null; progressIds = []; });
  } else if (progressWindow.isMinimized()) {
    progressWindow.restore();
  }
  progressWindow.show();
  progressWindow.focus();
  sendProgressUpdate();
  return true;
}
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 740, minWidth: 900, minHeight: 540, backgroundColor: '#14171c', title: 'Downly',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    if (settings.minimizeToTray && tray) win.hide();
    else { quitting = true; app.quit(); }
  });
}
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 }));
    tray.setToolTip('Downly');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Downly', click: showWindow },
      { label: 'Resume all', click: () => downloads.forEach(d => { if (['paused', 'error'].includes(d.status)) { d.status = 'queued'; d.force = true; } }) },
      { label: 'Stop all', click: () => downloads.forEach(d => d.pause()) },
      { type: 'separator' },
      { label: 'Exit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
  } catch { tray = null; }
}

const urlsFromArgs = argv => argv.filter(a => /^https?:\/\//i.test(a));
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_, argv) => {
    showWindow();
    const u = urlsFromArgs(argv);
    if (u.length && win) win.webContents.send('add:prefill', u.map(url => ({ url })));
  });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.example.idmclone');
    loadSettings();
    const saved = readJSON(F('downloads.json'), []);
    for (const o of Array.isArray(saved) ? saved : []) {
      try {
        if (!o || typeof o.url !== 'string') continue;
        if (['connecting', 'downloading', 'merging'].includes(o.status)) {
          o.status = 'paused';
          o.scheduleLastStartDay = '';
        } else if (o.status === 'queued' && !o.scheduledAt && !(o.scheduleDays && o.scheduleDays.length)) {
          o.status = 'paused';
        }
        downloads.push(new Download(o));
      } catch (e) { /* skip corrupt entry */ }
    }
    downloads.forEach(d => lastStatus.set(d.id, d.status));
    applySettings();
    createWindow(); createTray();
    clipSeen = (await readClipboardText()).trim();
    const startUrls = urlsFromArgs(process.argv);
    if (startUrls.length) win.webContents.once('did-finish-load', () => win.webContents.send('add:prefill', startUrls.map(url => ({ url }))));
    setInterval(pump, 500);
    setInterval(save, 3000);
    setInterval(scheduleTick, 10000);
    setInterval(async () => {
      if (!settings.clipboardMonitor || !win || win.isDestroyed()) return;
      let t;
      try { t = (await readClipboardText()).trim(); }
      catch (e) { console.error('Clipboard monitor failed:', e); return; }
      if (!t || t === clipSeen) return;
      clipSeen = t;
      if (/^https?:\/\/\S+$/i.test(t) && isDownloadable(t)) { showWindow(); win.webContents.send('clip:url', t); }
    }, 1500);
  });
  app.on('before-quit', () => {
    quitting = true;
    downloads.forEach(d => {
      if (d.scheduleDays && d.scheduleDays.length && (ACTIVE.includes(d.status) || d.scheduleForcedDay)) {
        d.scheduleLastStartDay = '';
        d.scheduleForcedDay = '';
        d.force = false;
      }
      d.pause();
    });
    save();
  });
  app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });
}

// ---- IPC ----
ipcMain.handle('app:info', () => ({ version: app.getVersion(), port: serverPort, platform: process.platform }));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, s) => {
  settings = { ...settings, ...s, proxy: { ...settings.proxy, ...(s.proxy || {}) } };
  settings.queues = settings.queues || [];
  applySettings(); save(); return settings;
});
ipcMain.handle('queues:get', () => settings.queues.map(q => ({ ...q, running: qs(q.id).running })));
ipcMain.handle('queues:set', (_, arr) => {
  const list = (Array.isArray(arr) ? arr : []).map(q => ({ ...DEFAULT_QUEUE(), ...q, id: String(q.id) }));
  if (!list.some(q => q.id === 'main')) list.unshift(DEFAULT_QUEUE());
  settings.queues = list;
  for (const id of [...qstate.keys()]) if (!list.some(q => q.id === id)) qstate.delete(id);
  const m = list.find(q => q.id === 'main');
  if (m && !(m.enabled && m.startTime)) qs('main').running = true;
  downloads.forEach(d => { if (!list.some(q => q.id === d.queue)) d.queue = 'main'; });
  save(); return true;
});
ipcMain.handle('queue:ctl', (_, id, a) => {
  const st = qs(id);
  if (a === 'start') { st.running = true; st.hadWork = false; downloads.forEach(d => { if (d.queue === id) d.later = false; }); }
  else { st.running = false; downloads.filter(d => d.queue === id && ACTIVE.includes(d.status)).forEach(d => { d.pause(); d.status = 'queued'; }); }
});
ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.folder });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:ytdlp', async () => {
  const filters = process.platform === 'win32'
    ? [{ name: 'Executables', extensions: ['exe'] }]
    : process.platform === 'darwin'
      ? [{ name: 'Executables', extensions: ['*'] }]
      : [{ name: 'Executables', extensions: ['*'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('clipboard:url', async () => {
  const t = (await readClipboardText()).trim();
  return /^https?:\/\/\S+$/i.test(t) ? t : '';
});
ipcMain.handle('progress:open', (_, ids) => showProgressWindow(ids));
ipcMain.handle('progress:configure', (_, options = {}) => {
  const maxActive = Number(options.maxActive);
  const speedLimitKB = Number(options.speedLimitKB);
  const conns = Number(options.conns);
  const downloadSpeedLimitKB = Number(options.downloadSpeedLimitKB);
  const ids = Array.isArray(options.ids) ? new Set(options.ids.filter(id => typeof id === 'string')) : new Set();
  const targets = downloads.filter(d => ids.has(d.id) && d.status !== 'complete');
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 20 || !Number.isFinite(speedLimitKB) || speedLimitKB < 0)
    throw new Error('Enter 1–20 simultaneous downloads and a non-negative global speed limit.');
  if (targets.length && (!Number.isInteger(conns) || conns < 1 || conns > 32 ||
    !Number.isFinite(downloadSpeedLimitKB) || downloadSpeedLimitKB < 0))
    throw new Error('Enter 1–32 connections per download and a non-negative per-download speed limit.');
  settings.maxActive = maxActive;
  settings.speedLimitKB = speedLimitKB;
  applySettings();
  for (const d of targets) {
    d.conns = conns;
    d.setLimit(downloadSpeedLimitKB);
  }
  save();
  return true;
});
ipcMain.handle('dl:probe', async (event, items, opts = {}, probeId) => {
  const list = (Array.isArray(items) ? items : []).map(it => typeof it === 'string' ? { url: it } : it);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {}, url = String(item.url || '').trim();
    let result = { url, name: item.filename || item.name || '', size: null, kind: 'http', error: '' };
    try {
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Invalid http(s) URL');
      if (item.engine === 'yt-dlp') {
        result = { url, name: item.filename || item.name || '', size: null, engine: 'yt-dlp', probed: true, error: '' };
        results.push(result);
        if (!event.sender.isDestroyed())
          event.sender.send('dl:probe-progress', { probeId, index: i + 1, total: list.length, result });
        continue;
      }
      const d = new Download({
        url, name: item.filename || item.name || '', referer: item.referer || opts.referer || '',
        cookie: item.cookie || opts.cookie || '', ua: item.ua || ''
      });
      result = { url, ...await d.probe(), probed: true, error: '' };
    } catch (e) {
      result.error = e.message || String(e);
    }
    results.push(result);
    if (!event.sender.isDestroyed())
      event.sender.send('dl:probe-progress', { probeId, index: i + 1, total: list.length, result });
  }
  return results;
});
ipcMain.handle('batch:expand', (_, t) => expandPattern(String(t || '')));
ipcMain.handle('dl:add', (_, text, opts = {}) => {
  const meta = opts.meta || {};
  const items = String(text).split(/\s+/).filter(Boolean).map(url => ({ url, ...(meta[url] || {}) }));
  return addDownloads(items, opts);
});
ipcMain.handle('dl:addItems', (_, items, opts = {}) => addDownloads(items || [], opts));
ipcMain.handle('dl:act', (_, ids, action, arg) => {
  const sel = downloads.filter(x => ids.includes(x.id));
  if (action === 'schedule') {
    const days = Array.isArray(arg && arg.days) ? [...new Set(arg.days.map(Number))] : [];
    const startAt = String(arg && arg.startTime || '');
    const endAt = String(arg && arg.endTime || '');
    const validTime = value => /^\d{2}:\d{2}$/.test(value) && Number(value.slice(0, 2)) < 24 && Number(value.slice(3, 5)) < 60;
    const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      !validTime(startAt) || (endAt && (!validTime(endAt) || minutes(endAt) <= minutes(startAt))))
      throw new Error('Choose at least one weekday, a valid start time, and an end time after the start time.');
  }
  if (action === 'copyurl') clipboard.writeText(sel.map(d => d.url).join('\n'));
  for (const d of sel) {
    if (action === 'pause') d.pause();
    else if (action === 'resume' && (d.later || ['queued', 'paused', 'error'].includes(d.status))) {
      d.scheduleDays = []; d.scheduleStartTime = ''; d.scheduleEndTime = '';
      d.scheduleLastStartDay = ''; d.scheduleLastEndDay = ''; d.scheduleForcedDay = '';
      d.scheduledAt = null; d.scheduledEndAt = null;
      d.later = false; d.status = 'queued'; d.force = true;
    }
    else if (action === 'schedule' && d.status !== 'complete') {
      if (ACTIVE.includes(d.status)) d.pause();
      d.status = 'queued'; d.later = false; d.force = false;
      d.scheduledAt = null; d.scheduledEndAt = null;
      d.scheduleDays = [...new Set(arg.days.map(Number))];
      d.scheduleStartTime = String(arg.startTime);
      d.scheduleEndTime = String(arg.endTime || '');
      d.scheduleLastStartDay = ''; d.scheduleLastEndDay = ''; d.scheduleForcedDay = '';
    }
    else if (action === 'unschedule' && ((d.scheduleDays && d.scheduleDays.length) || d.scheduledAt || d.scheduledEndAt)) {
      d.scheduledAt = null; d.scheduledEndAt = null;
      d.scheduleDays = []; d.scheduleStartTime = ''; d.scheduleEndTime = '';
      d.scheduleLastStartDay = ''; d.scheduleLastEndDay = ''; d.scheduleForcedDay = '';
      d.later = false; d.force = true;
    }
    else if (action === 'open' && d.status === 'complete' && d.path) shell.openPath(d.path);
    else if (action === 'folder') (d.path && fs.existsSync(d.path)) ? shell.showItemInFolder(d.path) : shell.openPath(d.folder || settings.folder);
    else if (action === 'restart') { d.cancel(false); d.path = null; d.segs = []; d.hls = null; d.kind = 'http'; d.size = 0; d.status = 'queued'; d.force = true; }
    else if (action === 'moveQueue') d.queue = getQ(arg).id;
    else if (action === 'setLimit') d.setLimit(+arg || 0);
    else if (action === 'remove' || action === 'delete') { d.cancel(action === 'delete'); downloads = downloads.filter(x => x !== d); lastStatus.delete(d.id); }
  }
  save();
});
ipcMain.handle('dl:props', (_, id, p) => {
  const d = downloads.find(x => x.id === id); if (!d) return false;
  if (typeof p.url === 'string' && /^https?:\/\/\S+$/i.test(p.url.trim())) d.url = p.url.trim();
  if (typeof p.referer === 'string') d.referer = p.referer;
  if (typeof p.cookie === 'string') d.cookie = p.cookie;
  if (typeof p.comment === 'string') d.comment = p.comment;
  if (p.conns) d.conns = Math.min(32, Math.max(1, +p.conns));
  if (p.queue) d.queue = getQ(p.queue).id;
  if (p.speedLimitKB !== undefined) d.setLimit(+p.speedLimitKB || 0);
  if (p.refresh && ['paused', 'error'].includes(d.status)) { d.status = 'queued'; d.force = true; }
  save(); return true;
});
ipcMain.handle('grab:run', async (_, o) => {
  grabCancelled = false;
  const exts = new Set(String(o.custom || '').split(/[\s,;.]+/).filter(Boolean).map(s => s.toLowerCase()));
  for (const t of o.types || []) (TYPE_SETS[t] || '').split(' ').forEach(e => e && exts.add(e));
  if (!exts.size) return { error: 'Select at least one file type' };
  try {
    new URL(o.url);
    const files = await crawl(o.url, { depth: Math.min(5, +o.depth || 0), sameSite: !!o.sameSite, exts: [...exts], maxPages: 200 },
      p => win && win.webContents.send('grab:progress', p), () => grabCancelled);
    return { files };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('grab:cancel', () => { grabCancelled = true; });
ipcMain.handle('list:export', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'downloads.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled) return 0;
  const out = downloads.map(d => ({ url: d.url, referer: d.referer, filename: d.path ? path.basename(d.path) : d.name }));
  fs.writeFileSync(r.filePath, JSON.stringify(out, null, 2)); return out.length;
});
ipcMain.handle('list:import', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON / text', extensions: ['json', 'txt', 'lst'] }] });
  if (r.canceled) return null;
  const txt = fs.readFileSync(r.filePaths[0], 'utf8');
  let items; try { const j = JSON.parse(txt); items = (Array.isArray(j) ? j : []).map(x => typeof x === 'string' ? { url: x } : x); }
  catch { items = txt.split(/\s+/).filter(Boolean).map(url => ({ url })); }
  return addDownloads(items, {});
});
ipcMain.handle('power:do', (_, a) => powerAction(a));
ipcMain.handle('ext:show', () => {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', 'extension');
  shell.openPath(p); return p;
});
