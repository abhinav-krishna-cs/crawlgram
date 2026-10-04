// Constants and helpers shared by the background worker, popup and dashboard.

export const DAY = 24 * 60 * 60 * 1000;
export const GSC_HOME = 'https://search.google.com/search-console';
// autoBackup: when a backup is due, save silently instead of asking first.
export const DEFAULT_SETTINGS = { intervalDays: 21, autoBackup: false, snoozedUntil: 0 };

export const crawlStatsUrl = (propertyId) =>
  `https://search.google.com/search-console/settings/crawl-stats?resource_id=${encodeURIComponent(propertyId)}`;

export function labelFor(propertyId) {
  return propertyId.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// GSC only offers the Crawl stats report for root-level properties:
// domain properties and URL-prefix properties without a path.
export function isRootProperty(id) {
  if (id.startsWith('sc-domain:')) return true;
  try { return new URL(id).pathname === '/'; } catch { return false; }
}

export async function getSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
  }
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}
