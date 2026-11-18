import test from 'node:test';
import assert from 'node:assert/strict';
import { Objects, pack, unpack } from '../objects.ts';

test('Git objects round-trip through a checksummed pack', () => {
  const source = new Objects();
  const blob = source.put('blob', Buffer.from('hello\n'));
  const tree = source.tree(new Map([['nested/file.txt', blob]]));
  const commit = source.commit(tree, [], 'first', 1700000000);
  const target = new Objects();
  unpack(pack([...source.data.values()]), target);
  assert.deepEqual(target.files(commit), new Map([['nested/file.txt', blob]]));
  assert.deepEqual(target.data, source.data);
  const corrupt = pack([...source.data.values()]);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => unpack(corrupt, new Objects()));
});

test('ancestry follows parents rather than object insertion order', () => {
  const objects = new Objects();
  const tree = objects.tree(new Map());
  const root = objects.commit(tree, [], 'root', 1);
  const left = objects.commit(tree, [root], 'left', 2);
  const right = objects.commit(tree, [root], 'right', 3);
  assert.equal(objects.ancestor(root, left), true);
  assert.equal(objects.ancestor(left, right), false);
});
