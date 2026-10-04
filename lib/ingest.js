// Takes a captured/uploaded export file and stores it. Idempotent: the same
// file (by SHA-256) is only stored once, and daily rows upsert by date, so the
// overlapping 90-day windows from repeated exports merge into one history.

import { readExportFiles, parseExport } from './parse.js';
import { get, put, putMany } from './db.js';
import { labelFor } from './shared.js';

export async function ingestExport({ propertyId, fileName, bytes, source }) {
  if (!propertyId) throw new Error('Missing property');
  const id = await sha256(bytes);
  const existing = await get('exports', id);
  if (existing) return { duplicate: true, export: existing };

  const files = await readExportFiles(fileName, bytes);
  const parsed = parseExport(files);
  if (!parsed.daily.length && !parsed.breakdowns.length) {
    throw new Error(`No crawl stats found in ${fileName}. Files seen: ${files.map((f) => f.name).join(', ') || 'none'}`);
  }

  const exportRec = {
    id,
    propertyId,
    fileName,
    source,
    capturedAt: new Date().toISOString(),
    rangeStart: parsed.daily[0]?.date ?? null,
    rangeEnd: parsed.daily.at(-1)?.date ?? null,
    dailyCount: parsed.daily.length,
    breakdownCount: parsed.breakdowns.length,
    files: files.map((f) => f.name),
    unrecognized: parsed.unrecognized,
  };

  const property = (await get('properties', propertyId)) ?? { id: propertyId, label: labelFor(propertyId), addedAt: exportRec.capturedAt };
  property.lastExportAt = exportRec.capturedAt;

  await putMany({
    properties: [property],
    exports: [exportRec],
    daily: parsed.daily.map((d) => ({ ...d, propertyId, exportId: id })),
    breakdowns: parsed.breakdowns.map((b) => ({ ...b, propertyId, exportId: id, capturedAt: exportRec.capturedAt })),
    rawFiles: files.map((f) => ({ exportId: id, name: f.name, text: f.text })),
  });
  return { duplicate: false, export: exportRec };
}

// Stores a snapshot read directly from Search Console's page data
// (see gsc-data.js). Same storage model as a CSV import.
export async function ingestSnapshot({ propertyId, snapshot, source }) {
  if (!propertyId || snapshot.propertyId !== propertyId) throw new Error('Snapshot does not belong to this property');
  const id = await sha256(new TextEncoder().encode(JSON.stringify([propertyId, snapshot.daily, snapshot.breakdowns])));
  const existing = await get('exports', id);
  const capturedAt = new Date().toISOString();

  const property = (await get('properties', propertyId)) ?? { id: propertyId, label: labelFor(propertyId), addedAt: capturedAt };
  property.lastExportAt = capturedAt;

  if (existing) {
    // Identical data already stored – only record that the backup ran.
    await put('properties', property);
    return { duplicate: true, export: existing };
  }

  const exportRec = {
    id, propertyId, fileName: 'Search Console page data', source, capturedAt,
    rangeStart: snapshot.daily[0]?.date ?? null, rangeEnd: snapshot.daily.at(-1)?.date ?? null,
    dailyCount: snapshot.daily.length, breakdownCount: snapshot.breakdowns.length, files: [], unrecognized: [],
  };
  await putMany({
    properties: [property],
    exports: [exportRec],
    daily: snapshot.daily.map((d) => ({ ...d, propertyId, exportId: id })),
    breakdowns: snapshot.breakdowns.map((b) => ({ ...b, propertyId, exportId: id, capturedAt })),
  });
  return { duplicate: false, export: exportRec };
}

export async function addProperty(propertyId) {
  const existing = await get('properties', propertyId);
  if (existing) return existing;
  const p = { id: propertyId, label: labelFor(propertyId), addedAt: new Date().toISOString(), lastExportAt: null };
  await put('properties', p);
  return p;
}


async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
