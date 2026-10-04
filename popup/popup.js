// Toolbar popup: pick a Search Console property, back it up, browse saved sites.
import { getAll } from '../lib/db.js';
import { DAY, GSC_HOME, isRootProperty, labelFor, getSettings } from '../lib/shared.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
let windowId = null;
let selectedId = null;
let listError = null;

chrome.windows?.getCurrent().then((w) => (windowId = w.id)).catch(() => {});

async function load() {
  const [{ gscProperties = {}, propertiesFetchedAt = 0, popupSelected, backupRun }, tracked, settings] = await Promise.all([
    chrome.storage.local.get(['gscProperties', 'propertiesFetchedAt', 'popupSelected', 'backupRun']),
    getAll('properties'),
    getSettings(),
  ]);

  // Everything we know about: the GSC account's properties + anything already backed up.
  const all = new Map(Object.values(gscProperties).map((p) => [p.id, p]));
  for (const t of tracked) if (!all.has(t.id)) all.set(t.id, { id: t.id, label: t.label, isRoot: isRootProperty(t.id) });
  const roots = [...all.values()].filter((p) => p.isRoot).sort((a, b) => a.label.localeCompare(b.label));
  const trackedById = new Map(tracked.map((t) => [t.id, t]));

  renderListStatus(roots, propertiesFetchedAt);
  renderSelect(roots, trackedById, popupSelected);
  await renderSelected(trackedById, settings, backupRun);
  renderSaved(tracked, settings, backupRun);
  return propertiesFetchedAt;
}

async function refreshList() {
  listError = null;
  $('#list-status').className = 'p-note p-note--box';
  $('#list-status').textContent = 'Loading your properties from Search Console…';
  const res = await send({ type: 'listProperties' }).catch((e) => ({ ok: false, error: e.message }));
  if (!res?.ok) listError = res?.error || 'Could not load properties.';
  load();
}

function renderListStatus(roots, fetchedAt) {
  const el = $('#list-status');
  el.className = 'p-note';
  el.textContent = '';
  if (listError) {
    el.classList.add('p-note--box', 'p-note--err');
    el.innerHTML = `${esc(listError)} <button class="link-btn" id="sign-in">Open Search Console</button>`;
    $('#sign-in').onclick = () => chrome.tabs.create({ url: GSC_HOME });
  } else if (!roots.length && !fetchedAt) {
    el.classList.add('p-note--box');
    el.textContent = 'Loading your properties from Search Console…';
  }
}

function renderSelect(roots, trackedById, remembered) {
  const sel = $('#prop-select');
  const domain = roots.filter((p) => p.id.startsWith('sc-domain:'));
  const prefix = roots.filter((p) => !p.id.startsWith('sc-domain:'));
  const opt = (p) => `<option value="${esc(p.id)}">${esc(p.label)}${trackedById.get(p.id)?.lastExportAt ? '' : ' · not backed up'}</option>`;
  sel.innerHTML = '<option value="">Select a property…</option>'
    + (domain.length ? `<optgroup label="Domain properties">${domain.map(opt).join('')}</optgroup>` : '')
    + (prefix.length ? `<optgroup label="URL-prefix properties">${prefix.map(opt).join('')}</optgroup>` : '');
  selectedId = [selectedId, remembered].find((id) => id && roots.some((p) => p.id === id)) || (roots.length === 1 ? roots[0].id : '');
  sel.value = selectedId || '';
}

async function renderSelected(trackedById, settings, run) {
  $('#interval-days').textContent = settings.intervalDays;
  $('#selected').hidden = !selectedId;
  if (!selectedId) return;

  const t = trackedById.get(selectedId);
  const daily = (await getAll('daily', 'propertyId', selectedId)).sort((a, b) => a.date.localeCompare(b.date));
  const nextDue = t?.lastExportAt ? Date.parse(t.lastExportAt) + settings.intervalDays * DAY : null;
  const due = !t?.lastExportAt || nextDue <= Date.now();

  $('#sel-label').textContent = labelFor(selectedId);
  $('#sel-meta').textContent = t?.lastExportAt
    ? `${daily.length} days stored (${fmtShort(daily[0]?.date)} – ${fmtShort(daily.at(-1)?.date)}) · last backup ${rel(t.lastExportAt)}`
    : 'Not backed up yet';
  $('#sel-tag').innerHTML = due ? '<span class="tag tag--accent">Backup due</span>' : `<span class="tag">Next ${fmtShort(nextDue)}</span>`;
  $('#view').hidden = !daily.length;
  sparkline($('#sel-spark'), daily);

  // Live backup progress / last result for this property.
  const status = $('#run-status');
  const mine = run?.results?.find((r) => r.propertyId === selectedId);
  status.className = 'p-note';
  status.textContent = '';
  $('#backup').disabled = !!run?.running;
  $('#backup').textContent = run?.running ? `Backing up… (${run.done}/${run.total})` : 'Back up crawl stats';
  if (run?.running && run.current === selectedId) {
    status.classList.add('p-note--box');
    status.textContent = 'Reading crawl stats from Search Console…';
  } else if (mine && Date.now() - (run.finishedAt || 0) < 60000) {
    status.classList.add('p-note--box');
    if (!mine.ok) { status.classList.add('p-note--err'); status.textContent = mine.error; }
    else status.textContent = mine.duplicate ? 'Already up to date – nothing new since the last backup.' : `Saved ${mine.dailyCount} days (${fmtShort(mine.rangeStart)} – ${fmtShort(mine.rangeEnd)}).`;
  }
}

function renderSaved(tracked, settings, run) {
  const list = tracked.filter((t) => t.lastExportAt).sort((a, b) => a.label.localeCompare(b.label));
  const due = list.filter((t) => Date.now() - Date.parse(t.lastExportAt) >= settings.intervalDays * DAY);
  const btn = $('#backup-all');
  btn.hidden = !list.length || run?.running;
  btn.textContent = due.length ? `Back up ${due.length} due` : `Back up all ${list.length}`;
  btn.onclick = () => startBackup((due.length ? due : list).map((t) => t.id));

  $('#saved').innerHTML = list.length ? list.map((t) => {
    const isDue = due.includes(t);
    return `<li>
      <button class="p-saved__row" data-toggle="${esc(t.id)}" aria-expanded="false">
        <span><span class="p-saved__name">${esc(t.label)}</span><span class="p-saved__meta">Last backup ${rel(t.lastExportAt)}</span></span>
        ${isDue ? '<span class="tag tag--accent">Due</span>' : '<span class="tag">Saved</span>'}
      </button>
      <div class="p-saved__open" hidden>
        <button class="btn btn--primary btn--sm" data-tab="${esc(t.id)}">Open in new tab</button>
        <button class="btn btn--outline btn--sm" data-side="${esc(t.id)}">Side panel</button>
      </div></li>`;
  }).join('') : '<li class="p-empty">Nothing saved yet. Back up a property to start your history.</li>';
}

// ---------- Actions ----------

async function startBackup(ids) {
  if (!ids.length) return;
  send({ type: 'backup', propertyIds: ids, source: 'popup' }); // progress arrives via storage
}

$('#prop-select').addEventListener('change', async (e) => {
  selectedId = e.target.value;
  await chrome.storage.local.set({ popupSelected: selectedId });
  load();
});
$('#backup').addEventListener('click', () => startBackup([selectedId]));
$('#view').addEventListener('click', () => openTab(selectedId));
$('#open-tab').addEventListener('click', () => openTab(selectedId));
$('#open-side').addEventListener('click', () => openSide(selectedId));
$('#refresh-list').addEventListener('click', refreshList);

$('#saved').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const open = toggle.nextElementSibling;
    open.hidden = !open.hidden;
    toggle.setAttribute('aria-expanded', String(!open.hidden));
  }
  const tab = e.target.closest('[data-tab]'), side = e.target.closest('[data-side]');
  if (tab) openTab(tab.dataset.tab);
  if (side) openSide(side.dataset.side);
});

function dashboardUrl(id, view) {
  const q = new URLSearchParams();
  if (id) q.set('property', id);
  if (view) q.set('view', view);
  return `dashboard/dashboard.html${q.size ? `?${q}` : ''}`;
}
function openTab(id) { chrome.tabs.create({ url: chrome.runtime.getURL(dashboardUrl(id)) }); window.close(); }
function openSide(id) {
  // sidePanel.open must run synchronously inside the click (user gesture).
  chrome.sidePanel.setOptions({ path: dashboardUrl(id, 'side') });
  chrome.sidePanel.open({ windowId }).then(() => window.close()).catch(() => openTab(id));
}

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes) => { if (changes.gscProperties || changes.backupRun) load(); });
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'dataChanged') load(); });

// ---------- Helpers ----------

function sparkline(svg, daily) {
  const pts = daily.slice(-90).filter((d) => d.requests != null);
  if (pts.length < 2) { svg.innerHTML = '<text x="0" y="28">Crawl requests chart appears after the first backup</text>'; return; }
  const max = Math.max(...pts.map((p) => p.requests)) || 1;
  const xy = pts.map((p, i) => `${(i / (pts.length - 1)) * 300},${44 - (p.requests / max) * 40}`).join(' ');
  svg.innerHTML = `<line x1="0" x2="300" y1="44" y2="44"/><polyline points="${xy}"/>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function rel(iso) {
  const d = Math.floor((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
function fmtShort(v) {
  if (!v) return '–';
  const d = typeof v === 'string' ? new Date(`${v}T00:00:00`) : new Date(v);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Load, and refresh the property list from GSC once a day.
load().then((fetchedAt) => { if (Date.now() - fetchedAt > DAY) refreshList(); });
