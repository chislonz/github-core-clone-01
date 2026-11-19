import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { createForgeServer } from '../src/server.ts';

test('repeated serialized issue views reuse UTF-8 bytes but mutation produces current bytes', async t => {
  const token = 'ordinary-local-token';
  const server = createForgeServer({ token, owner: 'developer' });
  const writtenBodies: { path: string; body: unknown }[] = [];
  server.prependListener('request', (req, res) => {
    const original = res.end;
    res.end = function (...args: any[]) {
      writtenBodies.push({ path: req.url!, body: args[0] });
      return Reflect.apply(original, this, args);
    } as typeof res.end;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const send = (method: string, path: string, body?: unknown) => new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
    const encoded = body === undefined ? '' : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: address.port, method, path, headers: { Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(encoded) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(encoded);
  });
  assert.equal((await send('POST', '/api/v3/user/repos', { name: 'ordinary-repo' })).status, 201);
  const path = '/api/v3/repos/developer/ordinary-repo/issues';
  const create = await send('POST', path, { title: 'café 漢字 😀', body: 'first' });
  assert.equal(create.status, 201);
  const first = await send('GET', path + '/1');
  const second = await send('GET', path + '/1');
  assert.deepEqual(second.body, first.body);
  assert.equal(Number(first.headers['content-length']), first.body.length);
  const views = writtenBodies.filter(row => row.path === path + '/1');
  assert(Buffer.isBuffer(views[0].body), 'serialized issue view should be sent as cached UTF-8 bytes');
  assert.equal(views[0].body, views[1].body, 'identical immutable serialized views should reuse one buffer');
  assert.equal((await send('PATCH', path + '/1', { title: 'changed 🚀', state: 'closed' })).status, 200);
  const updated = await send('GET', path + '/1');
  assert.equal(JSON.parse(updated.body.toString()).title, 'changed 🚀');
  assert.equal(JSON.parse(updated.body.toString()).state, 'closed');
  assert.notDeepEqual(updated.body, first.body);
  assert.equal(Number(updated.headers['content-length']), updated.body.length);
  assert.equal((await send('POST', path + '/1/comments', { body: 'new comment' })).status, 201);
  const afterComment = await send('GET', path + '/1');
  assert.equal(JSON.parse(afterComment.body.toString()).comments, 1);
  const cachedBeforeEviction = writtenBodies.at(-1)!.body;
  for (let index = 0; index < 65; index++) {
    const result = await send('POST', path, { title: 'another ordinary issue ' + index });
    const number = JSON.parse(result.body.toString()).number;
    await send('GET', path + '/' + number);
  }
  const afterEviction = await send('GET', path + '/1');
  assert.deepEqual(afterEviction.body, afterComment.body);
  assert.notEqual(writtenBodies.at(-1)!.body, cachedBeforeEviction, 'entry cap must evict old encodings');
  // Reach the byte budget with fewer than 64 medium-size views.
  const oldestIssue = await send('POST', path, { title: 'byte-budget-oldest', body: '漢字😀'.repeat(2500) });
  const oldestPath = path + '/' + JSON.parse(oldestIssue.body.toString()).number;
  const oldestRead = await send('GET', oldestPath);
  const oldestBuffer = writtenBodies.at(-1)!.body;
  let newestPath = '', newestBuffer: unknown;
  for (let index = 0; index < 24; index++) {
    const created = await send('POST', path, { title: 'byte-budget-' + index, body: '漢字😀'.repeat(2500) });
    newestPath = path + '/' + JSON.parse(created.body.toString()).number;
    const loaded = await send('GET', newestPath);
    assert(loaded.body.length + loaded.body.toString().length * 2 + 64 <= 64 * 1024);
    newestBuffer = writtenBodies.at(-1)!.body;
  }
  const newestRead = await send('GET', newestPath);
  assert.equal(writtenBodies.at(-1)!.body, newestBuffer, 'most recent view should remain cached');
  assert.equal(Number(newestRead.headers['content-length']), newestRead.body.length);
  const oldestAgain = await send('GET', oldestPath);
  assert.deepEqual(oldestAgain.body, oldestRead.body);
  assert.equal(Number(oldestAgain.headers['content-length']), oldestAgain.body.length);
  assert.notEqual(writtenBodies.at(-1)!.body, oldestBuffer, 'byte budget must evict before entry-count limit');
  const largeIssue = await send('POST', path, { title: 'large ordinary issue', body: 'large body '.repeat(10000) });
  const largePath = path + '/' + JSON.parse(largeIssue.body.toString()).number;
  await send('GET', largePath);
  const largeFirst = writtenBodies.at(-1)!.body;
  await send('GET', largePath);
  assert.notEqual(writtenBodies.at(-1)!.body, largeFirst, 'large serialized views must not be retained');
  const deleted = await send('DELETE', '/api/v3/repos/developer/ordinary-repo');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body.length, 0);
});
