import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { advertise, receive, upload } from './git-http.ts';
import { Forge, Fault } from './store.ts';
import { rest, type Reply } from './rest.ts';
import { graphql } from './graphql.ts';
import { mcp, mcpParseError } from './mcp.ts';

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size <= limit) parts.push(part);
      else { parts.length = 0; reject(new Fault(413, 'Request body too large')); }
    });
    req.once('end', () => resolve(parts.length === 1 ? parts[0] : Buffer.concat(parts)));
    req.once('error', reject);
  });
}
const parsedJson = (body: Buffer) => body.length ? JSON.parse(body.toString()) : undefined;
const notFound = { status: 404, value: { message: 'Not Found' } };

export function createForgeServer({ token, owner, now }: { token: string; owner: string; now?: string }) {
  if (!token) throw Error('A token is required');
  const time = now && Number.isFinite(Date.parse(now)) ? new Date(now).toISOString() : '1970-01-01T00:00:00.000Z';
  const forge = new Forge(owner, time);
  const auth = `Bearer ${token}`;
  let serial = 0;
  return createServer({ noDelay: true, keepAliveTimeout: 10000 }, (req, res) => {
    const method = req.method ?? 'GET';
    const matches = /^\/([^/?]+)\/([^/?]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)(?:\?|$)/.exec(req.url ?? '');
    const requestId = (++serial).toString(16);
    res.sendDate = false;
    function json(reply: Reply) {
      const bytes = reply.serialized ?? (reply.value === undefined ? '' : JSON.stringify(reply.value));
      res.statusCode = reply.status;
      res.setHeader('X-GitHub-Request-Id', requestId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (reply.status !== 204) res.setHeader('Content-Length', Buffer.byteLength(bytes));
      if (reply.headers) for (const [key, value] of Object.entries(reply.headers)) res.setHeader(key, value);
      res.end(bytes);
    }
    function binary(res: ServerResponse, service: string, kind: string, bytes: Buffer) {
      res.writeHead(200, { 'Content-Type': `application/x-${service}-${kind}`, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
      res.end(bytes);
    }
    function fail(error: unknown) {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof Fault) json({ status: error.status, value: { message: error.message } });
      else if (error instanceof SyntaxError || error instanceof URIError) json({ status: 400, value: { message: 'Malformed request' } });
      else { console.error(error); json({ status: 500, value: { message: 'Internal server error' } }); }
    }
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/healthz' && method === 'GET') return json({ status: 200, value: { ok: true } });
      if (req.headers.authorization !== auth) {
        req.resume();
        return json({ status: 401, headers: { 'WWW-Authenticate': 'Bearer' }, value: { message: 'Bad credentials' } });
      }
      if (matches) {
        const repo = forge.lookup(decodeURIComponent(matches[1]), decodeURIComponent(matches[2]));
        if (!repo) { req.resume(); return json(notFound); }
        const route = matches[3], isV2 = /(?:^|:)version=2(?:$|:)/.test(String(req.headers['git-protocol'] ?? ''));
        if (route === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json(notFound);
          return binary(res, service, 'advertisement', advertise(repo, service, isV2));
        }
        if (route !== 'info/refs' && method === 'POST') {
          void readBody(req, 64 * 1024 * 1024).then(body => {
            let reply;
            try { reply = route === 'git-upload-pack' ? upload(repo, body, isV2) : receive(repo, body); }
            catch { throw new Fault(400, 'Malformed Git request'); }
            binary(res, route, 'result', reply);
          }).catch(fail);
          return;
        }
        return json(notFound);
      }
      if (method === 'GET' || method === 'HEAD') {
        if (url.pathname === '/mcp') return json({ status: 405, headers: { Allow: 'POST' }, value: { message: 'Streaming GET not supported' } });
        return json(rest(forge, method, url));
      }
      void readBody(req, 2 * 1024 * 1024).then(raw => {
        if (url.pathname === '/mcp' && method === 'POST') {
          let request;
          try { request = JSON.parse(raw.toString()); } catch { return json(mcpParseError()); }
          const protocol = req.headers['mcp-protocol-version'];
          return json(mcp(forge, request, typeof protocol === 'string' ? protocol : undefined));
        }
        const input = parsedJson(raw);
        return json(url.pathname === '/api/graphql' && method === 'POST' ? { status: 200, value: graphql(forge, input) } : rest(forge, method, url, input));
      }).catch(fail);
    } catch (error) { fail(error); }
  });
}
