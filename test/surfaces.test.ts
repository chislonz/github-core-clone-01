import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createForgeServer } from '../src/server.ts';

test('REST, MCP and GraphQL share IDs and enforce the HTTP bearer token', async t => {
  const server = createForgeServer({ token: 'local-test', owner: 'alice' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, data?: unknown) => {
    const r = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer local-test' }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.ok(r.ok, `${path}: ${r.status}`);
    return r.json();
  };
  const tool = (id: string, name: string, args: unknown) => request('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  await tool('new', 'create_repo', { name: 'r' });
  const [a, b] = await Promise.all([tool('A', 'create_issue', { owner: 'alice', repo: 'r', title: 'a' }), tool('B', 'create_issue', { owner: 'alice', repo: 'r', title: 'b' })]);
  assert.equal(a.id, 'A'); assert.equal(b.id, 'B');
  const issue = a.result.structuredContent;
  const read = await request(`/api/v3/repos/alice/r/issues/${issue.number}`);
  const [view, probe, bad] = await request('/api/graphql', [
    { query: 'query($n:Int!){repository(owner:"alice",name:"r"){issue(number:$n){id title}}}', variables: { n: issue.number } },
    { query: '{__type(name:"Issue"){fields{name}}}' },
    { query: '{viewer{unknownField}}' },
  ]);
  assert.equal(read.id, issue.id);
  assert.deepEqual(view.data.repository.issue, { id: issue.node_id, title: 'a' });
  assert.ok(probe.data.__type.fields.some((f: { name: string }) => f.name === 'number'));
  assert.match(bad.errors[0].message, /unknownField/);
  assert.equal((await fetch(base + '/api/v3/user')).status, 401);
});
