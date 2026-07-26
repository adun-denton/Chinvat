/*
 * WP-00 Track B — merge chunked result files into one track-b.json.
 * The suite is run in bounded chunks (see run.mjs --phase / --scenarios)
 * because the spike host caps single command runtime; this stitches the
 * partial outputs back together without re-running anything.
 *
 * Usage: node merge.mjs ../results/track-b.*.json --out=../results/track-b.json
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = presolve(HERE, outArg ? outArg.split('=')[1] : '../results/track-b.json');
const RESULTS = presolve(HERE, '../results');

const files = args.filter((a) => !a.startsWith('--'));
const inputs = (files.length
  ? files.map((f) => presolve(process.cwd(), f))
  : readdirSync(RESULTS)
      .filter((f) => /^track-b\..+\.json$/.test(f))
      .map((f) => presolve(RESULTS, f))
).sort();

const merged = {
  generatedAt: new Date().toISOString(),
  mergedFrom: inputs.map((f) => basename(f)),
  scenarios: [],
  refStability: {},
  digestIntegrity: {},
  scenarioDetail: {},
  errors: []
};

for (const f of inputs) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  merged.node ??= d.node;
  merged.platform ??= d.platform;
  merged.channel ??= d.channel;
  merged.reps ??= d.reps;
  if (d.error) merged.errors.push({ file: basename(f), error: d.error });
  if (d.snapshot) merged.snapshot = d.snapshot;
  if (d.latency) merged.latency = d.latency;
  for (const s of d.scenarios || []) {
    if (!merged.scenarios.some((x) => x.id === s.id) && (d.scenariosRun || []).includes(s.id)) {
      merged.scenarios.push(s);
    }
  }
  for (const [strategy, byScenario] of Object.entries(d.refStability || {})) {
    merged.refStability[strategy] = { ...(merged.refStability[strategy] || {}), ...byScenario };
  }
  for (const [recipe, byScenario] of Object.entries(d.digestIntegrity || {})) {
    merged.digestIntegrity[recipe] = { ...(merged.digestIntegrity[recipe] || {}), ...byScenario };
  }
  Object.assign(merged.scenarioDetail, d.scenarioDetail || {});
}

writeFileSync(OUT, JSON.stringify(merged, null, 2));
console.log('merged', inputs.length, 'files ->', OUT);
console.log('scenarios:', merged.scenarios.map((s) => s.id).join(', '));
if (merged.errors.length) console.log('ERRORS in:', merged.errors.map((e) => e.file).join(', '));
