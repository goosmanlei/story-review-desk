import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runMaintenanceProcess } from '../scripts/instance-maintenance.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fragmentedWriter = `
import { setTimeout } from 'node:timers/promises';
const bytes = Buffer.from(process.env.MAINTENANCE_TEXT, 'utf8');
const output = process.env.MAINTENANCE_STREAM === 'stderr' ? process.stderr : process.stdout;
for (let offset = 0; offset < bytes.length; offset += 1) {
  await new Promise((resolve, reject) => output.write(bytes.subarray(offset, offset + 1), error => error ? reject(error) : resolve()));
  await setTimeout(15);
}
process.exitCode = Number(process.env.MAINTENANCE_EXIT || 0);
`;

test('maintenance preserves exact UTF-8 document bytes when Chinese and supplementary characters cross stdout chunks', async () => {
  const expected = Buffer.from('中文🙂𠮷\r\n正文\n', 'utf8');
  const result = await runMaintenanceProcess(process.execPath, ['--input-type=module', '-e', fragmentedWriter], {
    env: { ...process.env, MAINTENANCE_TEXT: expected.toString('utf8') },
  });
  assert.deepEqual(Buffer.from(result.stdout, 'utf8'), expected);
  assert.equal(sha(result.stdout), sha(expected));
  assert.equal(result.stderr, '');
});

test('large streamed Chinese document retains its original SHA on repeated transport reads', async () => {
  const expected = Buffer.from('场次：中文正文🙂\r\n'.repeat(20_000), 'utf8');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runMaintenanceProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: expected });
    assert.deepEqual(Buffer.from(result.stdout, 'utf8'), expected);
    assert.equal(sha(result.stdout), sha(expected));
  }
});

test('fragmented stderr preserves Chinese failure diagnostics on both success and nonzero exit', async () => {
  const diagnostic = '失败：中文🙂\n';
  const env = { ...process.env, MAINTENANCE_TEXT: diagnostic, MAINTENANCE_STREAM: 'stderr' };
  const result = await runMaintenanceProcess(process.execPath, ['--input-type=module', '-e', fragmentedWriter], { env });
  assert.equal(result.stderr, diagnostic);
  await assert.rejects(runMaintenanceProcess(process.execPath, ['--input-type=module', '-e', fragmentedWriter], {
    env: { ...env, MAINTENANCE_EXIT: '7' },
  }), { message: `Container maintenance failed (7): ${diagnostic}` });
});

test('maintenance output limit still counts UTF-8 bytes and stderr remains bounded', async () => {
  const expected = Buffer.from('中文', 'utf8');
  const result = await runMaintenanceProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: expected, maxBytes: expected.length });
  assert.equal(result.stdout, expected.toString('utf8'));
  await assert.rejects(runMaintenanceProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: expected, maxBytes: expected.length - 1 }), /Maintenance output limit exceeded/);
  const stderr = await runMaintenanceProcess(process.execPath, ['-e', 'process.stderr.write("诊".repeat(65_000))']);
  assert.equal(stderr.stderr, '诊'.repeat(64_000));
});
