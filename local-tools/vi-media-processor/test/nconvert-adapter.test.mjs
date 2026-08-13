import test from 'node:test';
import assert from 'node:assert/strict';
import { NConvertAdapter, orientationArguments } from '../src/nconvert-adapter.mjs';
import { getPreset } from '../src/presets.mjs';

test('adapter parses NConvert technical information', async () => {
  const run = async () => ({ code: 0, output: `file.jpg : Success\n Width : 4000\n Height : 3000\n Components per pixel : 3\n Orientation : Top Left\n Page(s) : 1\n Metadata : ( EXIF ICC )\nEXIF:\n Orientation (0x0112): right-top (6)\n` });
  const info = await new NConvertAdapter({ run }).inspect('file.jpg');
  assert.deepEqual(info, { width: 4000, height: 3000, pages: 1, orientation: 'Right Top', components: 3, metadata: '( EXIF ICC )' });
});

test('availability accepts NConvert help output even when the Windows binary exits non-zero', async () => {
  const run = async () => ({ code: 1, output: '** NCONVERT v7.300 **\nUsage: nconvert [options] file' });
  assert.equal(await new NConvertAdapter({ run }).assertAvailable(), '7.300');
});

test('adapter keeps NConvert syntax behind one command builder', () => {
  const adapter = new NConvertAdapter();
  const args = adapter.buildArguments({
    sourcePath: 'source image.jpg',
    temporaryPath: 'temporary.webp',
    preset: getPreset('WP_HERO'),
    geometry: { orientation: 'Right Top', resize: { mode: 'cover', width: 1920, height: 800, anchor: 'center' } },
  });
  assert.deepEqual(args.slice(0, 10), ['-quiet', '-icc', '-rtype', 'lanczos', '-rotate', '90', '-resize', 'fill', '1920', '800']);
  assert.ok(args.includes('-rmeta'));
  assert.equal(args.at(-1), 'source image.jpg');
});

test('all EXIF orientations map to deterministic pixel operations', () => {
  assert.deepEqual(orientationArguments('Top Left'), []);
  assert.deepEqual(orientationArguments('Right Top'), ['-rotate', '90']);
  assert.deepEqual(orientationArguments('Left Bottom'), ['-rotate', '270']);
  assert.deepEqual(orientationArguments('Right Bottom'), ['-xflip', '-rotate', '90']);
});
