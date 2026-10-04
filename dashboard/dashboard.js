import { getAll, deleteProperty, dumpAll, restoreAll } from '../lib/db.js';
import { ingestExport } from '../lib/ingest.js';
import { getSettings, DEFAULT_SETTINGS, DAY } from '../lib/shared.js';

const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DIM_LABELS = { response: 'By response', file_type: 'By file type', purpose: 'By purpose', googlebot_type: 'By Googlebot type', host: 'By host' };

if (params.get('view') === 'side') document.body.classList.add('is-side');

// range: { preset: '30' | '90' | '365' | 'all' } or { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
const state = { propertyId: params.get('property'), range: { preset: 'all' } };
let cache = null; // data for the selected property

// ---------- Settings ----------

async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  if (isExtension) { await chrome.storage.local.set({ settings: s }); send({ type: 'recheck' }); }
  else try { localStorage.setItem('settings', JSON.stringify(s)); } catch {}
}
function send(msg) {
  if (!isExtension) { flash('This action only works inside the installed extension.', true); return Promise.resolve(null); }
  return chrome.runtime.sendMessage(msg);
}

// ---------- Loading ----------

async function load() {
  const props = (await getAll('properties')).filter((p) => p.lastExportAt).sort((a, b) => a.label.localeCompare(b.label));
  const settings = { ...DEFAULT_SETTINGS, ...(await getSettings()) };
  $('#interval').value = settings.intervalDays;
  $('#auto-backup').checked = !!settings.autoBackup;
  renderPropList(props);

  const has = props.length > 0;
  $('#empty').hidden = has; $('#dash').hidden = !has; $('#property').hidden = !has; $('#backup-now').hidden = !has;
  if (!has) return;

  if (!props.some((p) => p.id === state.propertyId)) state.propertyId = props[0].id;
  $('#property').innerHTML = props.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  $('#property').value = state.propertyId;

  const prop = props.find((p) => p.id === state.propertyId);
  const [daily, exports, breakdowns] = await Promise.all([
    getAll('daily', 'propertyId', prop.id),
    getAll('exports', 'propertyId', prop.id),
    getAll('breakdowns', 'propertyId', prop.id),
  ]);
  daily.sort((a, b) => a.date.localeCompare(b.date));
  exports.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  cache = { prop, daily, exports, breakdowns, settings };

  $('#prop-kicker').textContent = prop.id.startsWith('sc-domain:') ? 'Domain property' : 'URL-prefix property';
  $('#prop-title').textContent = prop.label;
  const nextDue = Date.parse(prop.lastExportAt) + settings.intervalDays * DAY;
  $('#prop-meta').textContent = daily.length
    ? `${daily.length} days of crawl history · ${fmtDate(daily[0].date)} → ${fmtDate(daily.at(-1).date)} · last backup ${fmtDate(new Date(prop.lastExportAt))} · next ${nextDue <= Date.now() ? 'due now' : fmtDate(new Date(nextDue))}`
    : 'No crawl data yet.';

  renderRange();
}

// Everything below the property header depends on the selected date range.
function renderRange() {
  if (!cache) return;
  const { daily, exports, breakdowns } = cache;
  const { start, end } = resolveRange(daily);
  const rows = daily.filter((d) => d.date >= start && d.date <= end);
  const len = daysBetween(start, end) + 1;
  const prevEnd = addDays(start, -1), prevStart = addDays(start, -len);
  const prev = daily.filter((d) => d.date >= prevStart && d.date <= prevEnd);

  renderRangeControls(daily, start, end, rows.length, len);
  renderStats(rows, prev, len);
  lineChart($('#chart-requests'), rows, 'requests', fmtNum, start, end);
  lineChart($('#chart-bytes'), rows, 'bytes', fmtBytes, start, end);
  lineChart($('#chart-time'), rows, 'avgResponseMs', (v) => `${Math.round(v)} ms`, start, end);
  renderMonthly(daily, start, end);
  renderBreakdowns(exports, breakdowns, start, end);
  renderHistory(exports);
}

function resolveRange(daily) {
  const min = daily[0]?.date, max = daily.at(-1)?.date;
  if (!min) return { start: isoDate(new Date()), end: isoDate(new Date()) };
  const r = state.range;
  if (r.start && r.end) return { start: minStr(r.start, r.end), end: maxStr(r.start, r.end) };
  if (r.preset === 'all') return { start: min, end: max };
  return { start: maxStr(min, addDays(max, -(Number(r.preset) - 1))), end: max };
}

// ---------- Range controls ----------

function renderRangeControls(daily, start, end, daysWithData, len) {
  const min = daily[0]?.date, max = daily.at(-1)?.date;
  for (const id of ['#from', '#to']) { $(id).min = min; $(id).max = max; }
  $('#from').value = start; $('#to').value = end;

  $('#presets').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', state.range.preset === b.dataset.preset));

  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))].sort().reverse();
  $('#months').innerHTML = months.map((m) => {
    const [ms, me] = monthBounds(m);
    const active = start === ms && end === me;
    const have = daily.filter((d) => d.date.startsWith(m)).length;
    const total = daysBetween(ms, me) + 1;
    return `<button class="month ${active ? 'is-active' : ''}" data-month="${m}" title="${have} of ${total} days saved">
      ${monthName(m, 'short')}${have < total ? '<span class="month__partial" aria-label="partial month">◐</span>' : ''}</button>`;
  }).join('');

  const missing = len - daysWithData;
  $('#range-label').textContent = `Showing ${fmtDate(start)} – ${fmtDate(end)} · ${daysWithData} day${daysWithData === 1 ? '' : 's'} of data${missing > 0 ? ` (${missing} day${missing === 1 ? '' : 's'} not backed up)` : ''}`;
}

function setRange(range) { state.range = range; renderRange(); }

$('#presets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setRange({ preset: b.dataset.preset }); });
$('#months').addEventListener('click', (e) => {
  const b = e.target.closest('[data-month]'); if (!b) return;
  const [start, end] = monthBounds(b.dataset.month);
  setRange({ start, end });
});
for (const id of ['#from', '#to']) {
  $(id).addEventListener('change', () => { if ($('#from').value && $('#to').value) setRange({ start: $('#from').value, end: $('#to').value }); });
}

// ---------- Stats ----------

function summarize(rows) {
  const sum = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const requests = sum('requests');
  // GSC's average response time is per request, so weight each day by its requests.
  const weighted = rows.reduce((t, r) => t + (r.avgResponseMs ?? 0) * (r.requests ?? 0), 0);
  return { days: rows.length, requests, bytes: sum('bytes'), avgMs: requests ? weighted / requests : null, perDay: rows.length ? requests / rows.length : null };
}

function renderStats(rows, prevRows, len) {
  const cur = summarize(rows), prev = summarize(prevRows);
  const comparable = cur.days > 0 && prev.days >= cur.days * 0.8; // only compare against a mostly complete period
  const delta = (a, b, lowerIsBetter = false) => {
    if (!comparable || a == null || !b) return 'No earlier data to compare';
    const pct = ((a - b) / b) * 100;
    const good = lowerIsBetter ? pct < 0 : pct > 0;
    return `<span class="${Math.abs(pct) < 0.5 ? '' : good ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span> vs previous ${len} days`;
  };
  const tiles = [
    { label: 'Crawl requests', value: fmtNum(cur.requests), sub: delta(cur.requests, prev.requests) },
    { label: 'Requests per day', value: fmtNum(cur.perDay), sub: delta(cur.perDay, prev.perDay) },
    { label: 'Download size', value: fmtBytes(cur.bytes), sub: delta(cur.bytes, prev.bytes) },
    { label: 'Avg response time', value: cur.avgMs == null ? '–' : `${Math.round(cur.avgMs)} ms`, sub: delta(cur.avgMs, prev.avgMs, true) },
  ];
  $('#stats').innerHTML = tiles.map((t) => `
    <div class="stat"><div class="stat__label">${t.label}</div><div class="stat__value">${t.value}</div><div class="stat__sub">${t.sub}</div></div>`).join('');
}

// ---------- Monthly table ----------

function renderMonthly(daily, start, end) {
  const months = [...new Set(daily.map((d) => d.date.slice(0, 7)))].sort().reverse();
  const sums = months.map((m) => ({ m, ...summarize(daily.filter((d) => d.date.startsWith(m))) }));
  $('#monthly').innerHTML = `<thead><tr><th>Month</th><th class="num">Days saved</th><th class="num">Crawl requests</th><th class="num">Per day</th><th class="num">Δ per day</th><th class="num">Download size</th><th class="num">Avg response</th></tr></thead><tbody>` +
    sums.map((s, i) => {
      const [ms, me] = monthBounds(s.m);
      const older = sums[i + 1];
      const d = older?.perDay ? ((s.perDay - older.perDay) / older.perDay) * 100 : null;
      const active = start === ms && end === me;
      return `<tr data-month="${s.m}" class="${active ? 'is-active' : ''}" tabindex="0">
        <td>${monthName(s.m, 'long')}</td>
        <td class="num">${s.days} / ${daysBetween(ms, me) + 1}</td>
        <td class="num">${fmtNum(s.requests)}</td>
        <td class="num">${fmtNum(s.perDay)}</td>
        <td class="num">${d == null ? '–' : `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span>`}</td>
        <td class="num">${fmtBytes(s.bytes)}</td>
        <td class="num">${s.avgMs == null ? '–' : `${Math.round(s.avgMs)} ms`}</td></tr>`;
    }).join('') + '</tbody>';
}
$('#monthly').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-month]'); if (!tr) return;
  const [start, end] = monthBounds(tr.dataset.month);
  setRange({ start, end });
  $('.rangebar').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#monthly').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('tr[data-month]')?.click(); });

// ---------- Breakdowns ----------
// Google only gives breakdowns as 90-day totals, so we show the backup whose
// 90-day window overlaps the selected range the most.

function renderBreakdowns(exports, breakdowns, start, end) {
  const withBd = exports.filter((e) => e.breakdownCount > 0 && e.rangeStart);
  const overlap = (e) => Math.max(0, daysBetween(maxStr(e.rangeStart, start), minStr(e.rangeEnd, end)) + 1);
  const best = [...withBd].sort((a, b) => overlap(b) - overlap(a) || b.capturedAt.localeCompare(a.capturedAt))[0];
  if (!best || overlap(best) === 0) {
    $('#breakdowns').innerHTML = '<p class="meta">No backup covers this date range.</p>';
    $('#bd-meta').textContent = '';
    return;
  }
  const previous = withBd.filter((e) => e.rangeEnd < best.rangeEnd).sort((a, b) => b.rangeEnd.localeCompare(a.rangeEnd))[0];
  $('#bd-meta').textContent = `90-day totals for ${fmtDate(best.rangeStart)} – ${fmtDate(best.rangeEnd)}${previous ? ` · Δ vs ${fmtDate(previous.rangeStart)} – ${fmtDate(previous.rangeEnd)}` : ''}`;

  const cur = breakdowns.filter((b) => b.exportId === best.id);
  const prevMap = new Map(breakdowns.filter((b) => previous && b.exportId === previous.id).map((b) => [`${b.dimension}|${b.value}`, b]));
  const dims = Object.keys(DIM_LABELS).filter((d) => cur.some((b) => b.dimension === d));

  $('#breakdowns').innerHTML = dims.map((dim) => {
    const rows = cur.filter((b) => b.dimension === dim).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    const hasReq = rows.some((r) => r.requests != null);
    const body = rows.map((r) => {
      const p = prevMap.get(`${dim}|${r.value}`);
      const d = r.pct != null && p?.pct != null ? r.pct - p.pct : null;
      return `<tr><td>${esc(r.value)}</td>
        <td class="num">${r.pct != null ? `<span class="bar" style="width:${Math.max(2, r.pct * 0.6)}px"></span>${fmtPct(r.pct)}` : '–'}</td>
        ${hasReq ? `<td class="num">${fmtNum(r.requests)}</td>` : ''}
        <td class="num meta">${d == null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(1)} pts`}</td></tr>`;
    }).join('');
    return `<div class="card table-wrap"><h3>${DIM_LABELS[dim]}</h3><table class="table">
      <thead><tr><th>${DIM_LABELS[dim].replace('By ', '')}</th><th class="num">Share</th>${hasReq ? '<th class="num">Requests</th>' : ''}<th class="num">Δ</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }).join('');
}

function renderHistory(exports) {
  $('#history').innerHTML = `<thead><tr><th>Backed up</th><th>Data range</th><th class="num">Days</th><th>Source</th></tr></thead><tbody>` +
    exports.map((e) => `<tr>
      <td>${new Date(e.capturedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${e.rangeStart ? `${fmtDate(e.rangeStart)} → ${fmtDate(e.rangeEnd)}` : '–'}</td>
      <td class="num">${e.dailyCount}</td>
      <td><span class="tag">${esc(e.source)}</span></td>
    </tr>`).join('') + '</tbody>';
}

function renderPropList(props) {
  $('#prop-list').innerHTML = props.map((p) => `<li><span>${esc(p.id)}</span>
    <span class="btn-row" style="margin:0"><button class="btn btn--outline btn--sm" data-save="${esc(p.id)}">Back up</button>
    <button class="btn btn--outline btn--sm" data-remove="${esc(p.id)}">Remove</button></span></li>`).join('') || '<li class="meta">No properties backed up yet.</li>';
}

// ---------- SVG line chart ----------

function lineChart(fig, rows, key, fmt, start, end) {
  fig.querySelector('svg')?.remove();
  fig.querySelector('.meta')?.remove();
  const pts = rows.filter((r) => r[key] != null).map((r) => ({ t: Date.parse(`${r.date}T00:00:00Z`), v: r[key], date: r.date }));
  if (pts.length < 2) { fig.insertAdjacentHTML('beforeend', '<p class="meta">Not enough data in this range.</p>'); return; }

  const W = 1000, H = 220, L = 56, R = 8, T = 8, B = 24;
  const t0 = Date.parse(`${start}T00:00:00Z`), t1 = Date.parse(`${end}T00:00:00Z`);
  const max = niceMax(Math.max(...pts.map((p) => p.v)));
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  let d = '', gaps = '';
  pts.forEach((p, i) => {
    const gap = i > 0 && p.t - pts[i - 1].t > 1.5 * DAY;
    if (gap) gaps += `<rect class="gap" x="${x(pts[i - 1].t)}" y="${T}" width="${x(p.t) - x(pts[i - 1].t)}" height="${H - T - B}"><title>Not backed up</title></rect>`;
    d += `${i === 0 || gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
  });

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const xTicks = timeTicks(t0, t1);
  fig.insertAdjacentHTML('beforeend', `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fig.querySelector('figcaption').textContent)} over time">
      <g class="grid">${yTicks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}</g>
      ${gaps}
      <g class="axis">${yTicks.map((v) => `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
        ${xTicks.map(([t, label]) => `<text x="${x(t)}" y="${H - 4}" text-anchor="middle">${label}</text>`).join('')}</g>
      <path class="line" d="${d}"/>
      <line class="hover-line" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <circle class="hover-dot" r="4" visibility="hidden"/>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" class="hit"/>
    </svg>`);

  const svg = fig.querySelector('svg'), tip = $('#tooltip');
  const hl = svg.querySelector('.hover-line'), dot = svg.querySelector('.hover-dot');
  svg.querySelector('.hit').addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (t1 - t0);
    const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    hl.setAttribute('x1', x(p.t)); hl.setAttribute('x2', x(p.t)); dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v));
    hl.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.textContent = `${fmtDate(p.date)} · ${fmt(p.v)}`;
    tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`; tip.style.top = `${e.clientY - 36}px`;
  });
  svg.querySelector('.hit').addEventListener('mouseleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) * p;
}
// Day ticks for short ranges, month ticks for long ones.
function timeTicks(t0, t1) {
  const days = (t1 - t0) / DAY, out = [];
  if (days <= 62) {
    const step = Math.max(1, Math.ceil(days / 8));
    for (let t = t0; t <= t1; t += step * DAY) out.push([t, new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })]);
    return out;
  }
  const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const step = Math.max(1, Math.ceil(days / 30 / 8));
  for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + step)) out.push([d.getTime(), d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' })]);
  return out;
}

// ---------- Dates & formatting (dates are 'YYYY-MM-DD' strings, UTC) ----------

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => isoDate(new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const minStr = (a, b) => (a < b ? a : b);
const maxStr = (a, b) => (a > b ? a : b);
function monthBounds(m) {
  const [y, mo] = m.split('-').map(Number);
  return [`${m}-01`, isoDate(new Date(Date.UTC(y, mo, 0)))];
}
const monthName = (m, month) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month, year: 'numeric' });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null ? '–' : Math.round(n).toLocaleString());
const fmtPct = (p) => (p > 0 && p < 1 ? '< 1%' : `${p.toFixed(1)}%`);
function fmtBytes(b) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDate(d) {
  const date = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let flashTimer;
function flash(text, isError = false) {
  const el = $('#flash');
  el.textContent = text; el.hidden = false; el.classList.toggle('is-error', isError);
  clearTimeout(flashTimer); flashTimer = setTimeout(() => (el.hidden = true), isError ? 10000 : 5000);
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Actions ----------

async function backup(ids) {
  flash('Backing up from Search Console…');
  const res = await send({ type: 'backup', propertyIds: ids, source: 'dashboard' });
  if (!res) return;
  const failed = res.results.filter((r) => !r.ok);
  flash(failed.length ? `Backup failed: ${failed.map((r) => r.error).join(' ')}` : res.results.map((r) => (r.duplicate ? 'Already up to date.' : `Saved ${r.dailyCount} days.`)).join(' '), failed.length > 0);
  load();
}

$('#property').addEventListener('change', (e) => { state.propertyId = e.target.value; load(); });
$('#backup-now').addEventListener('click', () => backup([state.propertyId]));
$('#prop-list').addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save]'), rem = e.target.closest('[data-remove]');
  if (save) backup([save.dataset.save]);
  if (rem && confirm(`Remove ${rem.dataset.remove} and all its saved crawl data from this browser?`)) {
    await deleteProperty(rem.dataset.remove); flash('Property removed.'); load();
  }
});
$('#interval').addEventListener('change', (e) => saveSettings({ intervalDays: Math.min(85, Math.max(1, Number(e.target.value) || 21)) }));
$('#auto-backup').addEventListener('change', (e) => saveSettings({ autoBackup: e.target.checked }));

$('#import-btn').addEventListener('click', () => $('#import-file').click());
$('#restore-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  for (const file of e.target.files) await importFile(file);
  e.target.value = '';
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) await importFile(f); });

// Manual import: a CSV/zip exported from GSC, or a CrawlVault JSON backup.
async function importFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.json$/i.test(file.name)) {
      await restoreAll(JSON.parse(new TextDecoder().decode(bytes)));
      flash('Backup restored.');
    } else {
      const pid = normalizeProperty(prompt('Which Search Console property is this export for? (e.g. sc-domain:example.com)', state.propertyId || '') || '');
      if (!pid) return;
      const res = await ingestExport({ propertyId: pid, fileName: file.name, bytes, source: 'csv-import' });
      state.propertyId = pid;
      flash(res.duplicate ? `${file.name} was already imported.` : `Imported ${res.export.dailyCount} days from ${file.name}.`);
    }
    if (isExtension) send({ type: 'recheck' });
    load();
  } catch (err) {
    flash(`Import failed: ${err.message}`, true);
  }
}
function normalizeProperty(v) {
  v = v.trim();
  if (!v) return null;
  if (/^sc-domain:/i.test(v)) return `sc-domain:${v.slice(10).toLowerCase()}`;
  if (/^https?:\/\//i.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return `sc-domain:${v.replace(/\/.*$/, '').toLowerCase()}`;
}

$('#dl-backup').addEventListener('click', async () => download(`crawlvault-backup-${isoDate(new Date())}.json`, JSON.stringify(await dumpAll()), 'application/json'));
$('#dl-csv').addEventListener('click', () => {
  if (!cache) return flash('No property selected.', true);
  const { start, end } = resolveRange(cache.daily);
  const rows = cache.daily.filter((d) => d.date >= start && d.date <= end);
  const csv = ['date,total_crawl_requests,total_download_bytes,avg_response_ms', ...rows.map((r) => [r.date, r.requests ?? '', r.bytes ?? '', r.avgResponseMs ?? ''].join(','))].join('\n');
  download(`crawl-stats-${cache.prop.label.replace(/[^a-z0-9.-]+/gi, '_')}-${start}-to-${end}.csv`, csv, 'text/csv');
});

if (isExtension) chrome.runtime.onMessage.addListener((m) => { if (m.type === 'dataChanged') load(); });
window.__crawlvault = { load, setRange };
load();
