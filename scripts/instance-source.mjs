#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolveInstance, openInstanceRepository } from '../host/instance-runtime/index.mjs';
import { planInstanceSource, applyInstanceSource, resumeInstanceSource, createSourceApiClient } from '../host/instance-source-controller.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';

if (await delegateInstanceMaintenance('instance-source.mjs', process.argv.slice(2))) process.exit(0);

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  instance: { type: 'string' }, manifest: { type: 'string' }, 'plan-hash': { type: 'string' }, 'source-operation-id': { type: 'string' }, url: { type: 'string', default: 'http://localhost:3000' },
} });
const command = positionals[0] || 'plan';
if (!values.instance || !['plan', 'apply', 'resume'].includes(command) || positionals.length > 1) throw new Error('Usage: node scripts/instance-source.mjs [plan|apply|resume] --instance <instance-root> --manifest <exact-manifest.json> [--plan-hash <sha256>] [--source-operation-id <sop_id>]');
const location = resolveInstance(values.instance); const repository = (await openInstanceRepository({ ...location, readOnly: command === 'plan' }));
try {
  let result;
  if (command === 'resume') result = await resumeInstanceSource(repository, { sourceOperationId: values['source-operation-id'], client: createSourceApiClient(values.url) });
  else {
    if (!values.manifest) throw new Error('An explicit --manifest is required; source paths and approvals are never inferred');
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    if (command === 'plan') result = (await planInstanceSource(repository, { instanceRoot: location.root, manifest })).plan;
    else result = await applyInstanceSource(repository, { instanceRoot: location.root, manifest, planHash: values['plan-hash'], client: createSourceApiClient(values.url) });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { (await repository.close()); }
