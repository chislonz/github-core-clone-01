import { type ObjectDB, type GitObject, ZERO, isOid, links, readPack, writePack } from './objects.ts';

export type GitRepo = { db: ObjectDB; refs: Map<string, string>; defaultBranch: string };
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
const empty = Buffer.alloc(0);
const maximum = 65520;
export const headRef = (repo: GitRepo) => `refs/heads/${repo.defaultBranch}`;
export const validRef = (s: unknown): s is string => typeof s === 'string' && /^refs\/(heads|tags)\/.+/.test(s) && !/[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\//.test(s) && s.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));

export function pkt(s: string | Buffer) {
  const body = typeof s === 'string' ? Buffer.from(s) : s;
  if (body.length > maximum - 4) throw Error('Packet too large');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
function packetAt(buf: Buffer, p: number) {
  const prefix = buf.toString('ascii', p, p + 4);
  if (!/^[\da-f]{4}$/i.test(prefix)) throw Error('Invalid pkt-line length');
  const n = Number.parseInt(prefix, 16);
  if (n === 3 || n > maximum || p + Math.max(n, 4) > buf.length) throw Error('Invalid pkt-line bounds');
  return { n, next: p + Math.max(n, 4), text: n >= 4 ? buf.toString('utf8', p + 4, p + n).replace(/\n$/, '') : '' };
}
function sideband(body: Buffer) {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += maximum - 5) {
    const end = Math.min(offset + maximum - 5, body.length);
    const frame = Buffer.allocUnsafe(end - offset + 5);
    frame.write(frame.length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    frame[4] = 1;
    body.copy(frame, 5, offset, end);
    parts.push(frame);
  }
  return parts;
}
const v2Advert = Buffer.concat(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat(flush));
export function advertise(repo: GitRepo, service: string, v2: boolean) {
  if (service === 'git-upload-pack' && v2) return v2Advert;
  const upload = service === 'git-upload-pack';
  const target = headRef(repo), tip = repo.refs.get(target);
  const refs = [...repo.refs];
  if (upload && tip) refs.unshift(['HEAD', tip]);
  if (!refs.length && !upload) refs.push(['capabilities^{}', ZERO]);
  const capabilities = upload ? `side-band-64k ofs-delta shallow symref=HEAD:${target}` : 'report-status side-band-64k delete-refs ofs-delta';
  const reply = [pkt(`# service=${service}\n`), flush];
  for (const [i, [name, oid]] of refs.entries()) {
    reply.push(pkt(`${oid} ${name}${i === 0 ? '\0' + capabilities : ''}\n`));
    if (upload && name.startsWith('refs/tags/')) {
      const peeled = repo.db.peel(oid);
      if (peeled !== oid) reply.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  return Buffer.concat([...reply, flush]);
}

export function receive(repo: GitRepo, body: Buffer) {
  const commands: [string, string, string][] = [];
  let caps: string[] = [], p = 0;
  for (;;) {
    const line = packetAt(body, p); p = line.next;
    if (!line.n) break;
    if (line.n < 4) throw Error('Invalid receive command');
    const [command, capabilities] = line.text.split('\0');
    if (!commands.length && capabilities) caps = capabilities.trim().split(' ');
    const [old, next, ref, extra] = command.split(' ');
    if (!isOid(old) || !isOid(next) || !validRef(ref) || extra !== undefined) throw Error('Invalid ref update');
    commands.push([old, next, ref]);
  }
  if (!commands.length) return empty;
  let incoming = new Map<string, GitObject>(), unpackError = '';
  try {
    if (p < body.length) incoming = readPack(body.subarray(p), repo.db);
    for (const obj of incoming.values()) {
      for (const target of links(obj)) {
        if (!incoming.has(target) && !repo.db.get(target)) throw Error('Missing object');
      }
    }
  } catch { unpackError = 'invalid pack'; }
  const report = [pkt(`unpack ${unpackError || 'ok'}\n`)];
  if (!unpackError && incoming.size) {
    repo.db.import(incoming);
    invalidateGitViews(repo);
  }
  for (const [old, next, ref] of commands) {
    const actual = repo.refs.get(ref) ?? ZERO;
    let why = unpackError ? 'unpacker error' : '';
    if (!why && actual !== old) why = 'stale info';
    const obj = next === ZERO ? undefined : repo.db.get(next);
    if (!why && next !== ZERO && (!obj || (ref.startsWith('refs/heads/') && obj.kind !== 'commit'))) why = 'invalid object';
    if (!why && next !== ZERO && actual !== ZERO && !repo.db.isAncestor(actual, next)) why = 'non-fast-forward';
    if (!why) {
      if (next === ZERO) repo.refs.delete(ref);
      else repo.refs.set(ref, next);
      invalidateGitViews(repo);
    }
    report.push(pkt(why ? `ng ${ref} ${why}\n` : `ok ${ref}\n`));
  }
  if (!caps.includes('report-status')) return caps.includes('side-band-64k') ? flush : empty;
  const result = Buffer.concat([...report, flush]);
  return caps.includes('side-band-64k') ? Buffer.concat([...sideband(result), flush]) : result;
}

function listRefs(repo: GitRepo, lines: string[]) {
  const prefixes = lines.filter(s => s.startsWith('ref-prefix ')).map(s => s.slice(11));
  const allowed = (ref: string) => !prefixes.length || prefixes.some(prefix => ref.startsWith(prefix));
  const result: Buffer[] = [];
  const target = headRef(repo), tip = repo.refs.get(target);
  if (allowed('HEAD') && (tip || lines.includes('unborn'))) {
    result.push(pkt(`${tip ?? 'unborn'} HEAD${lines.includes('symrefs') || !tip ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [ref, oid] of repo.refs) if (allowed(ref)) {
    const peeled = lines.includes('peel') ? repo.db.peel(oid) : oid;
    result.push(pkt(`${oid} ${ref}${peeled !== oid ? ` peeled:${peeled}` : ''}\n`));
  }
  return Buffer.concat([...result, flush]);
}

// Track commit generations independently of tree/tag reachability. A common shallow
// commit excludes its own snapshot, but not its parents, which the client lacks.
function walk(repo: GitRepo, roots: string[], depth: number, stop: Set<string>) {
  const queue = roots.map(oid => ({ oid, level: 0 }));
  const objects = new Map<string, GitObject>(), boundary = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const { oid, level } = queue[i];
    if (objects.has(oid)) continue;
    const obj = repo.db.get(oid);
    if (!obj) continue;
    objects.set(oid, obj);
    const refs = links(obj);
    if (obj.kind === 'commit') {
      queue.push({ oid: refs[0], level });
      if (stop.has(oid)) continue;
      if (level + 1 < depth) for (const parent of refs.slice(1)) queue.push({ oid: parent, level: level + 1 });
      else if (refs.length > 1) boundary.add(oid);
    } else for (const child of refs) queue.push({ oid: child, level });
  }
  for (const oid of boundary) if (links(objects.get(oid)!).slice(1).every(parent => objects.has(parent))) boundary.delete(oid);
  return { objects, boundary };
}

// Cache complete small v2 replies on immutable repository state. All ref and
// object write paths invalidate them so names, tips, and negotiation stay fresh.
const v2Views = new WeakMap<GitRepo, Map<string, Buffer>>();
export function invalidateGitViews(repo: GitRepo) { v2Views.delete(repo); }
export function upload(repo: GitRepo, body: Buffer, v2: boolean) {
  if (!v2 || body.length > 1024) return buildUpload(repo, body, v2);
  const key = body.toString('latin1');
  let views = v2Views.get(repo);
  const hit = views?.get(key);
  if (hit) return hit;
  const response = buildUpload(repo, body, v2);
  if (response.length <= 256 * 1024) {
    if (!views) { views = new Map(); v2Views.set(repo, views); }
    if (views.size === 8) views.delete(views.keys().next().value!);
    views.set(key, response);
  }
  return response;
}

function buildUpload(repo: GitRepo, body: Buffer, v2: boolean) {
  const lines: string[] = [];
  for (let p = 0; p < body.length;) {
    const packet = packetAt(body, p); p = packet.next;
    if (packet.n >= 4) lines.push(packet.text);
  }
  if (v2 && lines[0] === 'command=ls-refs') return listRefs(repo, lines);
  if (v2 && lines[0] !== 'command=fetch') throw Error('Unknown upload command');
  const named = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).split(' ')[0]);
  const want = named('want '), have = named('have ').filter(id => repo.db.get(id)), shallow = new Set(named('shallow '));
  if (!want.every(id => isOid(id) && repo.db.get(id))) return pkt('ERR not our ref\n');
  const depthWord = named('deepen ')[0];
  const depth = depthWord === undefined ? Infinity : Number(depthWord);
  if (!(depth > 0 && (Number.isInteger(depth) || depth === Infinity))) throw Error('Invalid depth');
  if (v2 && !lines.includes('done')) {
    return Buffer.concat([pkt('acknowledgments\n'), ...(have.length ? have.map(oid => pkt(`ACK ${oid}\n`)) : [pkt('NAK\n')]), flush]);
  }

  const already = have.length ? walk(repo, have, Infinity, shallow).objects : undefined;
  const requested = walk(repo, want, depth, depth === Infinity ? shallow : new Set());
  const objects = [...requested.objects.values()].filter(obj => !already?.has(obj.oid));
  const changes = [...requested.boundary].filter(oid => !shallow.has(oid)).map(oid => pkt(`shallow ${oid}\n`));
  for (const oid of shallow) {
    if (requested.objects.has(oid) && !requested.boundary.has(oid) && links(requested.objects.get(oid)!).slice(1).every(p => requested.objects.has(p))) changes.push(pkt(`unshallow ${oid}\n`));
  }
  const pack = writePack(objects);
  let result: Buffer;
  if (v2) {
    result = Buffer.concat([...(changes.length ? [pkt('shallow-info\n'), ...changes, delim] : []), pkt('packfile\n'), ...sideband(pack), flush]);
  } else {
    const cap = lines.find(line => line.startsWith('want '))?.split(' ').slice(2) ?? [];
    const prefix = [...(depthWord !== undefined ? [...changes, flush] : []), pkt(have.length ? `ACK ${have.at(-1)}\n` : 'NAK\n')];
    result = Buffer.concat([...prefix, ...(cap.includes('side-band-64k') ? [...sideband(pack), flush] : [pack])]);
  }
  return result;
}
