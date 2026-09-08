import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOrchestrationGitTools, gitArtifactSha256 } from '../host/orchestration-git.mjs';
import { prepareTaskWorkspace } from '../host/orchestration-runner.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const parent = await realpath(path.resolve('tests'));
  await mkdir(path.join(parent, '.test-tmp'), { recursive: true });
  const projectRoot = await mkdtemp(path.join(parent, '.test-tmp', 'orchestration-git-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const repository = path.join(projectRoot, 'repository'), privateRoot = path.join(projectRoot, 'private');
  await mkdir(repository); await mkdir(privateRoot);
  await exec('git', ['init', '--initial-branch=main', repository]);
  await exec('git', ['-C', repository, 'config', 'user.name', 'Fixture']);
  await exec('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'base.txt'), 'baseline\n');
  await exec('git', ['-C', repository, 'add', 'base.txt']); await exec('git', ['-C', repository, 'commit', '-m', 'Fixture base']);
  const baseCommit = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const task = { kind: 'DEVELOP', execution: { repository, baseCommit } };
  const run = { id: 'author', phase: 'WORK' };
  const workspace = await prepareTaskWorkspace({ task, run, projectRoot, privateRoot });
  const tools = createOrchestrationGitTools({ task, run, workspace });
  const f = { projectRoot, repository, privateRoot, baseCommit, task, run, workspace, tools };
  f.candidate = async () => {
    await writeFile(path.join(workspace.cwd, 'greeting.txt'), 'Hello\n');
    return tools.handlers.orchestration_commit_candidate({ paths: ['greeting.txt'], message: 'test: greeting fixture' });
  };
  f.finalizer = async candidate => {
    const finalTask = { ...task, artifacts: [candidate.artifact] }, finalRun = { id: 'finalizer', phase: 'FINALIZE' };
    const finalWorkspace = await prepareTaskWorkspace({ task: finalTask, run: finalRun, projectRoot, privateRoot });
    return createOrchestrationGitTools({ task: finalTask, run: finalRun, workspace: finalWorkspace });
  };
  return f;
}

test('controlled candidate commit pins files, parent, worktree and actual artifact SHA', async t => {
  const f = await fixture(t), candidate = await f.candidate();
  assert.equal(candidate.status, 'COMMITTED'); assert.deepEqual(candidate.changedPaths, ['greeting.txt']);
  assert.equal(candidate.artifact.sha256, await gitArtifactSha256(f.repository, candidate.commit));
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'rev-parse', 'HEAD^'])).stdout.trim(), f.baseCommit);
  assert.equal((await exec('git', ['-C', f.repository, 'rev-parse', 'HEAD'])).stdout.trim(), f.baseCommit, 'candidate commit never changes the original checkout');
});

test('parallel dynamic commit calls share a serialized index while callId replays remain idempotent', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace.cwd, 'first.txt'), 'first\n'); await writeFile(path.join(f.workspace.cwd, 'second.txt'), 'second\n');
  const firstCall = f.tools.handlers.orchestration_commit_candidate({ paths: ['first.txt'], message: 'First candidate' }, { callId: 'first-call' });
  const secondCall = f.tools.handlers.orchestration_commit_candidate({ paths: ['second.txt'], message: 'Second candidate' }, { callId: 'second-call' });
  const [first, second, replay] = await Promise.all([firstCall, secondCall,
    f.tools.handlers.orchestration_commit_candidate({ paths: ['first.txt'], message: 'First candidate' }, { callId: 'first-call' })]);
  assert.deepEqual(first.changedPaths, ['first.txt']); assert.deepEqual(second.changedPaths, ['second.txt']); assert.deepEqual(replay, first);
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'rev-parse', second.commit + '^'])).stdout.trim(), first.commit);
  assert.equal((await f.tools.handlers.orchestration_git_artifact({})).commit, second.commit);
});

test('candidate paths reject traversal, Git metadata, directories and external symlinks', async t => {
  const f = await fixture(t); await mkdir(path.join(f.workspace.cwd, 'directory'));
  await writeFile(path.join(f.projectRoot, 'external.txt'), 'external');
  await symlink(path.join(f.projectRoot, 'external.txt'), path.join(f.workspace.cwd, 'link.txt'));
  for (const file of ['../base.txt', '/etc/passwd', '.git', '.git/config', 'directory', 'runtime/private/key']) {
    await assert.rejects(f.tools.handlers.orchestration_commit_candidate({ paths: [file], message: 'Rejected' }), { code: 'ORCHESTRATION_GIT_PATH' });
  }
  await assert.rejects(f.tools.handlers.orchestration_commit_candidate({ paths: ['link.txt'], message: 'Rejected' }), { code: 'ORCHESTRATION_GIT_SYMLINK' });
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'diff', '--cached', '--name-only'])).stdout, '');
});

test('an unrelated staged file cannot be silently included in a candidate commit', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace.cwd, 'unrelated.txt'), 'unrelated'); await writeFile(path.join(f.workspace.cwd, 'greeting.txt'), 'Hello');
  await exec('git', ['-C', f.workspace.cwd, 'add', 'unrelated.txt']);
  await assert.rejects(f.tools.handlers.orchestration_commit_candidate({ paths: ['greeting.txt'], message: 'Greeting only' }), { code: 'ORCHESTRATION_GIT_INDEX_DIRTY' });
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'rev-parse', 'HEAD'])).stdout.trim(), f.baseCommit);
});

test('QA has only artifact reading and no host Git mutation capabilities', async t => {
  const f = await fixture(t), candidate = await f.candidate();
  const task = { ...f.task, kind: 'DEVELOP_QA', artifacts: [candidate.artifact] }, run = { id: 'qa', phase: 'QA' };
  const workspace = await prepareTaskWorkspace({ ...f, task, run });
  const qa = createOrchestrationGitTools({ task, run, workspace });
  assert.deepEqual(qa.specs.map(item => item.name), ['orchestration_git_artifact']);
  assert.deepEqual((await qa.handlers.orchestration_git_artifact({})).artifact, candidate.artifact);
  assert.equal(qa.handlers.orchestration_commit_candidate, undefined); assert.equal(qa.handlers.orchestration_fast_forward, undefined);
});

test('finalization is an exact local fast-forward and repeated calls do not create another commit', async t => {
  const f = await fixture(t), candidate = await f.candidate(), finalizer = await f.finalizer(candidate);
  const first = await finalizer.handlers.orchestration_fast_forward({}, { callId: 'one' });
  assert.equal(first.status, 'FAST_FORWARDED'); assert.equal(first.commit, candidate.commit);
  assert.deepEqual(await finalizer.handlers.orchestration_fast_forward({}, { callId: 'one' }), first);
  assert.equal((await finalizer.handlers.orchestration_fast_forward({})).status, 'ALREADY_INTEGRATED');
  assert.equal(await readFile(path.join(f.repository, 'greeting.txt'), 'utf8'), 'Hello\n');
});

test('dirty or moved integration source is rejected without overwriting user work', async t => {
  const f = await fixture(t), candidate = await f.candidate(), finalizer = await f.finalizer(candidate);
  await writeFile(path.join(f.repository, 'base.txt'), 'user uncommitted\n');
  await assert.rejects(finalizer.handlers.orchestration_fast_forward({}), { code: 'ORCHESTRATION_GIT_SOURCE_DIRTY' });
  assert.equal(await readFile(path.join(f.repository, 'base.txt'), 'utf8'), 'user uncommitted\n');
  await exec('git', ['-C', f.repository, 'add', 'base.txt']); await exec('git', ['-C', f.repository, 'commit', '-m', 'Independent user change']);
  await assert.rejects(finalizer.handlers.orchestration_fast_forward({}), { code: 'ORCHESTRATION_GIT_SOURCE_DRIFT' });
  assert.equal(await readFile(path.join(f.repository, 'base.txt'), 'utf8'), 'user uncommitted\n');
});

test('Git tools recheck the active lease before mutating the index', async t => {
  const f = await fixture(t); await writeFile(path.join(f.workspace.cwd, 'greeting.txt'), 'Hello');
  const tools = createOrchestrationGitTools({ ...f, assertLease: async () => { throw Object.assign(new Error('Lease lost'), { code: 'ORCHESTRATION_LEASE_LOST' }); } });
  await assert.rejects(tools.handlers.orchestration_commit_candidate({ paths: ['greeting.txt'], message: 'Do not commit' }), { code: 'ORCHESTRATION_LEASE_LOST' });
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'diff', '--cached', '--name-only'])).stdout, '');
});

test('fast-forward cannot overwrite an ignored user file in the original repository', async t => {
  const f = await fixture(t), candidate = await f.candidate(), finalizer = await f.finalizer(candidate);
  await writeFile(path.join(f.repository, '.git', 'info', 'exclude'), 'greeting.txt\n');
  await writeFile(path.join(f.repository, 'greeting.txt'), 'PRIVATE USER DATA\n');
  assert.equal((await exec('git', ['-C', f.repository, 'status', '--porcelain', '--untracked-files=all'])).stdout, '');
  await assert.rejects(finalizer.handlers.orchestration_fast_forward({}), { code: 'ORCHESTRATION_GIT_REJECTED' });
  assert.equal(await readFile(path.join(f.repository, 'greeting.txt'), 'utf8'), 'PRIVATE USER DATA\n');
  assert.equal((await exec('git', ['-C', f.repository, 'rev-parse', 'HEAD'])).stdout.trim(), f.baseCommit);
});

test('unapproved executable Git hooks are rejected before any commit or hook side effect', async t => {
  const f = await fixture(t); await writeFile(path.join(f.workspace.cwd, 'greeting.txt'), 'Hello');
  const hook = path.join(f.repository, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nexit 0\n'); await chmod(hook, 0o700);
  await assert.rejects(f.tools.handlers.orchestration_commit_candidate({ paths: ['greeting.txt'], message: 'Scoped commit' }), { code: 'ORCHESTRATION_GIT_HOOK_SCOPE' });
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'diff', '--cached', '--name-only'])).stdout, '');
});

test('a deleted explicitly named tracked file can be committed without directory staging', async t => {
  const f = await fixture(t); await rm(path.join(f.workspace.cwd, 'base.txt'));
  const result = await f.tools.handlers.orchestration_commit_candidate({ paths: ['base.txt'], message: 'Remove fixture file' });
  assert.deepEqual(result.changedPaths, ['base.txt']);
  assert.equal((await exec('git', ['-C', f.workspace.cwd, 'ls-tree', '--name-only', 'HEAD'])).stdout, '');
});

test('an explicitly named tracked file remains committable when its parent directory was removed', async t => {
  const f = await fixture(t); await mkdir(path.join(f.workspace.cwd, 'obsolete'));
  await writeFile(path.join(f.workspace.cwd, 'obsolete', 'part.txt'), 'obsolete');
  await f.tools.handlers.orchestration_commit_candidate({ paths: ['obsolete/part.txt'], message: 'Add obsolete fixture' });
  await rm(path.join(f.workspace.cwd, 'obsolete'), { recursive: true });
  const result = await f.tools.handlers.orchestration_commit_candidate({ paths: ['obsolete/part.txt'], message: 'Remove obsolete fixture' });
  assert.deepEqual(result.changedPaths, ['obsolete/part.txt']);
});

test('post-index-change and worktree post-checkout hooks are rejected without side effects', async t => {
  const f = await fixture(t), proof = path.join(f.projectRoot, 'hook-proof');
  const hook = path.join(f.repository, '.git', 'hooks', 'post-index-change');
  await writeFile(hook, '#!/bin/sh\nprintf executed > ' + JSON.stringify(proof) + '\n'); await chmod(hook, 0o700);
  await assert.rejects(f.candidate(), { code: 'ORCHESTRATION_GIT_HOOK_SCOPE' });
  await rm(hook);
  const checkout = path.join(f.repository, '.git', 'hooks', 'post-checkout');
  await writeFile(checkout, '#!/bin/sh\nprintf executed > ' + JSON.stringify(proof) + '\n'); await chmod(checkout, 0o700);
  await assert.rejects(prepareTaskWorkspace({ ...f, run: { id: 'second-author', phase: 'WORK' } }), { code: 'ORCHESTRATION_GIT_HOOK_SCOPE' });
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
});

test('artifact reads cannot execute textconv or fsmonitor and candidate commits cannot invoke a signer', async t => {
  const f = await fixture(t), proof = path.join(f.projectRoot, 'configured-command-proof');
  const program = path.join(f.projectRoot, 'configured-command.sh');
  await writeFile(program, '#!/bin/sh\nprintf executed > ' + JSON.stringify(proof) + '\nexit 0\n'); await chmod(program, 0o700);
  await writeFile(path.join(f.repository, '.git', 'info', 'attributes'), '*.txt diff=audit\n');
  await exec('git', ['-C', f.repository, 'config', 'diff.audit.textconv', JSON.stringify(program)]);
  await exec('git', ['-C', f.repository, 'config', 'core.fsmonitor', program]);
  await exec('git', ['-C', f.repository, 'config', 'commit.gpgSign', 'true']);
  await exec('git', ['-C', f.repository, 'config', 'gpg.program', program]);
  assert.ok((await f.tools.handlers.orchestration_git_artifact({})).artifact.sha256);
  assert.equal((await f.candidate()).status, 'COMMITTED');
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
});

test('a same-base worktree Git pointer cannot redirect a run to another worker index or branch', async t => {
  const f = await fixture(t), other = await prepareTaskWorkspace({ ...f, run: { id: 'second-author', phase: 'WORK' } });
  await writeFile(path.join(f.workspace.cwd, '.git'), await readFile(path.join(other.cwd, '.git')));
  await assert.rejects(f.candidate(), { code: 'ORCHESTRATION_GIT_BINDING' });
  await assert.rejects(f.tools.handlers.orchestration_git_artifact({}), { code: 'ORCHESTRATION_GIT_BINDING' });
  assert.equal((await exec('git', ['-C', other.cwd, 'rev-parse', 'HEAD'])).stdout.trim(), f.baseCommit);
  assert.equal((await exec('git', ['-C', other.cwd, 'diff', '--cached', '--name-only'])).stdout, '');
});

test('unused global-style LFS filters allow ordinary files but affected files fail closed without executing a filter', async t => {
  const f = await fixture(t), proof = path.join(f.projectRoot, 'filter-proof');
  const program = path.join(f.projectRoot, 'filter.sh');
  await writeFile(program, '#!/bin/sh\nprintf executed > ' + JSON.stringify(proof) + '\nexit 0\n'); await chmod(program, 0o700);
  for (const key of ['clean', 'smudge', 'process']) await exec('git', ['-C', f.repository, 'config', 'filter.lfs.' + key, JSON.stringify(program)]);
  assert.equal((await f.candidate()).status, 'COMMITTED');
  await writeFile(path.join(f.workspace.cwd, '.gitattributes'), 'filtered.txt filter=lfs\n');
  await writeFile(path.join(f.workspace.cwd, 'filtered.txt'), 'do not bypass LFS\n');
  await assert.rejects(f.tools.handlers.orchestration_commit_candidate({ paths: ['filtered.txt'], message: 'Filtered file' }), { code: 'ORCHESTRATION_GIT_FILTER_SCOPE' });
  await assert.rejects(readFile(proof), { code: 'ENOENT' });
});

test('checkout of an exact candidate needing an external smudge filter is blocked before materialization', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace.cwd, '.gitattributes'), 'base.txt filter=lfs\n');
  const candidate = await f.tools.handlers.orchestration_commit_candidate({ paths: ['.gitattributes'], message: 'Add fixture attributes' });
  await exec('git', ['-C', f.repository, 'config', 'filter.lfs.smudge', 'never-execute-this-fixture-command']);
  await assert.rejects(prepareTaskWorkspace({ ...f, task: { ...f.task, artifacts: [candidate.artifact] }, run: { id: 'qa', phase: 'QA' } }), { code: 'ORCHESTRATION_GIT_FILTER_SCOPE' });
});
