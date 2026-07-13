// Mock-server test for local-app-bridge + blender adapter (no Blender needed).
// Run from repo root AFTER tsc build:  node <thisfile> <repoRoot>
// Exercises: success roundtrip, error passthrough, chunked JSON, timeout, unreachable, serialization.
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const { LocalAppBridge } = await import(pathToFileURL(path.join(repo, 'hub', 'dist', 'lib', 'local-app-bridge.js')).href);

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };

// Mock add-on: replies per command type.
const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let cmd; try { cmd = JSON.parse(buf); } catch { return; }
    buf = '';
    if (cmd.type === 'ok') sock.end(JSON.stringify({ status: 'success', result: { echo: cmd.params } }));
    else if (cmd.type === 'boom') sock.end(JSON.stringify({ status: 'error', message: 'kaboom' }));
    else if (cmd.type === 'chunky') {
      const payload = JSON.stringify({ status: 'success', result: { big: 'x'.repeat(20000) } });
      sock.write(payload.slice(0, 5000));
      setTimeout(() => { sock.write(payload.slice(5000)); sock.end(); }, 50);
    } else if (cmd.type === 'slow') { /* never reply */ }
    else sock.end(JSON.stringify({ status: 'error', message: 'unknown' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const bridge = new LocalAppBridge({ host: '127.0.0.1', port });

// 1. success roundtrip
const r1 = await bridge.send({ type: 'ok', params: { a: 1 } });
check('success roundtrip', r1?.echo?.a === 1);

// 2. error passthrough
const r2 = await bridge.send({ type: 'boom' }).then(() => null, (e) => e);
check('error passthrough', r2 instanceof Error && r2.message.includes('kaboom'));

// 3. chunked response
const r3 = await bridge.send({ type: 'chunky' });
check('chunked JSON accumulation', r3?.big?.length === 20000);

// 4. timeout (short)
const r4 = await bridge.send({ type: 'slow' }, { timeoutMs: 300 }).then(() => null, (e) => e);
check('timeout', r4 instanceof Error && r4.message.includes('timed out'));

// 5. queue survives failure (serialization + no poisoning)
const r5 = await bridge.send({ type: 'ok', params: { b: 2 } });
check('queue not poisoned after failure', r5?.echo?.b === 2);

// 6. unreachable port
const dead = new LocalAppBridge({ host: '127.0.0.1', port: 1 });
const r6 = await dead.send({ type: 'ok' }, { timeoutMs: 2000 }).then(() => null, (e) => e);
check('unreachable -> clear error', r6 instanceof Error && /not reachable|socket error/.test(r6.message));
const r7 = await dead.ping(500);
check('ping false on dead port', r7 === false);
const r8 = await bridge.ping(500);
check('ping true on live port', r8 === true);

// 9. non-loopback host rejected (fail closed)
let r9 = null;
try { new LocalAppBridge({ host: '192.168.1.10', port: 9876 }); } catch (e) { r9 = e; }
check('non-loopback host rejected', r9 instanceof Error && r9.message.includes('loopback'));

// 10. shared instance per endpoint
check('LocalAppBridge.for shares instances',
  LocalAppBridge.for('127.0.0.1', port) === LocalAppBridge.for('127.0.0.1', port));

// 11. serialization across the shared instance (two concurrent sends arrive in order)
const shared = LocalAppBridge.for('127.0.0.1', port);
const order = [];
await Promise.all([
  shared.send({ type: 'ok', params: { n: 1 } }).then(() => order.push(1)),
  shared.send({ type: 'ok', params: { n: 2 } }).then(() => order.push(2)),
]);
check('queue serializes concurrent sends', order[0] === 1 && order[1] === 2);

server.close();
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
