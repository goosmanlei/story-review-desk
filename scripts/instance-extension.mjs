import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveInstance, openInstanceRepository } from '../host/instance-runtime/index.mjs';
import { planInstanceExtension, applyInstanceExtension, createExtensionRuntimeClient } from '../host/instance-extension-controller.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
export async function instanceExtensionCli(argv) {
  if (await delegateInstanceMaintenance('instance-extension.mjs', argv)) return;
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { instance: { type: 'string' }, manifest: { type: 'string' }, 'plan-hash': { type: 'string' }, url: { type: 'string', default: 'http://localhost:3000' } } });
  const command = positionals[0];
  if (!values.instance || !values.manifest || !['plan', 'apply'].includes(command) || positionals.length !== 1) throw new Error('Usage: instance-extension.mjs plan|apply --instance PATH --manifest FILE [--plan-hash SHA] [--url http://localhost:PORT]');
  let softwareCommit = process.env.REVIEW_SOFTWARE_COMMIT;
  if (!softwareCommit) { try { softwareCommit = JSON.parse(await readFile(new URL('../software-manifest.json', import.meta.url), 'utf8')).softwareCommit; } catch { /* Controller fails closed without a full exact software SHA. */ } }
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8')); const location = resolveInstance(values.instance);
  const repository = (await openInstanceRepository({ ...location, readOnly: command === 'plan' }));
  try {
    const input = { instanceRoot: location.root, manifest, softwareCommit };
    const result = command === 'plan' ? (await planInstanceExtension(repository, input)).plan : await applyInstanceExtension(repository, { ...input, planHash: values['plan-hash'], client: createExtensionRuntimeClient(values.url) });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { (await repository.close()); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await instanceExtensionCli(process.argv.slice(2));
