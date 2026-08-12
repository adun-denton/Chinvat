import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ResolveError,
  resolveCapability,
  type CapabilityInstance,
} from '../lib/capability-resolver.js';

function instance(overrides: Partial<CapabilityInstance> = {}): CapabilityInstance {
  return {
    capability: 'files.list_dir',
    providerId: 'provider-a',
    endpointId: 'office-pc',
    principalRef: 'local-filesystem-default',
    schemaHash: 'schema-v1',
    live: true,
    risk: 'read',
    executionMode: 'sync',
    preference: 0,
    ...overrides,
  };
}

test('selects the only live capability instance', () => {
  const chosen = resolveCapability([instance()], { capability: 'files.list_dir' });
  assert.equal(chosen.endpointId, 'office-pc');
});

test('ignores offline instances at invocation time', () => {
  assert.throws(
    () => resolveCapability([instance({ live: false })], { capability: 'files.list_dir' }),
    (error: unknown) => error instanceof ResolveError && error.code === 'capability_unavailable'
  );
});

test('explicit target is exact and never falls through', () => {
  const instances = [
    instance({ endpointId: 'office-pc', providerId: 'office' }),
    instance({ endpointId: 'home-pc', providerId: 'home' }),
  ];
  const chosen = resolveCapability(instances, {
    capability: 'files.list_dir',
    target: 'home-pc',
  });
  assert.equal(chosen.endpointId, 'home-pc');

  assert.throws(
    () => resolveCapability(instances, { capability: 'files.list_dir', target: 'missing' }),
    (error: unknown) => error instanceof ResolveError && error.code === 'unresolved_target'
  );
});

test('principal identity filters before target selection', () => {
  const instances = [
    instance({ endpointId: 'office-pc', providerId: 'office', principalRef: 'account-a' }),
    instance({ endpointId: 'home-pc', providerId: 'home', principalRef: 'account-b' }),
  ];
  const chosen = resolveCapability(instances, {
    capability: 'files.list_dir',
    principalRef: 'account-b',
  });
  assert.equal(chosen.endpointId, 'home-pc');
});

test('multiple equivalent reads use deterministic preference ordering', () => {
  const instances = [
    instance({ endpointId: 'office-pc', providerId: 'office', preference: 20 }),
    instance({ endpointId: 'home-pc', providerId: 'home', preference: 10 }),
  ];
  const chosen = resolveCapability(instances, { capability: 'files.list_dir' });
  assert.equal(chosen.endpointId, 'home-pc');
});

test('equal read preferences fall back to stable endpoint ordering', () => {
  const instances = [
    instance({ endpointId: 'z-node', providerId: 'z' }),
    instance({ endpointId: 'a-node', providerId: 'a' }),
  ];
  const chosen = resolveCapability(instances, { capability: 'files.list_dir' });
  assert.equal(chosen.endpointId, 'a-node');
});

test('multiple reads with different principals are ambiguous', () => {
  const instances = [
    instance({ endpointId: 'office-pc', providerId: 'office', principalRef: 'account-a' }),
    instance({ endpointId: 'home-pc', providerId: 'home', principalRef: 'account-b' }),
  ];
  assert.throws(
    () => resolveCapability(instances, { capability: 'files.list_dir' }),
    (error: unknown) => error instanceof ResolveError && error.code === 'ambiguous_target'
  );
});

test('effectful ambiguity always requires an explicit target', () => {
  const instances = [
    instance({ capability: 'wordpress.create_draft', endpointId: 'server-a', providerId: 'wp-a', risk: 'act', principalRef: 'wp-main' }),
    instance({ capability: 'wordpress.create_draft', endpointId: 'server-b', providerId: 'wp-b', risk: 'act', principalRef: 'wp-main' }),
  ];
  assert.throws(
    () => resolveCapability(instances, { capability: 'wordpress.create_draft' }),
    (error: unknown) => error instanceof ResolveError && error.code === 'ambiguous_target'
  );
});

test('execution mode is part of candidate equivalence', () => {
  const instances = [
    instance({ endpointId: 'sync-node', providerId: 'sync', executionMode: 'sync' }),
    instance({ endpointId: 'job-node', providerId: 'job', executionMode: 'job' }),
  ];

  const chosen = resolveCapability(instances, {
    capability: 'files.list_dir',
    executionMode: 'sync',
  });
  assert.equal(chosen.endpointId, 'sync-node');

  assert.throws(
    () => resolveCapability(instances, { capability: 'files.list_dir' }),
    (error: unknown) => error instanceof ResolveError && error.code === 'ambiguous_target'
  );
});
