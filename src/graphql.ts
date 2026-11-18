import { parse, argumentsOf, input, type Field, type Selection } from './graphql-language.ts';
import { Forge, Repository, record, type Issue, type Pull, type Comment } from './store.ts';

type Row = { type: string; value: any };
type Resolver = (ctx: Forge, value: any, args: Record<string, any>) => unknown;
type Definition = { target?: string; list?: boolean; resolve: Resolver };
const scalar = (key: string): Definition => ({ resolve: (_, v) => v[key] });
const calc = (resolve: Resolver): Definition => ({ resolve });
const ref = (target: string, resolve: Resolver, list = false): Definition => ({ target, resolve, list });
const fields = (...keys: string[]) => Object.fromEntries(keys.map(k => [k, scalar(k)]));
const node = (type: string, value: unknown): Row => ({ type, value });
const withRepo = (repo: Repository, entity: Issue | Pull) => ({ repo, ...entity });
const enumMap: Record<string, string[]> = { SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
function connection(items: unknown[], type: string, args: Record<string, any>, scope: string) {
  const cursor = (offset: number) => Buffer.from(`${scope}:${offset}`).toString('base64url');
  let start = 0;
  if (typeof args.after === 'string') {
    const decoded = Buffer.from(args.after, 'base64url').toString();
    const end = decoded.slice(scope.length + 1);
    if (!decoded.startsWith(`${scope}:`) || !/^\d+$/.test(end)) throw Error('Invalid cursor');
    start = Number(end) + 1;
  }
  const count = Number.isSafeInteger(args.first) ? Math.min(100, Math.max(0, args.first)) : 30;
  const page = items.slice(start, start + count);
  const edges = page.map((v, i) => ({ cursor: cursor(start + i), node: node(type, v) }));
  return { totalCount: items.length, edges, nodes: edges.map(e => e.node), pageInfo: { hasNextPage: start + page.length < items.length, hasPreviousPage: start > 0, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null } };
}

const schema: Record<string, Record<string, Definition>> = {
  Query: {
    viewer: ref('User', f => f.owner),
    repository: ref('Repository', (f, _, a) => f.lookup(a.owner, a.name) ?? null),
    node: ref('Node', (f, _, a) => {
      const n = f.nodes.get(a.id);
      if (!n) return a.id === f.owner.node_id ? node('User', f.owner) : null;
      return node(n.kind, n.kind === 'Issue' || n.kind === 'PullRequest' ? withRepo(n.repo, n.entity) : n.entity);
    }),
    __type: ref('__Type', (_, __, a) => typeof a.name === 'string' && (Object.hasOwn(schema, a.name) || Object.hasOwn(enumMap, a.name) || scalars.has(a.name)) ? a.name : null),
    __schema: ref('__Schema', () => ({})),
  },
  Mutation: {
    createIssue: ref('IssuePayload', (f, _, a) => {
      const data = record(a.input), { repo } = f.find(data.repositoryId, 'Repository');
      return { issue: withRepo(repo, f.createIssue(repo, data)) };
    }),
    closeIssue: ref('IssuePayload', (f, _, a) => {
      const { repo, entity } = f.find(record(a.input).issueId, 'Issue');
      return { issue: withRepo(repo, f.updateIssue(repo, entity, { state: 'closed' })) };
    }),
    createPullRequest: ref('PullRequestPayload', (f, _, a) => {
      const data = record(a.input), { repo } = f.find(data.repositoryId, 'Repository');
      return { pullRequest: withRepo(repo, f.createPull(repo, { ...data, head: data.headRefName, base: data.baseRefName })) };
    }),
    mergePullRequest: ref('PullRequestPayload', (f, _, a) => {
      const data = record(a.input), { repo, entity } = f.find(data.pullRequestId, 'PullRequest');
      f.merge(repo, entity, { sha: data.expectedHeadOid, commit_title: data.commitHeadline });
      return { pullRequest: withRepo(repo, entity) };
    }),
    addComment: ref('CommentPayload', (f, _, a) => {
      const data = record(a.input), { repo, entity } = f.find(data.subjectId, 'Issue');
      return { commentEdge: { node: f.addComment(repo, entity, data.body) } };
    }),
  },
  Node: { id: scalar('node_id') },
  User: { ...fields('login', 'name'), id: scalar('node_id'), databaseId: scalar('id') },
  Repository: {
    id: calc((_, r) => r.info.node_id), databaseId: calc((_, r) => r.info.id), name: calc((_, r) => r.info.name), nameWithOwner: calc((_, r) => r.info.full_name),
    description: calc((_, r) => r.info.description), isPrivate: calc((_, r) => r.info.private),
    owner: ref('User', (_, r) => r.info.owner), defaultBranchRef: ref('Ref', (_, r) => ({ name: r.defaultBranch, target: r.tip() ? { oid: r.tip() } : null })),
    viewerPermission: calc(() => 'ADMIN'), hasIssuesEnabled: calc((_, r) => r.info.has_issues),
    issue: ref('Issue', (_, r: Repository, a) => { const issue = r.issues.get(a.number); return issue ? withRepo(r, issue) : null; }),
    pullRequest: ref('PullRequest', (_, r: Repository, a) => { const pull = r.pulls.get(a.number); return pull ? withRepo(r, pull) : null; }),
    issues: ref('IssueConnection', (_, r: Repository, a) => {
      const rows = [...r.issues.values()].filter(i => !Array.isArray(a.states) || a.states.includes(i.state.toUpperCase()));
      if (a.orderBy?.direction !== 'ASC') rows.reverse();
      return connection(rows.map(i => withRepo(r, i)), 'Issue', a, `${r.info.id}:issues`);
    }),
    pullRequests: ref('PullRequestConnection', (_, r: Repository, a) => {
      const rows = [...r.pulls.values()].filter(p => !Array.isArray(a.states) || a.states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      if (a.orderBy?.direction !== 'ASC') rows.reverse();
      return connection(rows.map(p => withRepo(r, p)), 'PullRequest', a, `${r.info.id}:pulls`);
    }),
  },
  Ref: { name: scalar('name'), target: ref('Commit', (_, v) => v.target) },
  Commit: fields('oid'),
  Issue: {
    id: scalar('node_id'), ...fields('number', 'title', 'body'), state: calc((_, v) => v.state.toUpperCase()),
    createdAt: scalar('created_at'), updatedAt: scalar('updated_at'), closedAt: scalar('closed_at'), author: ref('User', (_, v) => v.user),
    repository: ref('Repository', (_, v) => v.repo),
    comments: ref('IssueCommentConnection', (_, v, a) => connection(v.repo.comments.get(v.number) ?? [], 'IssueComment', a, `${v.id}:comments`)),
  },
  PullRequest: {
    id: scalar('node_id'), ...fields('number', 'title', 'body', 'merged'), state: calc((_, p) => p.merged ? 'MERGED' : p.state.toUpperCase()),
    headRefName: calc((_, p) => p.head.ref), baseRefName: calc((_, p) => p.base.ref),
    mergeable: calc((_, p) => p.state !== 'open' ? 'UNKNOWN' : p.repo.compare(p).conflict ? 'CONFLICTING' : 'MERGEABLE'),
    files: ref('PullRequestChangedFileConnection', (_, p, a) => connection(p.repo.files(p).map((row: any) => ({ ...row, path: row.filename })), 'PullRequestChangedFile', a, `${p.id}:files`)),
    repository: ref('Repository', (_, p) => p.repo),
  },
  PullRequestChangedFile: fields('path', 'additions', 'deletions'),
  IssueComment: { id: scalar('node_id'), ...fields('body'), author: ref('User', (_, c: Comment) => c.user) },
  IssuePayload: { issue: ref('Issue', (_, p) => p.issue) },
  PullRequestPayload: { pullRequest: ref('PullRequest', (_, p) => p.pullRequest) },
  CommentPayload: { commentEdge: ref('IssueCommentEdge', (_, p) => p.commentEdge) },
  PageInfo: fields('hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'),
  __Schema: {
    queryType: ref('__Type', () => 'Query'), mutationType: ref('__Type', () => 'Mutation'), subscriptionType: ref('__Type', () => null),
    types: ref('__Type', () => [...Object.keys(schema), ...Object.keys(enumMap), ...scalars], true),
  },
  __Type: {
    name: calc((_, v) => typeof v === 'string' ? v : null), kind: calc((_, v) => typeof v === 'object' ? v.kind : scalars.has(v) ? 'SCALAR' : Object.hasOwn(enumMap, v) ? 'ENUM' : v === 'Node' ? 'INTERFACE' : 'OBJECT'),
    description: calc(() => null), ofType: ref('__Type', (_, v) => typeof v === 'object' ? v.ofType : null),
    fields: ref('__Field', (_, v) => Object.hasOwn(schema, v) ? Object.entries(schema[v]).map(([name, def]) => ({ name, type: def.list ? { kind: 'LIST', ofType: def.target } : def.target ?? scalarType(name) })) : null, true),
    enumValues: ref('__EnumValue', (_, v) => Object.hasOwn(enumMap, v) ? enumMap[v].map(name => ({ name })) : null, true),
    possibleTypes: ref('__Type', (_, v) => v === 'Node' ? ['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment'] : null, true),
    interfaces: ref('__Type', (_, v) => ['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment'].includes(v) ? ['Node'] : [], true),
  },
  __Field: { ...fields('name'), type: ref('__Type', (_, f) => f.type), isDeprecated: calc(() => false), description: calc(() => null), deprecationReason: calc(() => null) },
  __EnumValue: { ...fields('name'), isDeprecated: calc(() => false), description: calc(() => null), deprecationReason: calc(() => null) },
};
const scalars = new Set(['String', 'ID', 'Int', 'Boolean', 'DateTime', 'GitObjectID']);
function scalarType(name: string) {
  if (['id'].includes(name)) return 'ID';
  if (['databaseId', 'number', 'totalCount', 'additions', 'deletions'].includes(name)) return 'Int';
  if (['merged', 'hasIssuesEnabled', 'isPrivate', 'hasNextPage', 'hasPreviousPage', 'isDeprecated'].includes(name)) return 'Boolean';
  if (['createdAt', 'updatedAt', 'closedAt'].includes(name)) return 'DateTime';
  if (name === 'oid') return 'GitObjectID';
  return 'String';
}
for (const type of ['Issue', 'PullRequest', 'IssueComment', 'PullRequestChangedFile']) {
  schema[`${type}Connection`] = { totalCount: scalar('totalCount'), nodes: ref(type, (_, x) => x.nodes, true), edges: ref(`${type}Edge`, (_, x) => x.edges, true), pageInfo: ref('PageInfo', (_, x) => x.pageInfo) };
  schema[`${type}Edge`] = { cursor: scalar('cursor'), node: ref(type, (_, x) => x.node) };
}

function operation(forge: Forge, request: unknown) {
  const data = record(request);
  const err = (message: string) => ({ errors: [{ message }] });
  if (typeof data.query !== 'string') return err('A query document is required');
  try {
    const { operations, fragments } = parse(data.query);
    const op = typeof data.operationName === 'string' ? operations.find(o => o.name === data.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!op) return err('Specify a valid operation name');
    const root = op.type === 'query' ? 'Query' : op.type === 'mutation' ? 'Mutation' : '';
    if (!root) return err('Subscriptions are not supported');
    const vars = Object.assign(Object.fromEntries([...op.defaults].map(([k, v]) => [k, input(v, {})])), record(data.variables));
    const invalidFields: { message: string; locations: { line: number; column: number }[] }[] = [];
    const fragmentAt = (s: Extract<Selection, { spread: string }>, type: string) => s.on ? { type: s.spread || type, children: s.children } : fragments.get(s.spread);
    let budget = 20000;
    function validate(type: string, picks: Selection[], active = new Set<string>()) {
      for (const s of picks) {
        if (--budget < 0) throw Error('Query too complex');
        if ('spread' in s) {
          const f = fragmentAt(s, type);
          if (!f || !Object.hasOwn(schema, f.type)) throw Error(`Unknown fragment or type ${s.spread}`);
          if (!s.on && active.has(s.spread)) throw Error(`Fragment cycle: ${s.spread}`);
          validate(f.type, f.children, s.on ? active : new Set([...active, s.spread]));
        } else {
          const field = Object.hasOwn(schema[type], s.name) ? schema[type][s.name] : undefined;
          if (!field && s.name !== '__typename') invalidFields.push({ message: `Cannot query field "${s.name}" on type "${type}".`, locations: [{ line: s.line, column: s.column }] });
          else if (field?.target && s.children.length) validate(field.target, s.children, active);
          else if (Boolean(field?.target) !== Boolean(s.children.length)) throw Error(`Invalid selection for ${s.name}`);
        }
      }
    }
    validate(root, op.children);
    if (invalidFields.length) return { errors: invalidFields };
    const enabled = (s: Selection) => s.directives.every(d => {
      const cond = argumentsOf(d.args, vars).if;
      return d.name === 'skip' ? cond !== true : d.name === 'include' ? cond === true : true;
    });
    const errors: { message: string; path: (number | string)[] }[] = [];
    let steps = 200000;
    function project(type: string, value: any, picks: Selection[], path: (number | string)[]) {
      if (value == null) return null;
      if (type === 'Node' || (value && typeof value.type === 'string' && Object.hasOwn(value, 'value'))) { type = value.type; value = value.value; }
      const out = Object.create(null);
      function select(selection: Selection[]) {
        for (const s of selection) {
          if (--steps < 0) throw Error('Query result too complex');
          if (!enabled(s)) continue;
          if ('spread' in s) { const f = fragmentAt(s, type); if (f && (f.type === type || f.type === 'Node')) select(f.children); continue; }
          const alias = s.alias;
          if (s.name === '__typename') { out[alias] = type; continue; }
          if (Object.hasOwn(out, alias)) continue;
          const def = schema[type][s.name], trace = [...path, alias];
          try {
            const result = def.resolve(forge, value, argumentsOf(s.args, vars));
            const item = (v: unknown, p: (number | string)[]) => def.target ? project(def.target, v, s.children, p) : v ?? null;
            out[alias] = result == null ? null : def.list ? (result as unknown[]).map((v, i) => item(v, [...trace, i])) : item(result, trace);
          } catch (e) { out[alias] = null; errors.push({ message: e instanceof Error ? e.message : 'Field failed', path: trace }); }
        }
      }
      select(picks); return out;
    }
    const result = project(root, {}, op.children, []);
    return errors.length ? { data: result, errors } : { data: result };
  } catch (e) { return err(e instanceof Error ? e.message : 'Invalid GraphQL document'); }
}
export function graphql(forge: Forge, request: unknown) { return Array.isArray(request) ? request.map(item => operation(forge, item)) : operation(forge, request); }
