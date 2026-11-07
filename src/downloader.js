'use strict';
// Download engine: segmented HTTP(S) with dynamic re-segmentation, pause/resume,
// retries, proxy, site auth, referer/cookies, per-download + global speed limits,
// and HLS (.m3u8, incl. AES-128) downloading.
const http = require('http'), https = require('https'), tls = require('tls'), { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { categoryOf } = require('./utils');

const cfg = {
  proxy: null, timeout: 20, retries: 5, conflict: 'rename',
  ytDlpPath: 'yt-dlp', ytDlpSpeedLimitKB: 0, confirmOverwrite: async () => false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IDMClone/2.0',
  authFor: () => null, folderFor: null
};
const MIN_SEG = 512 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const overwriteCancelled = () => Object.assign(
  new Error('Download cancelled because the destination file already exists.'),
  { code: 'DOWNLOAD_CANCELLED' }
);
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p || ''}`).toString('base64');
const reserved = new Set();

class Limiter {
  constructor(kb = 0) { this.bps = kb * 1024; this.bytes = 0; this.t = Date.now(); }
  delay(n) {
    if (!this.bps) return 0;
    const now = Date.now();
    if (now - this.t >= 1000) { this.t = now; this.bytes = 0; }
    this.bytes += n;
    return this.bytes > this.bps ? Math.max(1, this.t + 1000 - now) : 0;
  }
}
const limiter = new Limiter(0); // global

function connectAgent(proxy) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, cb) => {
    const host = options.host || options.hostname, port = options.port || 443;
    const headers = { Host: `${host}:${port}` };
    if (proxy.user) headers['Proxy-Authorization'] = basic(proxy.user, proxy.pass);
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${host}:${port}`, headers });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error('Proxy CONNECT failed: ' + res.statusCode)); }
      cb(null, tls.connect({ socket, servername: options.servername || host }));
    });
    req.on('error', cb);
    req.end();
  };
  return agent;
}

// dl: object with optional {ua, referer, cookie}
function request(url, dl, extra = {}, redirects = 6) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Unsupported protocol'));
    dl = dl || {};
    const headers = { 'User-Agent': dl.ua || cfg.userAgent, Accept: '*/*', 'Accept-Encoding': 'identity', ...extra };
    if (dl.referer) headers.Referer = dl.referer;
    if (dl.cookie) headers.Cookie = dl.cookie;
    const a = cfg.authFor(u.hostname) || (u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : null);
    if (a) headers.Authorization = basic(a.user, a.pass);
    const proxy = cfg.proxy && cfg.proxy.host ? cfg.proxy : null;
    const isHttps = u.protocol === 'https:';
    const opts = { method: 'GET', headers };
    let lib = isHttps ? https : http;
    if (proxy && !isHttps) {
      lib = http; opts.host = proxy.host; opts.port = proxy.port; opts.path = url; headers.Host = u.host;
      if (proxy.user) headers['Proxy-Authorization'] = basic(proxy.user, proxy.pass);
    } else {
      opts.hostname = u.hostname; if (u.port) opts.port = u.port; opts.path = u.pathname + u.search;
      if (proxy && isHttps) opts.agent = connectAgent(proxy);
    }
    const req = lib.request(opts, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url);
        const nd = next.host === u.host ? dl : { ua: dl.ua, referer: dl.referer };
        return resolve(request(next.href, nd, extra, redirects - 1));
      }
      resolve({ res, req });
    });
    req.on('error', reject);
    req.setTimeout(cfg.timeout * 1000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

function readBody(res, max = 5e6) {
  return new Promise((ok, bad) => {
    const ch = []; let n = 0;
    res.on('data', c => { n += c.length; ch.push(c); if (n > max) res.destroy(); });
    res.on('end', () => ok(Buffer.concat(ch)));
    res.on('error', bad);
    res.on('close', () => ok(Buffer.concat(ch)));
  });
}
async function fetchText(url, dl) {
  const { res, req } = await request(url, dl);
  if (res.statusCode >= 400) { req.destroy(); throw new Error('HTTP ' + res.statusCode); }
  const b = await readBody(res, 3e6); req.destroy();
  return b.toString('utf8');
}

const sanitize = n => (String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 200)) || 'download';
function guessExt(ct) {
  const m = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
    'audio/ogg': '.ogg', 'application/pdf': '.pdf', 'application/zip': '.zip', 'image/jpeg': '.jpg', 'image/png': '.png',
    'image/gif': '.gif', 'video/x-matroska': '.mkv' };
  return m[(ct || '').split(';')[0].trim()] || '';
}
function uniquePath(folder, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p = path.join(folder, name), i = 1;
  while (fs.existsSync(p) || fs.existsSync(p + '.idm0') || reserved.has(p)) p = path.join(folder, `${base} (${i++})${ext}`);
  return p;
}
function removeStaleParts(p) {
  try {
    const dir = path.dirname(p), b = path.basename(p) + '.idm';
    for (const f of fs.readdirSync(dir)) if (f.startsWith(b)) try { fs.unlinkSync(path.join(dir, f)); } catch {}
  } catch {}
}
const attr = (line, k) => {
  const m = line.match(new RegExp(k + '=("([^"]*)"|[^,]*)'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
};

class Download {
  constructor(o) {
    Object.assign(this, {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      url: '', folder: '', baseFolder: '', autoFolder: false, name: '', path: null, size: 0, ranged: false,
      kind: 'http', engine: 'http', segs: [], hls: null, probed: false, externalDone: 0, status: 'queued', error: '', conns: 8, added: Date.now(), completed: 0,
      queue: 'main', category: '', referer: '', cookie: '', ua: '', speedLimitKB: 0, comment: '',
      scheduleDays: [], scheduleStartTime: '', scheduleEndTime: '', scheduleLastStartDay: '', scheduleLastEndDay: '', scheduleForcedDay: ''
    }, o);
    if (o.scheduledAt && !this.scheduleDays.length) {
      const start = new Date(o.scheduledAt);
      this.scheduleDays = [start.getDay()];
      this.scheduleStartTime = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
      if (o.scheduledEndAt) {
        const end = new Date(o.scheduledEndAt);
        this.scheduleEndTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
      }
      this.scheduledAt = null;
      this.scheduledEndAt = null;
    }
    if (!this.baseFolder) this.baseFolder = this.folder;
    if (!this.name) {
      try { this.name = decodeURIComponent(path.basename(new URL(this.url).pathname)) || 'download'; }
      catch { this.name = 'download'; }
    }
    this.limiter = new Limiter(this.speedLimitKB);
    this.speed = 0; this.force = false; this.later = false;
    this._abort = false; this._running = false; this._active = 0; this._live = 0;
    this._reqs = new Set(); this._keys = null;
    if (this.path && this.status !== 'complete') reserved.add(this.path);
    this._last = [Date.now(), this.done];
  }

  get done() {
    if (this.status === 'complete') return this.size;
    if (this.engine === 'yt-dlp') return this.externalDone;
    if (this.kind === 'hls' && this.hls) return this.hls.segs.reduce((a, s) => a + (s.done ? s.bytes : 0), 0) + this._live;
    return this.segs.reduce((a, g) => a + g.done, 0);
  }

  setLimit(kb) { this.speedLimitKB = kb || 0; this.limiter.bps = this.speedLimitKB * 1024; }

  toJSON() {
    const o = {};
    for (const k of ['id', 'url', 'folder', 'baseFolder', 'autoFolder', 'name', 'path', 'size', 'ranged', 'kind', 'engine', 'segs', 'hls', 'probed', 'externalDone',
      'status', 'error', 'conns', 'added', 'completed', 'queue', 'category', 'referer', 'cookie', 'ua', 'speedLimitKB', 'comment',
      'scheduleDays', 'scheduleStartTime', 'scheduleEndTime', 'scheduleLastStartDay', 'scheduleLastEndDay', 'scheduleForcedDay']) o[k] = this[k];
    return o;
  }

  _stop() {
    for (const r of this._reqs) r.destroy();
    this._reqs.clear();
    if (this._child && !this._child.killed) this._child.kill();
  }
  pause() {
    if (['complete', 'error'].includes(this.status)) return;
    this._abort = true; this._stop(); this.status = 'paused'; this.speed = 0;
  }
  allParts() {
    if (this.engine === 'yt-dlp' && this.path) return [`${this.path}.part`, `${this.path}.ytdl`];
    if (this.kind === 'hls' && this.hls) return this.hls.segs.map((s, i) => `${this.path}.idm${i}`);
    return this.segs.map(g => g.part);
  }
  cancel(deleteFile) {
    this._abort = true; this._stop();
    if (this.path) for (const p of this.allParts()) try { fs.unlinkSync(p); } catch {}
    if (deleteFile && this.path) try { fs.unlinkSync(this.path); } catch {}
    reserved.delete(this.path);
  }

  // ---------- probing ----------
  async _probe() {
    if (!/\.m3u8(\?|#|$)/i.test(this.url)) {
      const { res, req } = await request(this.url, this, { Range: 'bytes=0-0' });
      const ct = (res.headers['content-type'] || '').toLowerCase();
      if (res.statusCode === 416) { req.destroy(); this.size = 0; this.ranged = false; return; }
      if (res.statusCode >= 400) { req.destroy(); throw new Error('HTTP ' + res.statusCode); }
      req.destroy();
      if (/mpegurl/.test(ct)) return this._probeHls();
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
      if (m) { try { this.name = decodeURIComponent(m[1]).trim(); } catch { this.name = m[1].trim(); } }
      const cr = res.headers['content-range'];
      if (res.statusCode === 206 && cr && /\/\d+$/.test(cr)) { this.size = parseInt(cr.split('/').pop(), 10); this.ranged = true; }
      else { this.size = parseInt(res.headers['content-length'] || '0', 10); this.ranged = false; }
      if (!path.extname(this.name)) this.name += guessExt(ct);
      return;
    }
    return this._probeHls();
  }

  async probe() {
    await this._probe();
    this.probed = true;
    return { name: this.name, size: this.kind === 'hls' ? null : this.size, ranged: this.ranged, kind: this.kind, hls: this.hls };
  }

  async _probeHls() {
    let url = this.url, text = await fetchText(url, this);
    if (!text.includes('#EXTM3U')) throw new Error('Not a valid playlist');
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split(/\r?\n/); let best = null, bw = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const m = lines[i].match(/BANDWIDTH=(\d+)/), b = m ? +m[1] : 0;
        let j = i + 1; while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
        if (lines[j] && b > bw) { bw = b; best = lines[j].trim(); }
      }
      if (!best) throw new Error('No playable variant found');
      url = new URL(best, url).href; text = await fetchText(url, this);
    }
    if (!/#EXT-X-ENDLIST/.test(text)) throw new Error('Live HLS streams are not supported');
    const segs = []; let key = null, seq = 0, hasMap = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.split(':')[1], 10) || 0;
      else if (line.startsWith('#EXT-X-KEY')) {
        const method = attr(line, 'METHOD');
        if (method === 'NONE') key = null;
        else if (method === 'AES-128') key = { uri: new URL(attr(line, 'URI'), url).href, iv: attr(line, 'IV') };
        else throw new Error('Unsupported HLS encryption: ' + method);
      } else if (line.startsWith('#EXT-X-MAP') && !hasMap) {
        hasMap = true; segs.push({ u: new URL(attr(line, 'URI'), url).href, done: false, bytes: 0, key: null, seq: 0 });
      } else if (!line.startsWith('#')) {
        segs.push({ u: new URL(line, url).href, done: false, bytes: 0, key, seq: seq++ });
      }
    }
    if (!segs.length) throw new Error('Playlist has no segments');
    this.kind = 'hls'; this.hls = { segs }; this.ranged = false; this.size = 0;
    this.name = (this.name.replace(/\.(m3u8|ts|php|html?|aspx?)$/i, '') || 'video') + (hasMap ? '.mp4' : '.ts');
  }

  async _plan() {
    const name = sanitize(this.name);
    if (this.autoFolder && cfg.folderFor) { const r = cfg.folderFor(name, this.baseFolder); this.folder = r.folder; this.category = r.category; }
    else this.category = categoryOf(name);
    fs.mkdirSync(this.folder, { recursive: true });
    const destination = path.join(this.folder, name);
    if (fs.existsSync(destination)) {
      if (!await cfg.confirmOverwrite(destination)) throw overwriteCancelled();
      this.path = destination;
      removeStaleParts(this.path);
    } else if (cfg.conflict === 'overwrite') this.path = destination;
    else this.path = uniquePath(this.folder, name);
    reserved.add(this.path);
    this.segs = [];
    if (this.kind === 'hls') return;
    if (this.ranged && this.size > MIN_SEG) {
      const n = Math.max(1, Math.min(this.conns, Math.floor(this.size / MIN_SEG)));
      const step = Math.ceil(this.size / n);
      for (let i = 0; i < n; i++)
        this.segs.push({ start: i * step, end: Math.min((i + 1) * step, this.size) - 1, done: 0, part: `${this.path}.idm${i}` });
    } else {
      this.segs.push({ start: 0, end: this.ranged && this.size ? this.size - 1 : null, done: 0, part: `${this.path}.idm0` });
    }
  }

  // ---------- run ----------
  async start() {
    if (this._running || this.status === 'complete') return;
    this._running = true; this._abort = false; this.status = 'connecting'; this.error = ''; this.force = false;
    try {
      while (this._active > 0) await sleep(50); // let stale workers of an aborted run exit
      this._live = 0;
      if (this.engine === 'yt-dlp') {
        await this._runYtDlp();
        if (this._abort) return;
        this.status = 'complete'; this.completed = Date.now(); this.speed = 0;
        reserved.delete(this.path);
        return;
      }
      if (!this.path) { if (!this.probed) await this._probe(); if (this._abort) return; await this._plan(); }
      let bytes;
      if (this.kind === 'hls') {
        this.hls.segs.forEach((s, i) => { if (s.done && !fs.existsSync(`${this.path}.idm${i}`)) s.done = false; });
        this.status = 'downloading'; this._last = [Date.now(), this.done];
        await this._runHls();
        if (this._abort) return;
        this.status = 'merging'; bytes = await this._merge(this.allParts());
      } else {
        for (const g of this.segs) {
          if (this.ranged && fs.existsSync(g.part)) g.done = Math.min(fs.statSync(g.part).size, g.end != null ? g.end - g.start + 1 : Infinity);
          else { g.done = 0; try { fs.unlinkSync(g.part); } catch {} }
        }
        this.status = 'downloading'; this._last = [Date.now(), this.done];
        const worker = async g => {
          this._active++;
          try { let cur = g; while (cur && !this._abort) { await this._seg(cur); if (this._abort) return; cur = this._steal(); } }
          finally { this._active--; }
        };
        await Promise.all(this.segs.slice().map(worker));
        if (this._abort) return;
        this.status = 'merging';
        bytes = await this._merge(this.segs.slice().sort((a, b) => a.start - b.start).map(g => g.part));
        if (this.ranged && this.size && bytes !== this.size) throw new Error(`Size mismatch (${bytes} of ${this.size})`);
      }
      this.size = bytes; this.segs = []; if (this.hls) this.hls.segs.forEach(s => { s.done = true; });
      this.status = 'complete'; this.completed = Date.now(); this.speed = 0; reserved.delete(this.path);
    } catch (e) {
      if (!this._abort) {
        this.status = e.code === 'DOWNLOAD_CANCELLED' ? 'cancelled' : 'error';
        this.error = this.status === 'error' ? e.message : '';
      }
      this._abort = true; this._stop();
    } finally { this._running = false; }
  }

  _runYtDlp(overwrite = false) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.folder, { recursive: true });
      if (this.autoFolder && cfg.folderFor) {
        const category = cfg.folderFor(this.name, this.baseFolder);
        this.folder = category.folder; this.category = category.category;
        fs.mkdirSync(this.folder, { recursive: true });
      } else this.category = this.category || categoryOf(this.name);
      const output = path.join(this.folder, '%(title).200B [%(id)s].%(ext)s');
      const args = [
        '--no-playlist', '--continue', overwrite ? '--force-overwrites' : '--no-overwrites', '--no-colors', '--newline',
        '--progress-template',
        'download:__IDM_PROGRESS__%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s',
        '--print', 'before_dl:__IDM_FILE_BEFORE__%(filepath)s',
        '--print', 'after_move:__IDM_FILE_AFTER__%(filepath)s',
        '-N', String(Math.max(1, Math.min(32, Number(this.conns) || 1))),
        '-o', output, this.url
      ];
      const limits = [this.speedLimitKB, cfg.ytDlpSpeedLimitKB].filter(value => value > 0);
      if (limits.length) args.unshift('--limit-rate', `${Math.floor(Math.min(...limits) * 1024)}B`);
      this.status = 'connecting'; this._last = [Date.now(), this.externalDone];
      let child;
      try { child = spawn(cfg.ytDlpPath || 'yt-dlp', args, { windowsHide: true }); }
      catch (e) { reject(e); return; }
      this._child = child;
      let pending = '', processError = null, collision = '';
      const consume = chunk => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith('__IDM_FILE_BEFORE__') || line.startsWith('__IDM_FILE_AFTER__')) {
            const beforeDownload = line.startsWith('__IDM_FILE_BEFORE__');
            const marker = beforeDownload ? '__IDM_FILE_BEFORE__' : '__IDM_FILE_AFTER__';
            this.path = line.slice(marker.length).trim();
            if (this.path) {
              this.name = path.basename(this.path);
              reserved.add(this.path);
              if (beforeDownload && !overwrite && !collision && fs.existsSync(this.path)) {
                collision = this.path;
                child.kill();
              }
            }
          } else if (line.startsWith('__IDM_PROGRESS__')) {
            const [done, size, speed] = line.slice('__IDM_PROGRESS__'.length).split('|').map(Number);
            if (Number.isFinite(done)) this.externalDone = done;
            if (Number.isFinite(size) && size > 0) this.size = size;
            if (Number.isFinite(speed) && speed >= 0) this.speed = speed;
            this.status = 'downloading';
          }
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', e => { processError = e; });
      child.once('close', async code => {
        if (this._child === child) this._child = null;
        if (this._abort) { resolve(); return; }
        if (collision) {
          try {
            if (!await cfg.confirmOverwrite(collision)) throw overwriteCancelled();
            await this._runYtDlp(true);
            resolve();
          } catch (e) { reject(e); }
        } else if (processError) {
          reject(processError.code === 'ENOENT'
            ? new Error('yt-dlp was not found. Install it or set its executable path in Options.')
            : processError);
        } else if (code !== 0) reject(new Error(`yt-dlp exited with code ${code}. Check the video URL and site support.`));
        else {
          if (pending.startsWith('__IDM_FILE_BEFORE__') || pending.startsWith('__IDM_FILE_AFTER__')) {
            const marker = pending.startsWith('__IDM_FILE_BEFORE__') ? '__IDM_FILE_BEFORE__' : '__IDM_FILE_AFTER__';
            this.path = pending.slice(marker.length).trim();
            if (this.path) { this.name = path.basename(this.path); reserved.add(this.path); }
          }
          if (this.path && fs.existsSync(this.path)) {
            this.size = fs.statSync(this.path).size;
            this.externalDone = this.size;
          }
          resolve();
        }
      });
    });
  }

  // Dynamic segmentation: an idle connection takes over half of the biggest remaining range.
  _steal() {
    if (!this.ranged) return null;
    let best = null, rem = 0;
    for (const g of this.segs) {
      if (g.end == null) continue;
      const r = g.end - (g.start + g.done) + 1;
      if (r > rem) { best = g; rem = r; }
    }
    if (!best || rem < 2 * MIN_SEG) return null;
    const mid = best.start + best.done + Math.floor(rem / 2);
    const ng = { start: mid, end: best.end, done: 0, part: `${this.path}.idm${this.segs.length}` };
    best.end = mid - 1; this.segs.push(ng);
    return ng;
  }

  async _seg(g) {
    let tries = 0, lastErr = '';
    while (!this._abort) {
      const pos = g.start + g.done;
      if (g.end != null && pos > g.end) return;
      const before = g.done;
      try { await this._fetch(g, pos); if (!this.ranged) return; }
      catch (e) { lastErr = e.message; }
      if (this._abort) return;
      if (g.done === before) {
        if (++tries > cfg.retries) throw new Error(lastErr || 'Connection failed');
        await sleep(1500);
      } else tries = 0;
    }
  }

  _fetch(g, pos) {
    return new Promise(async (resolve, reject) => {
      let r;
      try { r = await request(this.url, this, this.ranged ? { Range: `bytes=${pos}-${g.end}` } : {}); }
      catch (e) { return reject(e); }
      const { res, req } = r;
      this._reqs.add(req);
      if (this.ranged ? res.statusCode !== 206 : res.statusCode >= 400) {
        res.resume(); this._reqs.delete(req); return reject(new Error('HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(g.part, { flags: 'a' });
      let finished = false, settled = false;
      const end = err => {
        if (settled) return; settled = true;
        out.end(() => { this._reqs.delete(req); err ? reject(err) : resolve(); });
      };
      res.on('data', c => {
        if (finished) return;
        let chunk = c;
        if (g.end != null) {
          const remain = g.end - (g.start + g.done) + 1;
          if (chunk.length >= remain) { chunk = chunk.slice(0, Math.max(0, remain)); finished = true; }
        }
        if (chunk.length) { g.done += chunk.length; out.write(chunk); }
        if (finished) { res.pause(); req.destroy(); end(); return; }
        const d = Math.max(limiter.delay(c.length), this.limiter.delay(c.length));
        if (d) { res.pause(); setTimeout(() => res.resume(), d); }
      });
      res.on('end', () => end());
      res.on('error', e => end(e));
      res.on('close', () => { if (!res.complete) end(new Error('Connection closed')); });
    });
  }

  // ---------- HLS ----------
  async _runHls() {
    const segs = this.hls.segs; let next = 0;
    const worker = async () => {
      this._active++;
      try {
        while (!this._abort) {
          const i = next++; if (i >= segs.length) return;
          if (!segs[i].done) await this._hlsSeg(segs[i], i);
        }
      } finally { this._active--; }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.conns, segs.length)) }, worker));
    if (!this._abort && segs.some(s => !s.done)) throw new Error('Incomplete download');
  }

  async _hlsSeg(s, i) {
    let tries = 0;
    for (;;) {
      if (this._abort) return;
      try {
        const raw = await this._getBuf(s.u);
        const rawLen = raw.length;
        const buf = s.key ? await this._decrypt(raw, s) : raw;
        fs.writeFileSync(`${this.path}.idm${i}`, buf);
        s.bytes = rawLen; s.done = true; this._live -= rawLen;
        return;
      } catch (e) {
        if (this._abort) return;
        if (++tries > cfg.retries) throw e;
        await sleep(1500);
      }
    }
  }

  async _decrypt(buf, s) {
    if (!this._keys) this._keys = new Map();
    if (!this._keys.has(s.key.uri)) this._keys.set(s.key.uri, await this._getBuf(s.key.uri, true));
    const key = this._keys.get(s.key.uri);
    let iv;
    if (s.key.iv) iv = Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
    else { iv = Buffer.alloc(16); iv.writeUInt32BE(s.seq >>> 0, 12); }
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(buf), d.final()]);
  }

  async _getBuf(url, noCount) {
    const { res, req } = await request(url, this);
    this._reqs.add(req);
    if (res.statusCode >= 400) { res.resume(); this._reqs.delete(req); throw new Error('HTTP ' + res.statusCode); }
    let got = 0;
    try {
      return await new Promise((ok, bad) => {
        const ch = [];
        res.on('data', c => {
          ch.push(c); got += c.length; if (!noCount) this._live += c.length;
          const d = Math.max(limiter.delay(c.length), this.limiter.delay(c.length));
          if (d) { res.pause(); setTimeout(() => res.resume(), d); }
        });
        res.on('end', () => ok(Buffer.concat(ch)));
        res.on('error', bad);
        res.on('close', () => { if (!res.complete) bad(new Error('Connection closed')); });
      });
    } catch (e) { if (!noCount) this._live -= got; throw e; }
    finally { this._reqs.delete(req); }
  }

  async _merge(parts) {
    const out = fs.createWriteStream(this.path);
    let werr = null; out.on('error', e => { werr = e; });
    for (const p of parts) {
      await new Promise((ok, bad) => {
        const rs = fs.createReadStream(p);
        rs.once('error', bad); rs.once('end', ok); rs.pipe(out, { end: false });
      });
      if (werr) throw werr;
      fs.unlinkSync(p);
    }
    await new Promise(r => out.end(r));
    return out.bytesWritten;
  }

  // ---------- reporting ----------
  tickSpeed() {
    const now = Date.now(), [t0, b0] = this._last;
    if (now - t0 >= 500) { this.speed = Math.max(0, (this.done - b0) / ((now - t0) / 1000)); this._last = [now, this.done]; }
    if (this.status !== 'downloading') this.speed = 0;
  }

  snapshot() {
    let size = this.size, segs;
    if (this.kind === 'hls' && this.hls && this.status !== 'complete') {
      const hs = this.hls.segs, n = hs.length, dn = hs.filter(s => s.done);
      size = dn.length ? Math.round(dn.reduce((a, s) => a + s.bytes, 0) / dn.length * n) : 0;
      const bins = Math.min(24, n); segs = [];
      for (let b = 0; b < bins; b++) {
        const part = hs.slice(Math.floor(b * n / bins), Math.floor((b + 1) * n / bins));
        segs.push({ len: part.length, d: part.filter(s => s.done).length });
      }
    } else {
      segs = this.segs.slice().sort((a, b) => a.start - b.start).map(g => ({ len: g.end != null ? g.end - g.start + 1 : 0, d: g.done }));
    }
    const done = this.status === 'complete' ? this.size : Math.min(this.done, size || Infinity);
    return {
      id: this.id, name: this.path ? path.basename(this.path) : this.name, url: this.url, path: this.path,
      folder: this.folder, size, done, speed: this.speed, status: this.status, error: this.error, added: this.added,
      completed: this.completed, queue: this.queue, category: this.category || categoryOf(this.name), referer: this.referer,
      cookie: this.cookie, comment: this.comment, speedLimitKB: this.speedLimitKB, conns: this.conns, kind: this.kind,
      engine: this.engine,
      scheduleDays: this.scheduleDays,
      scheduleStartTime: this.scheduleStartTime,
      scheduleEndTime: this.scheduleEndTime,
      scheduleLastStartDay: this.scheduleLastStartDay,
      scheduleLastEndDay: this.scheduleLastEndDay,
      resumable: this.kind === 'hls' || this.ranged,
      eta: this.speed && size ? (size - done) / this.speed : null, segs
    };
  }
}

module.exports = { Download, limiter, cfg, request, readBody, fetchText };
