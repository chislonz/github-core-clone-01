import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.ts';
import { graphql } from '../graphql.ts';

const q = (query:string, variables:any={}) => graphql(store, {query, variables});
let store:Store;
function fixture() {
  store = new Store();
  const r = store.create({name:'graphql-repo'});
  const baseBlob = r.objects.put('blob', Buffer.from('base\n'));
  const base = r.objects.commit(r.objects.tree(new Map([['README.md',baseBlob]])), [], 'base', 1);
  const headBlob = r.objects.put('blob', Buffer.from('head\n'));
  const head = r.objects.commit(r.objects.tree(new Map([['README.md',baseBlob],['change.txt',headBlob]])), [base], 'head', 2);
  r.refs.set('refs/heads/main', base);
  r.refs.set('refs/heads/feature', head);
  return {r,base,head};
}

test('GraphQL repository branch, PR files, create and merge use shared IDs', () => {
  const {r,base,head} = fixture();
  const repo = q(`query($o:String!,$n:String!){repository(owner:$o,name:$n){id databaseId defaultBranchRef{name} pullRequests(first:5){nodes{number headRefName baseRefName files(first:10){nodes{path}}}}}}`, {o:'',n:'graphql-repo'});
  assert.equal(repo.data.repository.defaultBranchRef.name, 'main');
  const created = q(`mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id number headRefName baseRefName state}}}`, {input:{repositoryId:r.node_id,baseRefName:'main',headRefName:'feature',title:'new'}});
  assert.equal(created.data.createPullRequest.pullRequest.headRefName, 'feature');
  const pull = r.pulls.get(created.data.createPullRequest.pullRequest.number);
  assert.ok(pull);
  const listed = q(`{repository(owner:"",name:"graphql-repo"){pullRequests(first:5){nodes{number headRefName baseRefName files(first:10){nodes{path}}}}}}`);
  const node = listed.data.repository.pullRequests.nodes.find((x:any)=>x.number===pull.number);
  assert.equal(node.headRefName,'feature');
  assert.ok(node.files.nodes.some((x:any)=>x.path==='change.txt'));
  const merged = q(`mutation($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{merged state}}}`, {input:{pullRequestId:pull.node_id,mergeMethod:'SQUASH'}});
  assert.equal(merged.data.mergePullRequest.pullRequest.merged,true);
  assert.equal(r.pulls.get(pull.number).state,'closed');
  assert.equal(r.refs.get('refs/heads/main'),pull.merge_commit_sha);
});
