import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMinimumVersion, compareSemver, parseSemver } from '../src/semver.mjs';

test('semantic-version comparison respects prerelease precedence', () => {
  assert.equal(compareSemver('0.2.0', '0.1.99'), 1);
  assert.equal(compareSemver('0.2.0-alpha.1', '0.2.0-alpha.2'), -1);
  assert.equal(compareSemver('0.2.0', '0.2.0-rc.1'), 1);
  assert.equal(compareSemver('0.2.0+build.5', '0.2.0'), 0);
});

test('minimum processor requirement rejects incompatible versions', () => {
  assert.doesNotThrow(() => assertMinimumVersion('0.2.0', '0.2.0'));
  assert.doesNotThrow(() => assertMinimumVersion('0.3.0', '0.2.0'));
  assert.throws(() => assertMinimumVersion('0.1.9', '0.2.0'), /requires processor >= 0\.2\.0/);
});

test('semantic-version parser rejects ranges and malformed values', () => {
  for (const value of ['^0.2.0', '0.2', 'v0.2.0', '0.02.0', '0.2.0-alpha.01']) {
    assert.throws(() => parseSemver(value), /semantic version/i);
  }
});
