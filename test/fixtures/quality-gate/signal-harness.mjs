import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../../../ci/quality_gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), dir = process.argv[2];
const jobs = Number(process.argv[3] || 1);
const check = (name, fixture = name, target = dir) => ({ name, command: process.execPath, args: [path.join(here, 'case.mjs'), path.join(here, 'cases.json'), fixture, target], cwd: target });
const parents = Array.from({ length: jobs }, (_, i) => check(`parent-${i}`, 'parent', jobs === 1 ? dir : path.join(dir, `worker-${i}`)));
const result = await runChecks([...parents, check('after')], { jobs, logs: dir });
process.exitCode = result.interrupted === 'SIGTERM' ? 143 : result.interrupted === 'SIGINT' ? 130 : 1;
