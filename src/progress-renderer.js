const list = document.querySelector('#list');
const connectionList = document.querySelector('#connectionList');
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtSize = n => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(2) : n.toFixed(0)} ${units[i]}`;
};
const fmtDate = value => new Date(value).toLocaleString();
const escapeText = value => String(value == null ? '' : value);

function render(items) {
  if (!items.length) {
    list.innerHTML = '<div class="empty">No downloads selected.</div>';
    return;
  }
  list.replaceChildren(...items.map(item => {
    const row = document.createElement('section');
    row.className = 'item';
    const percent = item.status === 'complete' ? 100 : item.size ? Math.min(100, item.done / item.size * 100) : 0;
    const isScheduled = item.scheduleDays && item.scheduleDays.length;
    const label = item.status === 'error' ? `Error: ${item.error}`
      : isScheduled ? `${item.scheduleDays.length === 7 ? 'Every day' : item.scheduleDays.map(day => days[day]).join(', ')} at ${item.scheduleStartTime}${item.scheduleEndTime ? ` – ends ${item.scheduleEndTime}` : ''}`
      : item.status[0].toUpperCase() + item.status.slice(1);
    const amount = item.size ? `${fmtSize(item.done)} of ${fmtSize(item.size)}` : fmtSize(item.done);

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = escapeText(item.name); name.title = escapeText(item.name);
    const status = document.createElement('span');
    status.className = `status ${item.status}`; status.textContent = label;
    top.append(name, status);

    const bar = document.createElement('div');
    bar.className = `bar ${item.status}`;
    const fill = document.createElement('i'); fill.style.width = `${percent}%`;
    const text = document.createElement('em'); text.textContent = item.size ? `${percent.toFixed(1)}%` : amount;
    bar.append(fill, text);

    const bottom = document.createElement('div');
    bottom.className = 'bottom';
    const downloaded = document.createElement('span'); downloaded.textContent = amount;
    const speed = document.createElement('span'); speed.textContent = item.speed ? `${fmtSize(item.speed)}/s` : '';
    const actions = document.createElement('div'); actions.className = 'actions';
    const canStart = item.status !== 'complete' && item.status !== 'connecting' && item.status !== 'downloading' && item.status !== 'merging';
    const start = document.createElement('button');
    start.textContent = ['paused', 'error'].includes(item.status) ? 'Resume' : 'Start';
    start.disabled = !canStart;
    start.addEventListener('click', () => progressApi.act([item.id], 'resume'));
    const pause = document.createElement('button');
    pause.textContent = 'Pause';
    pause.disabled = !['connecting', 'downloading', 'merging'].includes(item.status);
    pause.addEventListener('click', () => progressApi.act([item.id], 'pause'));
    actions.append(start, pause);
    bottom.append(downloaded, speed, actions);

    row.append(top, bar, bottom);
    return row;
  }));
}

function renderConnections({ items, speed, maxActive, speedLimitKB }) {
  document.querySelector('#totalSpeed').textContent = `${fmtSize(speed)}/s`;
  document.querySelector('#maxActive').textContent = String(maxActive);
  document.querySelector('#speedLimit').textContent = speedLimitKB ? `${fmtSize(speedLimitKB * 1024)}/s` : 'Unlimited';
  const setIfNotFocused = (id, value) => {
    const input = document.querySelector(id);
    if (document.activeElement !== input) input.value = value;
  };
  setIfNotFocused('#maxActiveInput', maxActive);
  setIfNotFocused('#globalSpeedInput', speedLimitKB);
  document.querySelector('#downloadConnsInput').disabled = !items.some(item => item.status !== 'complete');
  document.querySelector('#downloadSpeedInput').disabled = !items.some(item => item.status !== 'complete');
  if (items.length) {
    setIfNotFocused('#downloadConnsInput', items[0].conns);
    setIfNotFocused('#downloadSpeedInput', items[0].speedLimitKB);
  }
  if (!items.length) {
    connectionList.innerHTML = '<div class="empty">No downloads selected.</div>';
    return;
  }
  connectionList.replaceChildren(...items.map(item => {
    const row = document.createElement('div');
    row.className = 'conn-row';
    const name = document.createElement('span');
    name.textContent = item.name; name.title = item.name;
    const itemSpeed = document.createElement('span');
    itemSpeed.textContent = `${fmtSize(item.speed)}/s`;
    const connections = document.createElement('span');
    connections.textContent = `${item.conns} per download`;
    row.append(name, itemSpeed, connections);
    return row;
  }));
}

document.querySelector('#saveConnectionSettings').addEventListener('click', async () => {
  const error = document.querySelector('#settingsError');
  error.textContent = '';
  const maxActive = Number(document.querySelector('#maxActiveInput').value);
  const speedLimitKB = Number(document.querySelector('#globalSpeedInput').value);
  const conns = Number(document.querySelector('#downloadConnsInput').value);
  const downloadSpeedLimitKB = Number(document.querySelector('#downloadSpeedInput').value);
  const hasTargets = latestItems.some(item => item.status !== 'complete');
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 20 || !Number.isFinite(speedLimitKB) || speedLimitKB < 0) {
    error.textContent = 'Use 1–20 simultaneous downloads and a non-negative global speed limit.';
    return;
  }
  if (hasTargets && (!Number.isInteger(conns) || conns < 1 || conns > 32 ||
    !Number.isFinite(downloadSpeedLimitKB) || downloadSpeedLimitKB < 0)) {
    error.textContent = 'Use 1–32 connections per download and a non-negative per-download speed limit.';
    return;
  }
  try {
    await progressApi.configure({
      ids: latestItems.map(item => item.id),
      maxActive, speedLimitKB, conns, downloadSpeedLimitKB
    });
    error.textContent = 'Options applied.';
  } catch (e) {
    error.textContent = e.message || String(e);
  }
});

let latestItems = [];
document.querySelector('#tabProgress').addEventListener('click', () => setTab('progress'));
document.querySelector('#tabConnections').addEventListener('click', () => setTab('connections'));
function setTab(tab) {
  const progress = tab === 'progress';
  document.querySelector('#tabProgress').classList.toggle('active', progress);
  document.querySelector('#tabConnections').classList.toggle('active', !progress);
  document.querySelector('#tabProgress').setAttribute('aria-selected', String(progress));
  document.querySelector('#tabConnections').setAttribute('aria-selected', String(!progress));
  document.querySelector('#progressPane').classList.toggle('active', progress);
  document.querySelector('#connectionsPane').classList.toggle('active', !progress);
}

progressApi.onUpdate(data => {
  latestItems = data.items;
  render(data.items);
  renderConnections(data);
});
