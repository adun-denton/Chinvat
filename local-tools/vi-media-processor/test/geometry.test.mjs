import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeometryPlan, orientedDimensions } from '../src/geometry.mjs';
import { getPreset } from '../src/presets.mjs';

test('orientation-aware geometry swaps dimensions before policy evaluation', () => {
  assert.deepEqual(orientedDimensions({ width: 800, height: 1200, orientation: 'Right Top' }), { width: 1200, height: 800 });
});

test('hero refuses an upscale', () => {
  const plan = createGeometryPlan({ width: 1000, height: 1000, orientation: 'Top Left' }, getPreset('WP_HERO'));
  assert.equal(plan.processable, false);
  assert.equal(plan.reason, 'too_small');
});

test('gallery bounds large images and leaves small images smaller', () => {
  const preset = getPreset('WP_GALLERY');
  assert.deepEqual(createGeometryPlan({ width: 4000, height: 2000, orientation: 'Top Left' }, preset).output, { width: 1600, height: 800 });
  assert.deepEqual(createGeometryPlan({ width: 800, height: 600, orientation: 'Top Left' }, preset).output, { width: 800, height: 600 });
});
