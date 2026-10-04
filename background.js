// Service worker: reminders, property list, and backups read directly from
// Search Console's page data (no Export / CSV involved).
import { ingestSnapshot } from './lib/ingest.js';
import { get, getAll } from './lib/db.js';
import { extractBlocks, parseCrawlStats, parsePropertyList, crawlStatsPageUrl, GSC_HOME_DATA_URL, GscDataError } from './lib/gsc-data.js';
import { crawlStatsUrl, isRootProperty, labelFor, getSettings, DAY } from './lib/shared.js';

const CHECK_ALARM = 'crawlvault-check';
const NOTIFICATION_ID = 'crawlvault-due';
const RESULT_NOTIFICATION_ID = 'crawlvault-result';

// ---------- Scheduling ----------
// A frequent check alarm (instead of one long alarm) survives restarts and
// sleep: whenever Chrome is running we re-evaluate what is due.

async function ensureAlarm() {
  if (!(await chrome.alarms.get(CHECK_ALARM))) chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  listProperties().catch(() => {});
});
chrome.runtime.onStartup.addListener(async () => { await ensureAlarm(); checkDue(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === CHECK_ALARM) checkDue(); });

async function dueProperties() {
  const { intervalDays } = await getSettings();
  const props = await getAll('properties');
  return props.filter((p) => !p.lastExportAt || Date.now() - Date.parse(p.lastExportAt) >= intervalDays * DAY);
}

async function checkDue() {
  const settings = await getSettings();
  const due = await dueProperties();
  chrome.action.setBadgeText({ text: due.length ? String(due.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#E31E24' });
  if (!due.length || Date.now() < settings.snoozedUntil) return;

  if (settings.autoBackup) return backupMany(due.map((p) => p.id), 'scheduled', true);
  chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Back up your crawl stats',
    message: `${due.length} propert${due.length === 1 ? 'y is' : 'ies are'} due. Search Console only keeps 90 days.`,
    buttons: [{ title: 'Back up now' }, { title: 'Remind me tomorrow' }],
    requireInteraction: true,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id === NOTIFICATION_ID) backupMany((await dueProperties()).map((p) => p.id), 'reminder', true);
  if (id === RESULT_NOTIFICATION_ID) openDashboard();
});
chrome.notifications.onButtonClicked.addListener(async (id, btn) => {
  if (id !== NOTIFICATION_ID) return;
  if (btn === 0) return backupMany((await dueProperties()).map((p) => p.id), 'reminder', true);
  const settings = await getSettings();
  await chrome.storage.local.set({ settings: { ...settings, snoozedUntil: Date.now() + DAY } });
  chrome.notifications.clear(NOTIFICATION_ID);
});

// ---------- Reading Search Console ----------
// 1st choice: fetch from the service worker (extension has host permission,
// so the user's Google session cookies are sent).
// Fallback: ask an open search.google.com tab to fetch it (same-origin).

async function fetchGscHtml(url) {
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const html = await res.text();
    if (res.ok && html.includes('AF_initDataCallback')) return html;
  } catch { /* fall through to tab fetch */ }

  const tabs = await chrome.tabs.query({ url: 'https://search.google.com/*' });
  for (const tab of tabs) {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'fetchHtml', url }).catch(() => null);
    if (r?.html?.includes('AF_initDataCallback')) return r.html;
  }
  throw new GscDataError('signed-out', 'Could not read Search Console. Make sure you are signed in at search.google.com.');
}

async function listProperties() {
  const html = await fetchGscHtml(GSC_HOME_DATA_URL);
  const list = parsePropertyList(extractBlocks(html));
  if (!list) throw new GscDataError('no-properties', 'No properties found in your Search Console account.');
  const now = Date.now();
  const gscProperties = Object.fromEntries(list.map(({ id }) => [id, { id, label: labelFor(id), isRoot: isRootProperty(id), lastSeen: now }]));
  await chrome.storage.local.set({ gscProperties, propertiesFetchedAt: now });
  return list.length;
}

async function backupProperty(propertyId, source) {
  const html = await fetchGscHtml(crawlStatsPageUrl(propertyId));
  const snapshot = parseCrawlStats(extractBlocks(html), propertyId);
  const res = await ingestSnapshot({ propertyId, snapshot, source });
  return { propertyId, duplicate: res.duplicate, dailyCount: res.export.dailyCount, rangeStart: res.export.rangeStart, rangeEnd: res.export.rangeEnd };
}

// Backs up several properties one after another; progress is kept in
// storage so the popup / overlay can show it live.
let running = null;
async function backupMany(propertyIds, source, notify = false) {
  if (running) return running;
  running = (async () => {
    chrome.notifications.clear(NOTIFICATION_ID);
    const results = [];
    const progress = { running: true, total: propertyIds.length, done: 0, current: null, results, startedAt: Date.now() };
    for (const id of propertyIds) {
      progress.current = id;
      await chrome.storage.local.set({ backupRun: progress });
      try { results.push({ ok: true, ...(await backupProperty(id, source)) }); }
      catch (err) { results.push({ ok: false, propertyId: id, error: err.message, code: err.code }); }
      progress.done++;
    }
    progress.running = false; progress.current = null; progress.finishedAt = Date.now();
    await chrome.storage.local.set({ backupRun: progress });
    await checkDue();
    broadcast();
    if (notify && results.length) {
      const ok = results.filter((r) => r.ok).length;
      chrome.notifications.create(RESULT_NOTIFICATION_ID, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: ok === results.length ? 'Crawl stats backed up' : 'Some backups failed',
        message: results.map((r) => `${labelFor(r.propertyId)}: ${r.ok ? `${r.dailyCount} days saved` : r.error}`).join('\n').slice(0, 250),
      });
    }
    return results;
  })();
  try { return await running; } finally { running = null; }
}

function openDashboard(propertyId) {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${propertyId ? `?property=${encodeURIComponent(propertyId)}` : ''}`) });
}

// ---------- Messages (from the overlay, popup and dashboard) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'dataChanged') return; // broadcast, not for us
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: err.message, code: err.code }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'backup': {
      const results = await backupMany(msg.propertyIds, msg.source || 'manual');
      return { ok: results.every((r) => r.ok), results };
    }
    case 'listProperties':
      return { ok: true, count: await listProperties() };
    case 'getStatus': {
      const settings = await getSettings();
      const p = await get('properties', msg.propertyId);
      const daily = p ? await getAll('daily', 'propertyId', p.id) : [];
      const nextDueAt = p?.lastExportAt ? Date.parse(p.lastExportAt) + settings.intervalDays * DAY : null;
      return {
        ok: true, label: labelFor(msg.propertyId), tracked: !!p, lastExportAt: p?.lastExportAt ?? null,
        daysStored: daily.length, firstDate: daily.map((d) => d.date).sort()[0] ?? null,
        intervalDays: settings.intervalDays, nextDueAt, isDue: !p?.lastExportAt || nextDueAt <= Date.now(),
      };
    }
    case 'openDashboard':
      await openDashboard(msg.propertyId);
      return { ok: true };
    case 'openCrawlStats':
      await chrome.tabs.create({ url: crawlStatsUrl(msg.propertyId) });
      return { ok: true };
    case 'recheck':
      await checkDue();
      broadcast();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message ${msg.type}` };
  }
}

// Tell open extension pages and GSC tabs that stored data changed.
async function broadcast() {
  chrome.runtime.sendMessage({ type: 'dataChanged' }).catch(() => {});
  for (const tab of await chrome.tabs.query({ url: 'https://search.google.com/*' })) chrome.tabs.sendMessage(tab.id, { type: 'dataChanged' }).catch(() => {});
}
