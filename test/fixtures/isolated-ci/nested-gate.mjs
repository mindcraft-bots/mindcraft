// Run the production scheduler and shell trap with only Docker replaced.
import { runChecks } from '../../../ci/quality_gate.mjs';
import process from 'node:process';

let interruptedAt;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interruptedAt ??= performance.now(); });
const result = await runChecks([
    { name: 'live', command: 'sh', args: ['ci/run_schematics.sh'], cwd: process.cwd() },
], { jobs: 1, logs: process.argv[2] });
process.exitCode = result.interrupted === 'SIGINT' ? 130 : result.interrupted === 'SIGTERM' ? 143 : 1;
console.log(`NESTED_EXIT=${process.exitCode}\nNESTED_CLEANUP_SECONDS=${((performance.now() - interruptedAt) / 1000).toFixed(3)}`);
