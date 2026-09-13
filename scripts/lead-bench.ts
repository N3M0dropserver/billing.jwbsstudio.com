/**
 * Print what the lead filter does to a set of known businesses.
 *
 *   bun run scripts/lead-bench.ts               # every search, scripted model
 *   bun run scripts/lead-bench.ts napier-cafe   # one search
 *   bun run scripts/lead-bench.ts --mode=optimistic
 *   bun run scripts/lead-bench.ts --prompts     # dump what the model is shown
 *
 * The assertions live in tests/growth-scenarios.test.ts. This is for tuning:
 * change a weight, run this, read the two tables side by side.
 */

import { SCENARIOS } from '../tests/scenarios/fixtures';
import { formatRun, runScenario, type ModelMode } from '../tests/scenarios/harness';

const args = process.argv.slice(2);
const mode = (args.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'scripted') as ModelMode;
const showPrompts = args.includes('--prompts');
const ids = args.filter((a) => !a.startsWith('--'));

const chosen = ids.length ? SCENARIOS.filter((s) => ids.includes(s.id)) : SCENARIOS;
if (!chosen.length) {
  console.error(`No such search. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

let right = 0;
let wrong = 0;
let missed = 0;
let calls = 0;
let assessed = 0;

for (const scenario of chosen) {
  const run = await runScenario(scenario, mode);
  console.log(`\n${formatRun(run)}`);

  if (run.falsePositives.length) {
    console.log('\n  sent to people who should not have been written to:');
    for (const row of run.falsePositives) console.log(`    ${row.name} — ${row.why}`);
  }
  if (run.falseNegatives.length) {
    console.log('\n  good prospects that were dropped:');
    for (const row of run.falseNegatives) {
      console.log(`    ${row.name} — ${row.why} (${row.ruledOutBy ?? 'below the cut'})`);
    }
  }

  const uncontactable = run.selected.filter((row) => !row.contactable);
  if (uncontactable.length) {
    console.log('\n  selected with no address to write to:');
    for (const row of uncontactable) console.log(`    ${row.name}`);
  }

  const noAngle = run.selected.filter((row) => row.audit.observations.length === 0);
  if (noAngle.length) {
    console.log('\n  selected with nothing measurable to open an email with:');
    for (const row of noAngle) console.log(`    ${row.name}`);
  }

  if (showPrompts) {
    console.log('\n  what the model was shown for the first prospect:\n');
    const first = run.prompts[0];
    if (first) console.log(first.prompt.split('\n').map((line) => `    | ${line}`).join('\n'));
  }

  right += run.truePositives.length;
  wrong += run.falsePositives.length;
  missed += run.falseNegatives.length;
  calls += run.modelCalls;
  assessed += run.assessments.length;
}

const wanted = chosen.reduce(
  (sum, s) => sum + s.businesses.filter((b) => b.want === 'lead').length,
  0,
);

console.log(
  `\n${'='.repeat(60)}\n` +
    `model: ${mode}\n` +
    `leads found ${right}/${wanted} · bad leads let through ${wrong} · good ones dropped ${missed}\n` +
    `model calls ${calls}/${assessed} (${Math.round((calls / assessed) * 100)}% of prospects cost a call)\n`,
);

if (wrong > 0) process.exitCode = 1;
