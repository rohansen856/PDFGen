import { createHash } from 'node:crypto';

// Deterministic JSON: sorted keys at every level, so the same data always hashes the same
// regardless of how the caller happened to order its dict keys.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Job-level fingerprint: hash of the ordered per-document hashes plus the as-of timestamp.
export function jobSnapshotHash(dataAsOf, payloadHashes) {
  return sha256(`${dataAsOf}\n${payloadHashes.join('\n')}`);
}
