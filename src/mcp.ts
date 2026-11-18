import { Forge, Fault, record } from './store.ts';
import type { Reply } from './rest.ts';

const revision = '2026-07-28', legacy = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const identity = { serverInfo: { name: 'in-memory-forge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } };
function tool(name: string, description: string, required: string[], optional: string[] = []) {
  const properties = Object.fromEntries([...required, ...optional].map(p => [p, { type: p === 'pull_number' ? 'integer' : p === 'private' ? 'boolean' : p === 'labels' ? 'array' : 'string' }]));
  return { name, description, inputSchema: { type: 'object', properties, required } };
}
const tools = [
  tool('create_repo', 'Create an empty repository for the authenticated owner.', ['name'], ['description', 'private']),
  tool('get_repo', 'Read repository metadata.', ['owner', 'repo']),
  tool('create_issue', 'Open an issue in a repository.', ['owner', 'repo', 'title'], ['body', 'labels']),
  tool('list_issues', 'List issues by state: open, closed, or all.', ['owner', 'repo'], ['state']),
  tool('create_pull_request', 'Open a pull request between two existing branches.', ['owner', 'repo', 'title', 'head', 'base'], ['body']),
  tool('merge_pull_request', 'Squash a pull request into its base branch.', ['owner', 'repo', 'pull_number']),
];

const rpc = (id: unknown) => ({ jsonrpc: '2.0', id });
function error(id: unknown, code: number, message: string, status = 200): Reply { return { status, value: { ...rpc(id), error: { code, message } } }; }
export const mcpParseError = () => error(null, -32700, 'Parse error', 400);
export function mcp(forge: Forge, request: unknown, protocol?: string): Reply {
  const message = record(request), id = message.id ?? null;
  const method = message.method, params = record(message.params);
  if (message.jsonrpc !== '2.0' || typeof method !== 'string' || ![null, 'string', 'number'].includes(id === null ? null : typeof id)) return error(null, -32600, 'Invalid Request', 400);
  const meta = record(params._meta);
  const version = protocol ?? meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
  if (version && version !== revision && !legacy.includes(version) && !['initialize', 'server/discover'].includes(method)) return error(id, -32602, 'Unsupported protocol version', 400);
  if (!Object.hasOwn(message, 'id')) return { status: 202 };
  const reply = (result: unknown): Reply => ({ status: 200, value: { ...rpc(id), result } });
  if (method === 'server/discover') return reply({ ...identity, supportedVersions: [revision, ...legacy] });
  if (method === 'initialize') return reply({ ...identity, protocolVersion: legacy.includes(params.protocolVersion) ? params.protocolVersion : legacy[0] });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools });
  if (method !== 'tools/call') return error(id, -32601, 'Method not found');
  const def = tools.find(t => t.name === params.name), args = record(params.arguments);
  if (!def) return error(id, -32602, 'Unknown tool');
  for (const field of def.inputSchema.required) if (!Object.hasOwn(args, field)) return error(id, -32602, `Missing argument: ${field}`);
  for (const [field, spec] of Object.entries(def.inputSchema.properties)) {
    if (!Object.hasOwn(args, field)) continue;
    const type = spec.type, value = args[field];
    const valid = type === 'integer' ? Number.isSafeInteger(value) : type === 'array' ? Array.isArray(value) : typeof value === type;
    if (!valid) return error(id, -32602, `Invalid argument: ${field}`);
  }
  try {
    let value: unknown;
    if (def.name === 'create_repo') value = forge.createRepo(args).info;
    else {
      const repo = forge.repo(args.owner, args.repo);
      switch (def.name) {
        case 'get_repo': value = repo.info; break;
        case 'create_issue': value = forge.createIssue(repo, args); break;
        case 'list_issues': value = { issues: forge.listIssues(repo, args.state) }; break;
        case 'create_pull_request': value = forge.pullView(repo, forge.createPull(repo, args)); break;
        case 'merge_pull_request': value = forge.merge(repo, forge.pull(repo, args.pull_number)); break;
      }
    }
    return reply({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] });
  } catch (e) {
    if (!(e instanceof Fault)) throw e;
    return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
  }
}
