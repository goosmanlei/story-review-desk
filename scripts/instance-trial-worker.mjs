import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { openInstanceRepository, resolveInstance } from '../host/instance-runtime/index.mjs';
import { instanceTrialInspect, instanceTrialDryRun, instanceTrialPrepareScope, instanceTrialPrepareRecipe, instanceTrialReserve, instanceTrialStart, instanceTrialResult, instanceTrialAnnotateQa } from '../host/instance-runtime/trial.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';

const commands = { inspect: instanceTrialInspect, 'dry-run': instanceTrialDryRun, 'prepare-scope': instanceTrialPrepareScope, 'prepare-recipe': instanceTrialPrepareRecipe, reserve: instanceTrialReserve, start: instanceTrialStart, result: instanceTrialResult, 'annotate-qa': instanceTrialAnnotateQa };
if (!await delegateInstanceMaintenance('instance-trial-worker.mjs', process.argv.slice(2))) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { instance: { type: 'string' }, file: { type: 'string' }, scope: { type: 'string' }, 'if-match': { type: 'string' }, 'idempotency-key': { type: 'string' } } });
  const command = positionals[0];
  if (positionals.length !== 1 || !commands[command] || !values.instance || command !== 'inspect' && !values.file) throw new Error('Usage: instance-trial-worker.mjs inspect --instance ROOT [--scope ID] | dry-run|prepare-scope|prepare-recipe|reserve|start|result|annotate-qa --instance ROOT --file MANIFEST.json [--scope ID --if-match ETAG --idempotency-key KEY]');
  const location = resolveInstance(values.instance), repository = await openInstanceRepository({ ...location, readOnly: ['inspect', 'dry-run'].includes(command) });
  const options = { root: location.root, scopeId: values.scope, ifMatch: values['if-match'], idempotencyKey: values['idempotency-key'] };
  try {
    const body = values.file ? JSON.parse(await readFile(values.file, 'utf8')) : null;
    const invoke = () => command === 'inspect' ? commands[command](repository, options) : commands[command](repository, body, options);
    const result = await repository.withMediaLease({ mode: 'SHARED' }, invoke);
    console.log(JSON.stringify(result, null, 2));
  } finally { await repository.close(); }
}
