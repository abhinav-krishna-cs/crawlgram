// Turns a GSC Crawl Stats export (zip of CSVs, or a single CSV) into rows.
//
// GSC's exact file names / column headers are not documented and vary by UI
// language, so detection is heuristic: a table with a date column is the daily
// "over time" chart; anything else is a breakdown (response, file type, purpose,
// Googlebot type, host). Raw files are always stored too, so they can be
// re-parsed if the heuristics need fixing later.

import { parseCSV } from './csv.js';
import { isZip, unzip } from './zip.js';

export const DIMENSIONS = ['response', 'file_type', 'purpose', 'googlebot_type', 'host'];

export async function readExportFiles(name, bytes) {
  if (isZip(bytes)) {
    const files = await unzip(bytes);
    return files.filter((f) => /\.(csv|tsv|txt)$/i.test(f.name)).map((f) => ({ name: f.name, text: decodeText(f.bytes) }));
  }
  return [{ name, text: decodeText(bytes) }];
}

export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseExport(files) {
  const result = { daily: [], breakdowns: [], unrecognized: [] };

  for (const file of files) {
    const rows = parseCSV(file.text);
    if (rows.length < 2) { result.unrecognized.push(file.name); continue; }
    const header = rows[0].map((h) => h.toLowerCase());
    const body = rows.slice(1);

    const dateCol = header.findIndex((h) => /^(date|day|datum|fecha|日付)/.test(h));
    if (dateCol >= 0) {
      result.daily.push(...parseDaily(header, body, dateCol));
      continue;
    }

    const dimension = detectDimension(file.name, header[0], body.map((r) => r[0]));
    if (!dimension) { result.unrecognized.push(file.name); continue; }
    result.breakdowns.push(...parseBreakdown(dimension, header, body));
  }

  // Deduplicate daily rows by date (last one wins) and sort.
  const byDate = new Map(result.daily.map((d) => [d.date, d]));
  result.daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

function parseDaily(header, body, dateCol) {
  const col = (re) => header.findIndex((h, i) => i !== dateCol && re.test(h));
  const reqCol = col(/request/);
  const sizeCol = col(/size|byte|download/);
  const timeCol = col(/response time|time|ms/);
  const out = [];
  for (const r of body) {
    const date = parseDate(r[dateCol]);
    if (!date) continue;
    out.push({
      date,
      requests: reqCol >= 0 ? parseNumber(r[reqCol]) : null,
      bytes: sizeCol >= 0 ? parseNumber(r[sizeCol]) : null,
      avgResponseMs: timeCol >= 0 ? parseNumber(r[timeCol]) : null,
    });
  }
  return out;
}

function parseBreakdown(dimension, header, body) {
  // GSC labels the share column "Requests" but fills it with "82%", so a
  // column is a percentage if its header says so or its cells contain "%".
  const out = [];
  for (const r of body) {
    if (!r[0]) continue;
    let pct = null, requests = null;
    for (let i = 1; i < r.length; i++) {
      const n = parseNumber(r[i]);
      if (n === null) continue;
      if (/%/.test(r[i]) || /%|percent|share/.test(header[i] || '')) pct ??= n;
      else requests ??= n;
    }
    out.push({ dimension, value: r[0], requests, pct });
  }
  return out;
}

const VALUE_HINTS = {
  response: /^(ok|not found|moved|redirect|server error|unauthorized|forbidden|not modified|other|dns|page could not|robots)|\(\d{3}\)|\b[2-5]\d\d\b/i,
  file_type: /^(html|image|javascript|css|json|pdf|xml|video|audio|syndication|geographic|other xml|other file|unknown)/i,
  purpose: /^(refresh|discovery)$/i,
  googlebot_type: /^(smartphone|desktop|image|video|page resource load|adsbot|storebot|other agent type)/i,
  host: /^(https?:\/\/|[a-z0-9-]+\.[a-z0-9.-]+$)/i,
};

export function detectDimension(fileName, firstHeader, firstColValues) {
  const probe = `${fileName} ${firstHeader}`.toLowerCase();
  if (/googlebot|crawler|agent/.test(probe)) return 'googlebot_type';
  if (/file.?type|filetype/.test(probe)) return 'file_type';
  if (/purpose/.test(probe)) return 'purpose';
  if (/response/.test(probe)) return 'response';
  if (/host/.test(probe)) return 'host';

  // Fall back to what the values look like.
  let best = null, bestScore = 0;
  for (const [dim, re] of Object.entries(VALUE_HINTS)) {
    const score = firstColValues.filter((v) => re.test(v)).length / Math.max(1, firstColValues.length);
    if (score > bestScore) { best = dim; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

export function parseNumber(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).replace(/[%\s ]/g, '').replace(/[^\d.,-]/g, '');
  if (!t || t === '-') return null;
  const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever separator comes last is the decimal separator.
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(s) {
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
