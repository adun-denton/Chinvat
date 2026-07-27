import { test } from 'node:test';
import assert from 'node:assert/strict';
import remoteNode, {
  classifyHost,
  normalizeNodeUrl,
  parseNodes,
  pickNode,
  publicView,
  resolveAll,
  resolveNode,
  unwrapToolResult,
  type ResolvedNode,
} from '../adapters/remote-node.js';
import type { AdapterContext } from '../types.js';

const MESH_URL = 'http://100.101.102.103:7777/mcp';
const TOKEN = 'k'.repeat(32);

function ctx(config: Record<string, unknown>): AdapterContext {
  return { config, dataDir: '/tmp', saveArtifact: async () => 'artifact', log: () => {}, signal: undefined };
}

const oneNode = (extra: Record<string, unknown> = {}) => ({
  nodes: JSON.stringify([{ name: 'gpu-us', url: MESH_URL, token: TOKEN }]),
  ...extra,
});

test('classifies mesh addresses apart from public ones', () => {
  assert.equal(classifyHost('127.0.0.1'), 'loopback');
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('::1'), 'loopback');
  // Tailscale / Headscale hand out 100.64.0.0/10 and fd7a:115c:a1e0::/48
  assert.equal(classifyHost('100.64.0.1'), 'mesh');
  assert.equal(classifyHost('100.101.102.103'), 'mesh');
  assert.equal(classifyHost('100.127.255.255'), 'mesh');
  assert.equal(classifyHost('fd7a:115c:a1e0::1'), 'mesh');
  assert.equal(classifyHost('gpu-us.tail1234.ts.net'), 'mesh');
  // 100.x outside the CGNAT window is ordinary public space
  assert.equal(classifyHost('100.63.255.255'), 'public');
  assert.equal(classifyHost('100.128.0.1'), 'public');
  assert.equal(classifyHost('10.0.0.5'), 'private');
  assert.equal(classifyHost('172.16.0.5'), 'private');
  assert.equal(classifyHost('172.32.0.5'), 'public');
  assert.equal(classifyHost('192.168.1.5'), 'private');
  assert.equal(classifyHost('fd00::1'), 'private');
  assert.equal(classifyHost('8.8.8.8'), 'public');
  assert.equal(classifyHost('example.com'), 'public');
});

test('normalizes node urls onto /mcp and rejects unusable forms', () => {
  assert.equal(normalizeNodeUrl('http://100.64.0.1:7777'), 'http://100.64.0.1:7777/mcp');
  assert.equal(normalizeNodeUrl('http://100.64.0.1:7777/'), 'http://100.64.0.1:7777/mcp');
  assert.equal(normalizeNodeUrl('http://100.64.0.1:7777/mcp?x=1#y'), 'http://100.64.0.1:7777/mcp');
  assert.throws(() => normalizeNodeUrl('ftp://100.64.0.1'), /http or https/);
  assert.throws(() => normalizeNodeUrl('100.64.0.1:7777'), /valid absolute URL/);
  assert.throws(() => normalizeNodeUrl('http://user:pw@100.64.0.1:7777/mcp'), /must not embed credentials/);
  assert.throws(() => normalizeNodeUrl('  '), /required/);
});

test('parses the node list and refuses malformed entries', () => {
  const nodes = parseNodes(JSON.stringify([{ name: 'gpu-us', url: MESH_URL, token: TOKEN, note: 'brother' }]));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'gpu-us');
  assert.equal(nodes[0].note, 'brother');
  assert.throws(() => parseNodes(''), /no nodes configured/);
  assert.throws(() => parseNodes('not json'), /not valid JSON/);
  assert.throws(() => parseNodes('{}'), /must be a JSON array/);
  assert.throws(() => parseNodes('[]'), /empty/);
  assert.throws(() => parseNodes('[{"url":"http://100.64.0.1:7777"}]'), /name/);
  assert.throws(() => parseNodes('[{"name":"a b","url":"http://100.64.0.1:7777"}]'), /invalid/);
  assert.throws(
    () => parseNodes(`[{"name":"n","url":"${MESH_URL}","token":"t"},{"name":"N","url":"${MESH_URL}","token":"t"}]`),
    /duplicate node name/
  );
});

test('plain http is allowed on the mesh but not to a public host', () => {
  assert.equal(resolveNode({ name: 'n', url: MESH_URL, token: TOKEN }).hostClass, 'mesh');
  assert.throws(
    () => resolveNode({ name: 'n', url: 'http://example.com:7777/mcp', token: TOKEN }),
    /plain http to a public host/
  );
  assert.doesNotThrow(() => resolveNode({ name: 'n', url: 'https://example.com/mcp', token: TOKEN }));
  assert.doesNotThrow(() => resolveNode({ name: 'n', url: 'http://example.com:7777/mcp', token: TOKEN }, true));
});

test('an off-box node must carry a token', () => {
  assert.throws(() => resolveNode({ name: 'n', url: MESH_URL }), /has no token/);
  assert.doesNotThrow(() => resolveNode({ name: 'n', url: 'http://127.0.0.1:7777/mcp' }));
});

test('node selection handles defaults, ambiguity and typos', () => {
  const two = resolveAll({
    nodes: JSON.stringify([
      { name: 'gpu-us', url: MESH_URL, token: TOKEN },
      { name: 'nas', url: 'http://100.64.0.9:7777/mcp', token: TOKEN },
    ]),
  });
  const one = resolveAll(oneNode());
  assert.equal(pickNode(one, undefined, undefined).name, 'gpu-us', 'single node needs no name');
  assert.equal(pickNode(two, 'NAS', undefined).name, 'nas', 'name match is case-insensitive');
  assert.equal(pickNode(two, undefined, 'nas').name, 'nas', 'defaultNode fills in');
  assert.throws(() => pickNode(two, undefined, undefined), /'node' is required/);
  assert.throws(() => pickNode(two, 'gpu-uk', undefined), /unknown node 'gpu-uk'/);
});

test('node views never expose the token', () => {
  const node = resolveAll(oneNode())[0];
  const view = JSON.stringify(publicView(node));
  assert.ok(!view.includes(TOKEN), 'token leaked into a public view');
  assert.match(view, /"authenticated":true/);
  assert.match(view, /"host_class":"mesh"/);
});

test('nodes_list reports configuration without dialing anything', async () => {
  const result = await remoteNode.invoke('nodes_list', {}, ctx(oneNode()));
  const output = result.output as { count: number; nodes: Array<Record<string, unknown>> };
  assert.equal(output.count, 1);
  assert.equal(output.nodes[0].name, 'gpu-us');
  assert.equal(output.nodes[0].transport, 'http');
  assert.ok(!('token' in output.nodes[0]));
});

test('privileged invocation is refused before any network call without the confirm string', async () => {
  await assert.rejects(
    () => remoteNode.invoke('node_invoke_privileged', { module: 'system', operation: 'run_command' }, ctx(oneNode())),
    /REMOTE_EXECUTE/
  );
});

test('proxying cannot downgrade risk', () => {
  const specs = new Map(remoteNode.capabilities().map((s) => [s.name, s]));
  assert.equal(specs.get('nodes_list')?.risk, 'read');
  assert.equal(specs.get('node_workers')?.risk, 'read');
  assert.equal(specs.get('node_job_status')?.risk, 'read');
  assert.equal(specs.get('node_invoke')?.risk, 'act');
  assert.equal(specs.get('node_job_cancel')?.risk, 'act');
  assert.equal(specs.get('node_invoke_privileged')?.risk, 'dangerous');
  assert.match(specs.get('node_invoke')?.description ?? '', /Refuses/);
});

test('unwraps remote tool results and surfaces remote errors', () => {
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '{"a":1}' }] }, 'x'), { a: 1 });
  assert.equal(unwrapToolResult({ content: [{ type: 'text', text: 'plain' }] }, 'x'), 'plain');
  assert.equal(unwrapToolResult({ content: [] }, 'x'), null);
  assert.throws(
    () => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }, 'workers_list'),
    /workers_list failed on the node: boom/
  );
});

test('health fails closed when the node list is unusable', async () => {
  const bad = await remoteNode.health(ctx({ nodes: 'not json' }));
  assert.equal(bad.ok, false);
  assert.match(bad.detail ?? '', /not valid JSON/);
});

test('unknown operations are rejected by name', async () => {
  await assert.rejects(
    () => remoteNode.invoke('node_nuke', {}, ctx(oneNode())),
    /has no operation 'node_nuke'/
  );
});

test('module declares its activation guide', () => {
  assert.equal(remoteNode.name, 'remote-node');
  assert.equal(remoteNode.activation?.kind, 'service');
  assert.equal(remoteNode.activation?.guide, 'docs/REMOTE-NODES.md');
  const keys = remoteNode.configSchema.map((f) => f.key);
  assert.deepEqual(keys, ['nodes', 'timeoutMs', 'allowInsecureHttp']);
  assert.equal(remoteNode.configSchema.find((f) => f.key === 'nodes')?.type, 'secret');
});

// Type-level guard: ResolvedNode must keep carrying the classification the
// transport rules depend on.
const _typecheck: ResolvedNode = { name: 'n', url: MESH_URL, token: TOKEN, hostClass: 'mesh', secure: false };
void _typecheck;
