import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ObjectDB, readPack, writePack } from '../src/objects.ts';

const sha = (b: Buffer | string) => createHash('sha1').update(b).digest();

test('a pack imports canonical object IDs and rejects a bad checksum', () => {
  const db = new ObjectDB();
  const bytes = Buffer.from('hello\n');
  const oid = db.put('blob', bytes);
  assert.equal(oid, sha('blob 6\0hello\n').toString('hex'));
  const wire = writePack([db.get(oid)!]);
  assert.deepEqual(readPack(wire, db).get(oid)?.data, bytes);
  wire[wire.length - 1] ^= 1;
  assert.throws(() => readPack(wire, db), /checksum/);
});

test('a thin pack resolves REF_DELTA against a previously stored base', () => {
  const db = new ObjectDB();
  const base = db.put('blob', Buffer.from('hello'));
  const header = Buffer.from('5041434b0000000200000001', 'hex');
  const delta = Buffer.from([5, 6, 0x90, 5, 1, 0x21]);
  const frame = Buffer.concat([header, Buffer.of(0x76), Buffer.from(base, 'hex'), deflateSync(delta)]);
  const result = readPack(Buffer.concat([frame, sha(frame)]), db);
  assert.equal([...result.values()][0]?.data.toString(), 'hello!');
});
