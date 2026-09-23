import type { VDocument } from '../common/types.js';
import { VectorError } from '../common/errors.js';

export const FORMAT = 'masvector';
export const FORMAT_VERSION = 1;

export function serializeJSON(doc: VDocument, pretty = true): string {
  return JSON.stringify({ format: FORMAT, formatVersion: FORMAT_VERSION, document: doc }, null, pretty ? 2 : 0);
}

export function parseJSON(text: string): VDocument {
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { throw new VectorError('INVALID_ARGUMENT', `JSON ayrıştırılamadı: ${(e as Error).message}`); }
  const doc = raw?.format === FORMAT ? raw.document : raw;
  if (raw?.format === FORMAT && raw.formatVersion > FORMAT_VERSION)
    throw new VectorError('UNSUPPORTED', `Belge biçim sürümü ${raw.formatVersion} bu sürümden yeni`);
  if (!doc || typeof doc.id !== 'string' || !Array.isArray(doc.pages))
    throw new VectorError('INVALID_ARGUMENT', 'Geçerli bir MasVector belgesi değil (id/pages eksik)');
  for (const p of doc.pages) {
    p.guides ??= [];
    p.grid ??= { size: 8, enabled: false };
    if (!Array.isArray(p.frames)) throw new VectorError('INVALID_ARGUMENT', 'Sayfada frames yok');
  }
  doc.version ??= 0;
  return doc as VDocument;
}
