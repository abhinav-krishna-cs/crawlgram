// Reads crawl stats straight from Search Console's own page data — no Export,
// no CSV. GSC server-renders each report's data into the HTML as
//   AF_initDataCallback({key: 'ds:N', hash: '…', data: [...], sideChannel: {}});
// blocks. Verified against live GSC (Oct 2026):
//
//   data[0] = [propertyId, reportId, …]   reportId identifies the table:
//     45  daily chart   data[1][0] = [[utcMidnightMs, [requests, bytes, avgMs]], …]
//                        data[1][1] = [null, [totalRequests, totalBytes, avgMs]]
//     63  hosts          rows: host name inside row[0][0], requests at row[0][1][1]
//     64–67 breakdowns   rows: row[0][0] = [{"<field>": [..code at index i..]}], share at row[0][1][1]
//                        index 2 = response, 3 = file type, 4 = purpose, 5 = Googlebot type
//   Property list (home page): a block whose data[0] is [[propertyId, permission, …], …]
//
// Row labels are numeric codes; the label maps below were read off the live
// report tables. Unknown codes get a readable fallback.

const BLOCK_RE = /AF_initDataCallback\(\{key: 'ds:\d+'[\s\S]*?data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/g;
const PROPERTY_RE = /^(sc-domain:\S+|https?:\/\/\S+)$/;

export function extractBlocks(html) {
  const out = [];
  for (const m of html.matchAll(BLOCK_RE)) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip blocks we can't parse */ }
  }
  return out;
}

const LABELS = {
  response: {
    1: 'OK (200)', 2: 'Not found (404)', 4: 'Other client error (4XX)', 9: 'Server error (5XX)',
    10: 'DNS unresponsive', 11: 'robots.txt not available', 12: 'Page could not be reached',
    17: 'Moved permanently (301)', 18: 'Moved temporarily (302)', 20: 'Not modified (304)',
  },
  file_type: {
    1: 'HTML', 2: 'Image', 4: 'JavaScript', 5: 'CSS', 7: 'Other file type',
    9: 'Unknown (failed requests)', 11: 'JSON', 12: 'Syndication',
  },
  purpose: { 1: 'Discovery', 2: 'Refresh' },
  googlebot_type: { 1: 'Smartphone', 2: 'Desktop', 3: 'Image', 4: 'Video', 5: 'Page resource load', 6: 'Other agent type', 7: 'AdsBot' },
};
const DIM_BY_INDEX = { 2: 'response', 3: 'file_type', 4: 'purpose', 5: 'googlebot_type' };
const FALLBACK = { response: 'Other response', file_type: 'Other file type', purpose: 'Other purpose', googlebot_type: 'Other Googlebot' };

export class GscDataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// blocks: output of extractBlocks() for a Crawl stats page.
export function parseCrawlStats(blocks, expectedPropertyId) {
  const reports = blocks.filter((d) => Array.isArray(d?.[0]) && typeof d[0][0] === 'string' && typeof d[0][1] === 'number');
  if (!reports.length) {
    throw new GscDataError('no-data', 'Search Console returned no crawl stats. You may be signed out, or this property may not have a Crawl stats report (only root properties with Full or Owner access do).');
  }
  const propertyId = reports[0][0][0];
  // Guard against filing data under the wrong property.
  if (expectedPropertyId && propertyId !== expectedPropertyId) {
    throw new GscDataError('mismatch', `Search Console returned data for ${propertyId}, not ${expectedPropertyId}. Nothing was saved.`);
  }

  const daily = [];
  const breakdowns = [];
  const hosts = new Map();

  for (const d of reports) {
    const reportId = d[0][1];
    const body = d[1];
    if (!Array.isArray(body)) continue;

    if (reportId === 45) {
      for (const [ms, vals] of body[0] || []) {
        if (typeof ms !== 'number' || !Array.isArray(vals)) continue;
        daily.push({ date: new Date(ms).toISOString().slice(0, 10), requests: vals[0] ?? null, bytes: vals[1] ?? null, avgResponseMs: vals[2] ?? null });
      }
      continue;
    }

    const rows = body[0];
    if (!Array.isArray(rows)) continue;

    if (reportId === 63) {
      for (const r of rows) {
        const cell = r?.[0];
        const name = Array.isArray(cell?.[0]) ? cell[0].find((v) => typeof v === 'string' && /\./.test(v)) : null;
        const requests = cell?.[1]?.[1];
        if (name && Number.isInteger(requests)) hosts.set(name, Math.max(hosts.get(name) ?? 0, requests));
      }
      continue;
    }

    for (const r of rows) {
      const cell = r?.[0];
      const key = cell?.[0]?.[0];
      const share = cell?.[1]?.[1];
      if (!key || typeof key !== 'object' || typeof share !== 'number') continue;
      const arr = Object.values(key)[0];
      if (!Array.isArray(arr)) continue;
      const idx = arr.findIndex((v) => v != null);
      const dimension = DIM_BY_INDEX[idx];
      if (!dimension) continue;
      const code = arr[idx];
      breakdowns.push({ dimension, value: LABELS[dimension][code] ?? `${FALLBACK[dimension]} (code ${code})`, code, pct: share * 100, requests: null });
    }
  }

  if (!daily.length) throw new GscDataError('no-daily', 'The Crawl stats page loaded but its daily chart data was not found. Google may have changed the page – please report this.');

  const totalRequests = daily.reduce((t, d) => t + (d.requests ?? 0), 0);
  for (const [value, requests] of hosts) {
    breakdowns.push({ dimension: 'host', value, requests, pct: totalRequests ? (requests / totalRequests) * 100 : null });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));
  return { propertyId, daily, breakdowns };
}

// blocks: output of extractBlocks() for the Search Console home page.
// Rows look like [propertyId, type, ?, faviconUrl, url, domain]. Report blocks
// can also start with a property id, so take the longest list of full rows.
export function parsePropertyList(blocks) {
  let best = null;
  for (const d of blocks) {
    const list = d?.[0];
    if (!Array.isArray(list) || !list.length) continue;
    const ok = list.every((row) => Array.isArray(row) && row.length >= 4 && typeof row[0] === 'string' && PROPERTY_RE.test(row[0]));
    if (ok && (!best || list.length > best.length)) best = list;
  }
  return best ? best.map((row) => ({ id: row[0] })) : null;
}

export const crawlStatsPageUrl = (propertyId) =>
  `https://search.google.com/search-console/settings/crawl-stats?resource_id=${encodeURIComponent(propertyId)}&hl=en`;
export const GSC_HOME_DATA_URL = 'https://search.google.com/search-console?hl=en';
