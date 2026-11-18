import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectDB, ZERO, writePack } from '../src/objects.ts';
import { pkt, receive, upload } from '../src/git-http.ts';

test('receive-pack applies only fast-forward refs, then fetch honors a depth boundary', () => {
  const db = new ObjectDB();
  const tree = db.put('tree', Buffer.alloc(0));
  const commit = (message: string, parent?: string) => db.put('commit', Buffer.from(
    `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}\n${message}\n`));
  const root = commit('root'), tip = commit('advance', root), side = commit('side');
  const repo = { db: new ObjectDB(), refs: new Map(), defaultBranch: 'main' };
  const flush = Buffer.from('0000');
  const push = (lines: string[], ids: string[]) => receive(repo, Buffer.concat([
    ...lines.map((line, i) => pkt(line + (i ? '' : '\0report-status side-band-64k') + '\n')),
    flush, writePack(ids.map(id => db.get(id)!)),
  ]));
  const ls = Buffer.concat([pkt('command=ls-refs\n'), Buffer.from('0001'), pkt('symrefs\n'), pkt('unborn\n'), flush]);
  assert.match(upload(repo, ls, true).toString(), /unborn HEAD/);
  push([`${ZERO} ${root} refs/heads/main`, `${ZERO} ${root} refs/heads/other`], [tree, root]);
  assert.match(upload(repo, ls, true).toString(), new RegExp(`${root} HEAD`));
  const report = push([`${root} ${tip} refs/heads/main`, `${root} ${side} refs/heads/other`], [tip, side]).toString();
  assert.match(report, /ok refs\/heads\/main/);
  assert.match(report, /ng refs\/heads\/other non-fast-forward/);
  assert.equal(repo.refs.get('refs/heads/main'), tip);
  assert.equal(repo.refs.get('refs/heads/other'), root);
  assert.match(upload(repo, ls, true).toString(), new RegExp(`${tip} HEAD`));
  const request = Buffer.concat([pkt('command=fetch\n'), Buffer.from('0001'), pkt(`want ${tip}\n`), pkt('deepen 1\n'), pkt('done\n'), flush]);
  const result = upload(repo, request, true);
  assert.match(result.toString(), new RegExp(`shallow ${tip}`));
  assert.match(result.toString(), /packfile\n/);
});