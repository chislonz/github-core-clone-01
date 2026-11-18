import { Forge, Repository, Fault, missing, invalid, text, record } from './store.ts';
import { commitInfo, isOid, treeEntries } from './objects.ts';
import { validRef } from './git-http.ts';

export type Reply = { status: number; value?: any; headers?: Record<string, string>; serialized?: string };
const ok = (value: unknown, status = 200): Reply => ({ status, value });
const refView = (ref: string, sha: string, type = 'commit') => ({ ref, object: { type, sha } });
const branchView = (name: string, sha: string) => ({ name, commit: { sha }, protected: false });

function page(values: unknown[], url: URL): Reply {
  const number = (v: string | null, alt: number) => v && /^\d+$/.test(v) ? Math.max(1, Number(v)) : alt;
  const size = Math.min(100, number(url.searchParams.get('per_page'), 30));
  const index = number(url.searchParams.get('page'), 1), last = Math.ceil(values.length / size);
  const result = ok(values.slice((index - 1) * size, index * size));
  const link = (n: number, rel: string) => {
    const dest = new URL(url); dest.searchParams.set('page', String(n));
    return `<${dest.href}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (index < last) links.push(link(index + 1, 'next'), link(last, 'last'));
  if (index > 1) links.push(link(index - 1, 'prev'), link(1, 'first'));
  if (links.length) result.headers = { Link: links.join(', ') };
  return result;
}

function pathSegments(pathname: string) {
  try { return pathname.replace(/^\//, '').replace(/\/$/, '').split('/').map(decodeURIComponent); }
  catch { throw new Fault(400, 'Invalid path encoding'); }
}

function contentView(repo: Repository, path: string, entry: { mode: string; oid: string }, includeBytes: boolean) {
  const obj = repo.db.get(entry.oid);
  const type = entry.mode.endsWith('000') && entry.mode.startsWith('0') || entry.mode === '40000' ? 'dir' : entry.mode === '120000' ? 'symlink' : entry.mode === '160000' ? 'submodule' : 'file';
  return { type, name: path.split('/').at(-1), path, sha: entry.oid, size: type === 'dir' ? 0 : obj?.data.length ?? 0,
    ...(includeBytes && obj?.kind === 'blob' ? { encoding: 'base64', content: obj.data.toString('base64') } : {}) };
}
function contents(forge: Forge, repo: Repository, method: string, url: URL, parts: string[], body: Record<string, any>): Reply {
  if (parts.length > 128 || parts.some(p => !p || p === '.' || p === '..' || /[\x00\\]/.test(p))) return invalid('Invalid contents path');
  const path = parts.join('/');
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const sha = repo.tip(ref) ?? missing();
    let tree = repo.tree(sha);
    for (const [i, part] of parts.entries()) {
      const entry = treeEntries(repo.db.get(tree)!.data).find(e => e.name === part);
      if (!entry) return missing();
      if (!/^0?40000$/.test(entry.mode)) return i === parts.length - 1 ? ok(contentView(repo, path, entry, true)) : missing();
      tree = entry.oid;
    }
    return ok(treeEntries(repo.db.get(tree)!.data).map(e => contentView(repo, path ? `${path}/${e.name}` : e.name, e, false)));
  }
  if (method !== 'PUT' && method !== 'DELETE') return missing();
  if (!path) return invalid('Path is required');
  const branch = body.branch ?? repo.defaultBranch;
  if (typeof branch !== 'string' || !validRef(`refs/heads/${branch}`)) return invalid('Invalid branch');
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? (method === 'PUT' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : undefined);
  const files = repo.snapshot(parent), previous = files.get(path);
  const message = text(body.message, 'message');
  if (method === 'DELETE') {
    if (!previous) return missing();
    if (body.sha !== previous.oid) throw new Fault(409, 'SHA does not match');
    files.delete(path);
    return ok({ content: null, commit: { sha: repo.commit(files, parent, branch, message, forge.now) } });
  }
  if (previous ? body.sha !== previous.oid : body.sha !== undefined) throw new Fault(409, 'SHA does not match');
  const encoded = typeof body.content === 'string' ? body.content.replace(/\s/g, '') : null;
  if (encoded === null || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)$/.test(encoded)) return invalid('content must be base64');
  const oid = repo.db.put('blob', Buffer.from(encoded, 'base64'));
  const entry = { oid, mode: previous?.mode === '100755' ? '100755' : '100644' };
  files.set(path, entry);
  const commit = repo.commit(files, parent, branch, message, forge.now);
  return ok({ content: { ...contentView(repo, path, entry, true) }, commit: { sha: commit } }, previous ? 200 : 201);
}

export function rest(forge: Forge, method: string, url: URL, input?: unknown): Reply {
  const body = record(input);
  const [api, version, area, owner, name, resource, ...parts] = pathSegments(url.pathname);
  if (api !== 'api' || version !== 'v3') return missing();
  const query = url.searchParams;
  if (!area && method === 'GET') return { ...ok({ current_user_url: `${url.origin}/api/v3/user`, current_user_repositories_url: `${url.origin}/api/v3/user/repos` }), headers: { 'X-OAuth-Scopes': 'repo, read:org' } };
  if (area === 'meta' && !owner && method === 'GET') return ok({ installed_version: '1.0.0' });
  if (area === 'user' && !owner && method === 'GET') return ok(forge.owner);
  if (area === 'user' && owner === 'repos' && !name) {
    if (method === 'GET') return page([...forge.repos.values()].map(r => r.info), url);
    if (method === 'POST') return ok(forge.createRepo(body).info, 201);
  }
  if (area !== 'repos' || !name) return missing();
  const repo = forge.repo(owner, name);
  if (!resource) {
    if (method === 'GET') return ok(repo.info);
    if (method === 'PATCH') {
      if (typeof body.description === 'string' || body.description === null) repo.info.description = body.description;
      if (typeof body.private === 'boolean') repo.info.private = body.private;
      if (typeof body.has_issues === 'boolean') repo.info.has_issues = body.has_issues;
      return ok(repo.info);
    }
    if (method === 'DELETE') { forge.removeRepo(repo); return { status: 204 }; }
  }
  if (resource === 'branches' && method === 'GET') {
    if (parts.length) {
      const name = parts.join('/');
      return ok(branchView(name, repo.refs.get(`refs/heads/${name}`) ?? missing()));
    }
    return page([...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => branchView(ref.slice(11), sha)), url);
  }
  if (resource === 'git' && parts[0] === 'refs') {
    const ref = `refs/${parts.slice(1).join('/')}`;
    if (method === 'POST' && parts.length === 1) {
      const { ref, sha } = body;
      if (!validRef(ref) || !isOid(sha) || !repo.db.get(sha) || repo.refs.has(ref) || (ref.startsWith('refs/heads/') && repo.db.get(sha)?.kind !== 'commit')) return invalid('Invalid or duplicate ref');
      repo.refs.set(ref, sha); return ok(refView(ref, sha, repo.db.get(sha)!.kind), 201);
    }
    if (method === 'GET' && parts.length > 1) { const sha = repo.refs.get(ref) ?? missing(); return ok(refView(ref, sha, repo.db.get(sha)!.kind)); }
  }
  if (resource === 'commits' && method === 'GET' && parts.length <= 1) {
    const view = (sha: string) => {
      const obj = repo.db.get(sha);
      if (obj?.kind !== 'commit') return missing();
      const { message, tree, parents } = commitInfo(obj);
      return { sha, commit: { message: message.trimEnd(), tree: { sha: tree } }, parents: parents.map(sha => ({ sha })) };
    };
    const ref = parts[0] ?? query.get('sha') ?? repo.defaultBranch;
    const found = repo.tip(ref);
    if (!found && (parts.length || query.has('sha'))) return missing();
    if (parts.length) return ok(view(repo.db.peel(found!)));
    return page(found ? [...repo.db.ancestors([repo.db.peel(found)])].map(view) : [], url);
  }
  if (resource === 'contents') return contents(forge, repo, method, url, parts, body);
  if (resource === 'labels' && !parts.length) {
    if (method === 'POST') return ok(forge.label(repo, body), 201);
    if (method === 'GET') return page([...repo.labels.values()], url);
  }
  if (resource === 'issues') {
    if (!parts.length) {
      if (method === 'POST') return ok(forge.createIssue(repo, body), 201);
      if (method === 'GET') {
        let rows = forge.listIssues(repo, query.get('state') ?? 'open', query.get('direction') ?? 'desc');
        const labels = query.get('labels')?.split(',');
        if (labels) rows = rows.filter(i => labels.every(l => i.labels.some(label => label.name === l)));
        return page(rows, url);
      }
    } else {
      const issue = forge.issue(repo, /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN);
      if (parts.length === 1 && method === 'GET') {
        let serialized = repo.issueViews.get(issue);
        if (!serialized) { serialized = JSON.stringify(issue); repo.issueViews.set(issue, serialized); }
        return { status: 200, value: issue, serialized };
      }
      if (parts.length === 1 && method === 'PATCH') return ok(forge.updateIssue(repo, issue, body));
      if (parts.length === 2 && parts[1] === 'comments') {
        if (method === 'GET') return page(repo.comments.get(issue.number) ?? [], url);
        if (method === 'POST') return ok(forge.addComment(repo, issue, body.body), 201);
      }
    }
  }
  if (resource === 'pulls') {
    if (!parts.length) {
      if (method === 'POST') return ok(forge.pullView(repo, forge.createPull(repo, body)), 201);
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        return page([...repo.pulls.values()].reverse().filter(p => state === 'all' || p.state === state).map(p => forge.pullView(repo, p)), url);
      }
    } else {
      const pull = forge.pull(repo, /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN);
      if (parts.length === 1 && method === 'GET') return ok(forge.pullView(repo, pull));
      if (parts.length === 2 && parts[1] === 'files' && method === 'GET') return page(repo.files(pull), url);
      if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') return ok(forge.merge(repo, pull, body));
    }
  }
  return missing();
}
