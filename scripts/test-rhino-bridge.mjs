// Mock-server test for local-app-bridge framed mode + rhino wire shapes (no Rhino needed).
// Run from repo root AFTER tsc build:  node <thisfile> <repoRoot>
// Exercises: framed roundtrip, error passthrough, split frames, legacy-unframed
// detection, invalid frame length, timeout, queue integrity, raw-mode regression, ping.
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const { LocalAppBridge } = await import(pathToFileURL(path.join(repo, 'hub', 'dist', 'lib', 'local-app-bridge.js')).href);

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failures++; };

const frame = (obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
};

// Mock rhinomcp plugin: framed requests in, framed responses out.
const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 4) return;
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) return;
    const cmd = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = Buffer.alloc(0);
    if (cmd.type === 'get_document_summary') {
      sock.end(frame({ status: 'success', result: { object_count: 3, layers: ['Default'] } }));
    } else if (cmd.type === 'boom') {
      sock.end(frame({ status: 'error', message: 'kaboom' }));
    } else if (cmd.type === 'capture_viewport') {
      // 1x1 transparent PNG, echoing the plugin's inline-base64 contract.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      sock.end(frame({ status: 'success', result: { image_data: png, mime_type: 'image/png', width: cmd.params.width, height: cmd.params.height, viewport_name: cmd.params.viewport } }));
    } else if (cmd.type === 'chunky') {
      // Split one large frame across writes: header alone, then payload halves.
      const whole = frame({ status: 'success', result: { big: 'x'.repeat(20000) } });
      sock.write(whole.subarray(0, 4));
      setTimeout(() => sock.write(whole.subarray(4, 9000)), 30);
      setTimeout(() => { sock.write(whole.subarray(9000)); sock.end(); }, 60);
    } else if (cmd.type === 'legacy') {
      // Bare JSON where a header should be — pre-framing plugin.
      sock.end(Buffer.from(JSON.stringify({ status: 'success', result: {} })));
    } else if (cmd.type === 'badlen') {
      const h = Buffer.alloc(4);
      h.writeUInt32BE(0xffffffff, 0); // ~4 GiB claimed length
      sock.end(Buffer.concat([h, Buffer.from('{}')]));
    } else if (cmd.type === 'nullres') {
      sock.end(frame({ status: 'success', result: null }));
    } else if (cmd.type === 'junky') {
      // Complete frame + trailing junk in one write — must still parse.
      sock.end(Buffer.concat([frame({ status: 'success', result: { ok: 1 } }), Buffer.from('trailing-garbage')]));
    } else if (cmd.type === 'slow') { /* never reply */ }
    else sock.end(frame({ status: 'error', message: 'unknown' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const bridge = new LocalAppBridge({ host: '127.0.0.1', port, framing: 'framed' });

// 1. framed success roundtrip
const r1 = await bridge.send({ type: 'get_document_summary' });
check('framed success roundtrip', r1?.object_count === 3);

// 2. error passthrough
const r2 = await bridge.send({ type: 'boom' }).then(() => null, (e) => e);
check('framed error passthrough', r2 instanceof Error && r2.message.includes('kaboom'));

// 3. capture_viewport shape (inline base64 decodes to PNG magic)
const r3 = await bridge.send({ type: 'capture_viewport', params: { viewport: 'active', width: 800, height: 600 } });
const png = Buffer.from(r3?.image_data ?? '', 'base64');
check('viewport inline base64 decodes', png.length > 0 && png[0] === 0x89 && png[1] === 0x50);

// 4. frame split across writes (header separated from payload)
const r4 = await bridge.send({ type: 'chunky' });
check('split-frame accumulation', r4?.big?.length === 20000);

// 5. legacy unframed response detected with actionable error
const r5 = await bridge.send({ type: 'legacy' }, { timeoutMs: 2000 }).then(() => null, (e) => e);
check('legacy unframed detected', r5 instanceof Error && /unframed|predates/.test(r5.message));

// 6. invalid frame length rejected
const r6 = await bridge.send({ type: 'badlen' }, { timeoutMs: 2000 }).then(() => null, (e) => e);
check('invalid frame length rejected', r6 instanceof Error && /frame length/.test(r6.message));

// 7. timeout
const r7 = await bridge.send({ type: 'slow' }, { timeoutMs: 300 }).then(() => null, (e) => e);
check('timeout', r7 instanceof Error && r7.message.includes('timed out'));

// 8. queue survives failures
const r8 = await bridge.send({ type: 'get_document_summary' });
check('queue not poisoned after failures', r8?.object_count === 3);

// 9. ping
check('ping true on live port', (await bridge.ping(500)) === true);
const dead = new LocalAppBridge({ host: '127.0.0.1', port: 1, framing: 'framed' });
check('ping false on dead port', (await dead.ping(500)) === false);

// 10. raw-mode regression: default framing still speaks bare JSON (blender/gimp path)
const rawServer = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let cmd; try { cmd = JSON.parse(buf); } catch { return; }
    buf = '';
    if (cmd.type === 'ok') sock.end(JSON.stringify({ status: 'success', result: { echo: cmd.params } }));
  });
});
await new Promise((r) => rawServer.listen(0, '127.0.0.1', r));
const rawBridge = new LocalAppBridge({ host: '127.0.0.1', port: rawServer.address().port });
const r10 = await rawBridge.send({ type: 'ok', params: { a: 1 } });
check('raw mode regression (blender/gimp dialect)', r10?.echo?.a === 1);
rawServer.close();

// 11. null result stays null (Grok fix #6)
const r11 = await bridge.send({ type: 'nullres' });
check('null result not coerced to {}', r11 === null);

// 12. complete frame with trailing junk in the same chunk (Grok fix #2)
const r12 = await bridge.send({ type: 'junky' });
check('frame + trailing junk parses', r12?.ok === 1);

// 13. framing is part of the instance cache key (Grok fix #1)
check('raw and framed instances distinct on same port',
  LocalAppBridge.for('127.0.0.1', port) !== LocalAppBridge.for('127.0.0.1', port, { framing: 'framed' }));

server.close();
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
