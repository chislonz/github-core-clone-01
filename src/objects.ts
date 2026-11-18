import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const kinds = ['', 'commit', 'tree', 'blob', 'tag'] as const;
export type Kind = Exclude<typeof kinds[number], ''>;
export type GitObject = { kind: Kind; data: Buffer; oid: string; packed?: Buffer; links?: string[] };
export type TreeEntry = { name: string; mode: string; oid: string };
export const ZERO = '0'.repeat(40);
const objectLimit = 32 * 1024 * 1024;
const hash = (data: Buffer) => createHash('sha1').update(data).digest();
export const isOid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

function makeObject(kind: Kind, data: Buffer): GitObject {
  const oid = createHash('sha1').update(`${kind} ${data.length}\0`).update(data).digest('hex');
  return { kind, data, oid };
}

export function treeEntries(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let p = 0; p < data.length;) {
    const space = data.indexOf(32, p), nul = data.indexOf(0, p);
    if (space <= p || nul <= space + 1 || nul + 21 > data.length) throw Error('Invalid tree');
    const mode = data.toString('ascii', p, space);
    const name = data.toString('utf8', space + 1, nul);
    if (!/^(40000|040000|100644|100755|120000|160000)$/.test(mode) || name.includes('/') || name === '.' || name === '..') throw Error('Invalid tree entry');
    entries.push({ name, mode, oid: data.toString('hex', nul + 1, nul + 21) });
    p = nul + 21;
  }
  return entries;
}

export function commitInfo(obj: GitObject) {
  const source = obj.data.toString();
  const split = source.indexOf('\n\n');
  const headers = (split < 0 ? source : source.slice(0, split)).split('\n');
  return { tree: headers.find(h => h.startsWith('tree '))?.slice(5) ?? '',
    parents: headers.filter(h => h.startsWith('parent ')).map(h => h.slice(7)),
    message: split < 0 ? '' : source.slice(split + 2) };
}

export function links(obj: GitObject): string[] {
  if (obj.links) return obj.links;
  let refs: string[] = [];
  if (obj.kind === 'tree') refs = treeEntries(obj.data).filter(e => e.mode !== '160000').map(e => e.oid);
  if (obj.kind === 'commit') { const c = commitInfo(obj); refs = [c.tree, ...c.parents]; }
  if (obj.kind === 'tag') refs = [obj.data.toString('ascii', 0, 47).replace(/^object /, '')];
  if (!refs.every(isOid)) throw Error('Invalid object link');
  return obj.links = refs;
}

export class ObjectDB {
  objects = new Map<string, GitObject>();
  get(oid: string) { return this.objects.get(oid); }
  put(kind: Kind, data: Buffer) {
    const obj = makeObject(kind, data);
    if (!this.objects.has(obj.oid)) this.objects.set(obj.oid, obj);
    return obj.oid;
  }
  import(objects: Map<string, GitObject>) {
    for (const [oid, obj] of objects) if (!this.objects.has(oid)) this.objects.set(oid, obj);
  }
  peel(oid: string) {
    const seen = new Set<string>();
    while (this.get(oid)?.kind === 'tag' && !seen.has(oid)) {
      seen.add(oid);
      oid = links(this.get(oid)!)[0];
    }
    return oid;
  }
  ancestors(roots: string[]) {
    const seen = new Set<string>();
    for (let i = 0, queue = [...roots]; i < queue.length; i++) {
      const oid = queue[i], obj = this.get(oid);
      if (!obj || obj.kind !== 'commit' || seen.has(oid)) continue;
      seen.add(oid);
      for (const p of links(obj).slice(1)) queue.push(p);
    }
    return seen;
  }
  isAncestor(old: string, tip: string) {
    const seen = new Set<string>(), pending = [tip];
    while (pending.length) {
      const oid = pending.pop()!;
      if (oid === old) return true;
      const obj = this.get(oid);
      if (obj?.kind !== 'commit' || seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of links(obj).slice(1)) pending.push(parent);
    }
    return false;
  }
}

function expandDelta(base: Buffer, delta: Buffer) {
  let p = 0;
  function byte() {
    if (p >= delta.length) throw Error('Truncated delta');
    return delta[p++];
  }
  function size() {
    let n = 0, mul = 1, c;
    do { c = byte(); n += (c & 127) * mul; mul *= 128; if (n > objectLimit || mul > 2 ** 35) throw Error('Large delta'); } while (c & 128);
    return n;
  }
  if (size() !== base.length) throw Error('Delta base size');
  const output = Buffer.allocUnsafe(size());
  let out = 0;
  while (p < delta.length) {
    const op = byte();
    if (op & 128) {
      let from = 0, length = 0;
      for (let j = 0; j < 4; j++) if (op & (1 << j)) from += byte() * 256 ** j;
      for (let j = 0; j < 3; j++) if (op & (16 << j)) length += byte() * 256 ** j;
      length ||= 65536;
      if (from + length > base.length || out + length > output.length) throw Error('Delta copy bounds');
      base.copy(output, out, from, from + length); out += length;
    } else {
      if (!op || p + op > delta.length || out + op > output.length) throw Error('Delta insert bounds');
      delta.copy(output, out, p, p + op); p += op; out += op;
    }
  }
  if (out !== output.length) throw Error('Delta result size');
  return output;
}

export function readPack(pack: Buffer, db: ObjectDB): Map<string, GitObject> {
  const end = pack.length - 20;
  if (end < 12 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw Error('Invalid pack header');
  if (!hash(pack.subarray(0, end)).equals(pack.subarray(end))) throw Error('Invalid pack checksum');
  const count = pack.readUInt32BE(8);
  if (count > 200000) throw Error('Too many objects');
  const byId = new Map<string, GitObject>(), byOffset = new Map<number, GitObject>();
  const waiting: { offset: number; source: number | string; delta: Buffer }[] = [];
  let p = 12, total = 0;
  const byte = () => { if (p >= end) throw Error('Truncated object'); return pack[p++]; };
  function record(obj: GitObject, offset: number) {
    byId.set(obj.oid, obj); byOffset.set(offset, obj);
  }
  for (let i = 0; i < count; i++) {
    const offset = p;
    let c = byte(), size = c & 15, scale = 16;
    const code = (c >> 4) & 7;
    while (c & 128) { c = byte(); size += (c & 127) * scale; scale *= 128; if (scale > 2 ** 39) throw Error('Large object header'); }
    total += size;
    if (size > objectLimit || total > 128 * 1024 * 1024) throw Error('Pack exceeds object limit');
    let source: number | string = '';
    if (code === 6) {
      c = byte(); let distance = c & 127;
      while (c & 128) { c = byte(); distance = (distance + 1) * 128 + (c & 127); if (distance > offset) throw Error('Invalid delta offset'); }
      source = offset - distance;
      if (source < 12 || source >= offset) throw Error('Invalid delta offset');
    } else if (code === 7) {
      if (p + 20 > end) throw Error('Truncated delta ref');
      source = pack.toString('hex', p, p + 20); p += 20;
    } else if (!kinds[code]) throw Error('Invalid object type');
    const result = inflateSync(pack.subarray(p, end), { info: true, maxOutputLength: Math.max(1, size) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = result.buffer;
    p += result.engine.bytesWritten;
    if (data.length !== size) throw Error('Incorrect object size');
    if (source === '') {
      const obj = makeObject(kinds[code] as Kind, data);
      // A non-delta pack record has no position dependence and can be emitted unchanged.
      obj.packed = pack.subarray(offset, p);
      record(obj, offset);
    } else waiting.push({ offset, source, delta: data });
  }
  if (p !== end) throw Error('Trailing pack data');
  while (waiting.length) {
    let progressed = false, stillWaiting = 0;
    for (const entry of waiting) {
      const base = typeof entry.source === 'number' ? byOffset.get(entry.source) : byId.get(entry.source) ?? db.get(entry.source);
      if (!base) { waiting[stillWaiting++] = entry; continue; }
      const data = expandDelta(base.data, entry.delta);
      total += data.length;
      if (total > 128 * 1024 * 1024) throw Error('Expanded pack exceeds limit');
      record(makeObject(base.kind, data), entry.offset); progressed = true;
    }
    if (!progressed) throw Error('Missing delta base');
    waiting.length = stillWaiting;
  }
  return byId;
}

export function writePack(objects: GitObject[]) {
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const obj of objects) {
    if (!obj.packed) {
      let size = obj.data.length;
      const bytes = [(kinds.indexOf(obj.kind) << 4) | (size & 15)];
      size >>>= 4;
      while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size >>>= 7; }
      obj.packed = Buffer.concat([Buffer.from(bytes), deflateSync(obj.data, { level: 1 })]);
    }
    parts.push(obj.packed);
  }
  const digest = createHash('sha1');
  for (const part of parts) digest.update(part);
  return Buffer.concat([...parts, digest.digest()]);
}
