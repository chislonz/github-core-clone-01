import { ObjectDB, commitInfo, treeEntries, type TreeEntry } from './objects.ts';
import { headRef, validRef } from './git-http.ts';

export class Fault extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export const missing = (): never => { throw new Fault(404, 'Not Found'); };
export const invalid = (message: string): never => { throw new Fault(422, message); };
export const text = (v: unknown, field: string): string => typeof v === 'string' && v.trim() ? v : invalid(`${field} is required`);
export function record(v: unknown): Record<string, any> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}; }
export type Owner = { login: string; id: number; node_id: string; type: string };
export type Label = { id: number; name: string; color: string; description: string | null };
export type Comment = { id: number; node_id: string; body: string; user: Owner; created_at: string; updated_at: string };
export type Issue = { id: number; node_id: string; number: number; title: string; body: string | null; state: string; labels: Label[]; user: Owner; created_at: string; updated_at: string; closed_at: string | null; comments: number };
export type Pull = { id: number; node_id: string; number: number; title: string; body: string | null; state: string; head: { ref: string; sha: string }; base: { ref: string; sha: string }; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; user: Owner; created_at: string };
type Files = Map<string, Omit<TreeEntry, 'name'>>;

export class Repository {
  info: { id: number; node_id: string; owner: Owner; name: string; full_name: string; private: boolean; description: string | null; default_branch: string; has_issues: boolean };
  db = new ObjectDB();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  comments = new Map<number, Comment[]>();
  serial = 0;
  issueViews = new WeakMap<Issue, string>();
  constructor(id: number, owner: Owner, name: string, data: Record<string, any>) {
    const branch = data.default_branch ?? 'main';
    if (!validRef(`refs/heads/${branch}`)) invalid('Invalid default branch');
    this.info = { id, node_id: `R_${id}`, owner, name, full_name: `${owner.login}/${name}`, private: data.private === true, description: typeof data.description === 'string' ? data.description : null, default_branch: branch, has_issues: data.has_issues !== false };
  }
  get defaultBranch() { return this.info.default_branch; }
  tip(ref = this.defaultBranch): string | undefined {
    return ref === 'HEAD' ? this.refs.get(headRef(this)) : this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`) ?? (this.db.get(ref) ? ref : undefined);
  }
  tree(sha: string) {
    const obj = this.db.get(this.db.peel(sha));
    if (!obj || obj.kind !== 'commit') return missing();
    return commitInfo(obj).tree;
  }
  snapshot(sha?: string): Files {
    const out: Files = new Map();
    if (!sha) return out;
    const pending = [[this.tree(sha), '']];
    while (pending.length) {
      const [oid, prefix] = pending.pop()!;
      const tree = this.db.get(oid);
      if (tree?.kind !== 'tree') throw Error('Missing tree');
      for (const { name, mode, oid } of treeEntries(tree.data)) {
        const path = prefix + name;
        if (mode === '40000' || mode === '040000') pending.push([oid, path + '/']);
        else out.set(path, { oid, mode });
      }
    }
    return out;
  }
  commit(files: Files, parent: string | undefined, branch: string, message: string, now: string) {
    type Dir = Map<string, Dir | Omit<TreeEntry, 'name'>>;
    const root: Dir = new Map();
    for (const [path, entry] of files) {
      const parts = path.split('/'); let dir = root;
      for (const part of parts.slice(0, -1)) {
        if (!dir.has(part)) dir.set(part, new Map());
        const child = dir.get(part);
        if (!(child instanceof Map)) throw new Fault(409, 'Path collision');
        dir = child;
      }
      const name = parts.at(-1)!;
      if (dir.get(name) instanceof Map) throw new Fault(409, 'Path collision');
      dir.set(name, entry);
    }
    const tree = (dir: Dir): string => {
      const chunks = [...dir].map(([name, e]) => {
        const folder = e instanceof Map;
        return { sort: Buffer.from(name + (folder ? '/' : '')), header: Buffer.from(`${folder ? '40000' : e.mode} ${name}\0`), oid: Buffer.from(folder ? tree(e) : e.oid, 'hex') };
      }).sort((a, b) => Buffer.compare(a.sort, b.sort));
      return this.db.put('tree', Buffer.concat(chunks.flatMap(e => [e.header, e.oid])));
    };
    const stamp = Math.trunc(Date.parse(now) / 1000) || 0;
    const login = this.info.owner.login;
    const identity = `${login} <${login}@users.noreply.invalid> ${stamp} +0000`;
    const sha = this.db.put('commit', Buffer.from(`tree ${tree(root)}\n${parent ? `parent ${parent}\n` : ''}author ${identity}\ncommitter ${identity}\n\n${message}${message.endsWith('\n') ? '' : '\n'}`));
    this.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
  mergeBase(base: string, head: string) { return [...this.db.ancestors([head])].find(oid => this.db.isAncestor(oid, base)); }
  compare(pull: Pull) {
    const head = this.tip(pull.head.ref) ?? pull.head.sha;
    const base = pull.merged ? pull.base.sha : this.tip(pull.base.ref) ?? pull.base.sha;
    const before = this.snapshot(this.mergeBase(base, head)), after = this.snapshot(head), current = this.snapshot(base);
    const equivalent = (a: Files, b: Files, key: string) => a.get(key)?.oid === b.get(key)?.oid && a.get(key)?.mode === b.get(key)?.mode;
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(key => !equivalent(before, after, key)).sort();
    const conflict = changed.some(key => !equivalent(before, current, key) && !equivalent(current, after, key));
    return { head, base, before, after, current, changed, conflict };
  }
  files(pull: Pull) {
    const { before, after, changed } = this.compare(pull);
    const lines = (oid: string) => {
      const bytes = this.db.get(oid)?.data;
      if (!bytes?.length || bytes.includes(0)) return [];
      return bytes.toString().replace(/\n$/, '').split('\n');
    };
    return changed.map(filename => {
      const a = before.get(filename), b = after.get(filename);
      const left = a ? lines(a.oid) : [], right = b ? lines(b.oid) : [];
      // Use LCS for typical text files, with a bounded replacement diff for large files.
      let same = 0;
      if (left.length * right.length <= 500000) {
        const row = new Uint32Array(right.length + 1);
        for (const l of left) for (let j = 1, previous = 0; j <= right.length; j++) {
          const saved = row[j]; row[j] = l === right[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]); previous = saved;
        }
        same = row[right.length];
      }
      const additions = right.length - same, deletions = left.length - same;
      return { filename, status: a ? b ? 'modified' : 'removed' : 'added', sha: b?.oid ?? a?.oid, additions, deletions, changes: additions + deletions };
    });
  }
}

export class Forge {
  owner: Owner;
  now: string;
  repos = new Map<string, Repository>();
  nodes = new Map<string, { repo: Repository; kind: string; entity: any }>();
  nextId = 1000;
  constructor(login: string, now: string) { this.owner = { login, id: 1000, node_id: 'U_1000', type: 'User' }; this.now = now; }
  lookup(owner: unknown, name: unknown) {
    return typeof owner === 'string' && typeof name === 'string' && owner.toLowerCase() === this.owner.login.toLowerCase() ? this.repos.get(name.toLowerCase()) : undefined;
  }
  repo(owner: unknown, name: unknown) { return this.lookup(owner, name) ?? missing(); }
  find(id: string, kind: string) { const row = this.nodes.get(id); return row?.kind === kind ? row : missing(); }
  createRepo(data: Record<string, any>) {
    const name = text(data.name, 'name');
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') invalid('Invalid repository name');
    if (this.lookup(this.owner.login, name)) invalid('Repository already exists');
    const repo = new Repository(++this.nextId, this.owner, name, data);
    this.repos.set(name.toLowerCase(), repo);
    this.nodes.set(repo.info.node_id, { repo, kind: 'Repository', entity: repo });
    return repo;
  }
  removeRepo(repo: Repository) {
    this.repos.delete(repo.info.name.toLowerCase());
    for (const [id, node] of this.nodes) if (node.repo === repo) this.nodes.delete(id);
  }
  issue(repo: Repository, number: number) { return repo.issues.get(number) ?? missing(); }
  pull(repo: Repository, number: number) { return repo.pulls.get(number) ?? missing(); }
  label(repo: Repository, data: Record<string, any>) {
    const name = text(data.name, 'name'), key = name.toLowerCase(), color = data.color ?? 'ededed';
    if (repo.labels.has(key) || !/^[a-f0-9]{6}$/i.test(color)) invalid('Invalid or duplicate label');
    const label: Label = { id: ++this.nextId, name, color, description: typeof data.description === 'string' ? data.description : null };
    repo.labels.set(key, label); return label;
  }
  createIssue(repo: Repository, data: Record<string, any>) {
    const title = text(data.title, 'title');
    if (!repo.info.has_issues) invalid('Issues are disabled');
    const labels = data.labels === undefined ? [] : this.labels(repo, data.labels);
    const id = ++this.nextId, number = ++repo.serial;
    const issue: Issue = { id, node_id: `I_${id}`, number, title, body: typeof data.body === 'string' ? data.body : null, state: 'open', labels, user: this.owner, created_at: this.now, updated_at: this.now, closed_at: null, comments: 0 };
    repo.issues.set(number, issue); this.nodes.set(issue.node_id, { repo, kind: 'Issue', entity: issue }); return issue;
  }
  labels(repo: Repository, names: unknown): Label[] {
    if (!Array.isArray(names)) return invalid('labels must be an array');
    return names.map(name => repo.labels.get(text(name, 'label').toLowerCase()) ?? invalid(`Unknown label: ${name}`));
  }
  updateIssue(repo: Repository, issue: Issue, input: Record<string, any>) {
    const labels = input.labels === undefined ? issue.labels : this.labels(repo, input.labels);
    const title = input.title === undefined ? issue.title : text(input.title, 'title');
    if (input.state !== undefined && !['open', 'closed'].includes(input.state)) invalid('Invalid state');
    issue.title = title; issue.labels = labels;
    if (typeof input.body === 'string' || input.body === null) issue.body = input.body;
    if (input.state) { issue.state = input.state; issue.closed_at = issue.state === 'closed' ? this.now : null; }
    issue.updated_at = this.now; repo.issueViews.delete(issue);
    return issue;
  }
  listIssues(repo: Repository, state = 'open', direction = 'desc') {
    const issues = [...repo.issues.values()].filter(i => state === 'all' || i.state === state);
    return direction === 'asc' ? issues : issues.reverse();
  }
  addComment(repo: Repository, issue: Issue, value: unknown) {
    const body = text(value, 'body'), id = ++this.nextId;
    const comment: Comment = { id, node_id: `C_${id}`, body, user: this.owner, created_at: this.now, updated_at: this.now };
    const comments = repo.comments.get(issue.number) ?? [];
    comments.push(comment); repo.comments.set(issue.number, comments);
    issue.comments++; issue.updated_at = this.now; repo.issueViews.delete(issue);
    this.nodes.set(comment.node_id, { repo, kind: 'IssueComment', entity: comment }); return comment;
  }
  createPull(repo: Repository, data: Record<string, any>) {
    const title = text(data.title, 'title'), headName = text(data.head, 'head'), base = text(data.base, 'base');
    const [owner, branch] = headName.includes(':') ? headName.split(':', 2) : [this.owner.login, headName];
    const headSha = repo.refs.get(`refs/heads/${branch}`), baseSha = repo.refs.get(`refs/heads/${base}`);
    if (owner.toLowerCase() !== this.owner.login.toLowerCase() || !headSha || !baseSha || branch === base) return invalid('Invalid head or base');
    const id = ++this.nextId, number = ++repo.serial;
    const pull: Pull = { id, node_id: `P_${id}`, number, title, body: typeof data.body === 'string' ? data.body : null, state: 'open', head: { ref: branch, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, merged_at: null, merge_commit_sha: null, user: this.owner, created_at: this.now };
    repo.pulls.set(number, pull); this.nodes.set(pull.node_id, { repo, kind: 'PullRequest', entity: pull }); return pull;
  }
  pullView(repo: Repository, pull: Pull) {
    const c = repo.compare(pull);
    return { ...pull, head: { ...pull.head, sha: c.head }, base: { ...pull.base, sha: c.base }, mergeable: pull.state === 'open' ? !c.conflict : null };
  }
  merge(repo: Repository, pull: Pull, data: Record<string, any> = {}) {
    if (pull.state !== 'open') throw new Fault(405, 'Pull request is closed');
    const c = repo.compare(pull);
    if (data.sha && data.sha !== c.head) throw new Fault(409, 'Head SHA changed');
    if (c.conflict || !repo.refs.has(`refs/heads/${pull.base.ref}`) || !repo.refs.has(`refs/heads/${pull.head.ref}`)) throw new Fault(405, 'Pull request cannot be merged');
    for (const path of c.changed) {
      const entry = c.after.get(path);
      if (entry) c.current.set(path, entry); else c.current.delete(path);
    }
    let sha: string;
    try { sha = repo.commit(c.current, c.base, pull.base.ref, data.commit_title ?? `${pull.title} (#${pull.number})`, this.now); }
    catch (e) { if (e instanceof Fault && e.status === 409) throw new Fault(405, 'Pull request cannot be merged'); throw e; }
    pull.base.sha = c.base; pull.head.sha = c.head;
    pull.state = 'closed'; pull.merged = true; pull.merged_at = this.now; pull.merge_commit_sha = sha;
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }
}
