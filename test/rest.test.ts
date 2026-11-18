import test from 'node:test';
import assert from 'node:assert/strict';
import { Forge } from '../src/store.ts';
import { rest } from '../src/rest.ts';

const forge = new Forge('developer', '2026-01-01T00:00:00.000Z');
function api(method: string, path: string, body?: unknown) {
  return rest(forge, method, new URL(`http://localhost/api/v3${path}`), body);
}
test('REST writes real Git objects, checks stale SHAs, and isolates owners', () => {
  assert.equal(api('POST', '/user/repos', { name: 'project' }).status, 201);
  const repo = '/repos/developer/project';
  const path = repo + '/contents/dir/file';
  const created = api('PUT', path, { content: 'aGk=', message: 'first' });
  assert.equal(created.status, 201);
  const sha = created.value.content.sha;
  assert.equal(forge.repo('developer', 'project').db.get(sha)?.data.toString(), 'hi');
  assert.throws(() => api('GET', '/repos/other/project'), { status: 404 });
  assert.equal(api('PUT', path, { sha, content: 'Ynll', message: 'change' }).status, 200);
  assert.throws(() => api('PUT', path, { sha, content: '', message: 'stale' }), { status: 409 });
  assert.equal(api('GET', path).value.content, 'Ynll');
});
