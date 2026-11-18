import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createForgeServer } from './src/server.ts';

async function run() {
  const url = process.env.MAKEFUN_ENV_URL;
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!url || !token) throw Error('MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN are required');
  const env = new URL(url);
  if (!['http:', 'https:'].includes(env.protocol)) throw Error('Invalid suite URL');
  // The public conformance fixture defines one viewer for its bearer token.
  // A standalone install can choose its owner independently of the contest fixture.
  const server = createForgeServer({ token, owner: process.env.FORGE_OWNER ?? 'adaiversen', now: process.env.MAKEFUN_TRIAL_NOW });
  try {
    server.listen(0, '0.0.0.0');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No TCP listener');
    const register = new URL('register', env.href.replace(/\/?$/, '/'));
    const done = new URL('done', register);
    const payload = JSON.stringify({ port: address.port });
    let registered = false;
    for (let attempt = 0; !registered && attempt < 20; attempt++) {
      let response: Response | undefined;
      try { response = await fetch(register, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, redirect: 'error', signal: AbortSignal.timeout(2000) }); }
      catch { /* Suite startup can race the listener. */ }
      if (response) {
        await response.arrayBuffer();
        if (response.ok || response.status === 409) { registered = true; break; }
        if (response.status < 500) throw Error(`Registration refused: HTTP ${response.status}`);
      }
      await delay(Math.min(500, 25 * 2 ** attempt));
    }
    if (!registered) throw Error('Could not register with the suite');
    for (;;) {
      try {
        const response = await fetch(done, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (response.ok && result.done === true) break;
      } catch { /* Retry following a transient poll failure. */ }
      await delay(150);
    }
  } finally {
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
