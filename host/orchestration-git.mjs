/** Narrow host Git operations for one leased development worktree. No shell or remote commands. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exactCommit = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const configuredFilters = text => [...new Set(text.split('\0').flatMap(item => {
  const match = item.match(/^filter\.(.+)\.(?:clean|smudge|process)\n([\s\S]+)$/i);
  return match ? [match[1]] : [];
}))];

/** All host Git calls share noninteractive, non-signing, non-hook, non-fsmonitor execution. */
export async function runOrchestrationGit(root, args, { buffer = false, hookPathDiscovery = false } = {}) {
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const configuration = ['core.fsmonitor=false', 'core.untrackedCache=false', 'commit.gpgSign=false', 'tag.gpgSign=false',
      'log.showSignature=false', 'submodule.recurse=false', 'merge.autoStash=false', 'merge.renormalize=false', 'gc.auto=0', 'maintenance.auto=false'];
    if (!hookPathDiscovery) configuration.push('core.hooksPath=/dev/null');
    const options = {
      encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    };
    const prefix = ['--no-pager', '--literal-pathspecs', '-C', root, ...configuration.flatMap(value => ['-c', value])];
    // Read operations must not invoke clean filters either. Mutations separately fail closed on affected filtered paths.
    const filters = args[0] === 'config' ? [] : configuredFilters((await execute('git', [...prefix, 'config', '--null', '--list'], { ...options, encoding: 'utf8' })).stdout);
    const disabledFilters = filters.flatMap(name => ['clean', 'smudge', 'process', 'required'].flatMap(key => ['-c', 'filter.' + name + '.' + key + '=' + (key === 'required' ? 'false' : '')]));
    const result = await execute('git', [...prefix, ...disabledFilters, ...args], options);
    return result.stdout;
  } catch (failure) {
    fail(failure.killed || failure.signal ? 'RESULT_UNKNOWN' : 'ORCHESTRATION_GIT_REJECTED',
      'The exact scoped Git operation failed; inspect its state before any retry');
  }
}
const git = runOrchestrationGit;

export async function assertSafeGitMutation(root, { paths, source } = {}) {
  // Filters can execute at add/checkout/merge, including in worktree preparation. Do not silently bypass required project filters.
  const filters = configuredFilters(await git(root, ['config', '--null', '--list']));
  if (filters.length) {
    const files = paths || (source ? (await git(root, ['ls-tree', '-r', '--name-only', '-z', source])).split('\0').filter(Boolean) : []);
    for (let start = 0; start < files.length; start += 128) {
      const attributes = (await git(root, ['check-attr', '-z', ...(source ? ['--source=' + source] : []), 'filter', '--', ...files.slice(start, start + 128)])).split('\0');
      for (let index = 2; index < attributes.length; index += 3) if (filters.includes(attributes[index])) {
        fail('ORCHESTRATION_GIT_FILTER_SCOPE', 'An affected file requires an external Git filter; use a separately authorized execution path');
      }
    }
  }
  const directory = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'hooks'], { hookPathDiscovery: true })).trim());
  let names;
  try { names = await readdir(directory); }
  catch (failure) { if (['ENOENT', 'ENOTDIR'].includes(failure.code)) return; throw failure; }
  for (const name of names) {
    if (name.endsWith('.sample')) continue;
    let info;
    try { info = await lstat(path.join(directory, name)); }
    catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
    if (info.isSymbolicLink() || info.isFile() && info.mode & 0o111) fail('ORCHESTRATION_GIT_HOOK_SCOPE', 'A configured executable Git hook requires an explicitly authorized execution path; it is not run or bypassed by this narrow tool');
  }
}

export async function gitArtifactSha256(repository, commit) {
  if (!exactCommit(commit)) fail('ORCHESTRATION_DEVELOP_ARTIFACT', 'An exact development commit is required');
  return hash(await git(repository, ['show', '--no-color', '--format=fuller', '--binary', '--no-ext-diff', '--no-textconv', commit], { buffer: true }));
}

/** Validates all path components, including deleted tracked paths; never expands a directory or glob. */
export async function validateGitPaths(worktree, values) {
  if (!Array.isArray(values) || !values.length || values.length > 256 || new Set(values).size !== values.length) fail('ORCHESTRATION_GIT_PATH', 'Explicit distinct file paths are required');
  const snapshots = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\\\0\r\n]/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part))
      || /(^|\/)runtime\/private(\/|$)/.test(value)) fail('ORCHESTRATION_GIT_PATH', 'Only safe worktree-relative files may be committed');
    let current = worktree, missing = false;
    const parts = value.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let info;
      try { info = await lstat(current); }
      catch (failure) { if (failure.code === 'ENOENT') { missing = true; break; } throw failure; }
      if (info.isSymbolicLink() || await realpath(current) !== current) fail('ORCHESTRATION_GIT_SYMLINK', 'Git operation cannot traverse a symlink');
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail('ORCHESTRATION_GIT_PATH', 'Commit paths must name individual regular files');
    }
    if (missing) await git(worktree, ['ls-files', '--error-unmatch', '--', value]);
    snapshots.push({ path: value, deleted: missing, sha256: missing ? null : hash(await readFile(current)) });
  }
  return snapshots;
}

export function createOrchestrationGitTools({ task, run, workspace, assertLease = async () => {} }) {
  if (!task.kind.startsWith('DEVELOP')) return { specs: [], handlers: {} };
  const worktree = workspace.worktree, repository = workspace.repository, baseCommit = workspace.baseCommit;
  if (!worktree || !repository || !workspace.gitDirectory || !workspace.gitBranch || !workspace.repositoryGitDirectory || !exactCommit(baseCommit) || !exactCommit(task.execution?.baseCommit)) fail('ORCHESTRATION_GIT_BINDING', 'A host-created worktree and pinned repository are required');
  let currentHead = baseCommit, tainted = false;
  const memo = new Map(); let tail = Promise.resolve();
  const withinTurn = handler => async (args, identity = {}) => {
    if (identity.callId && memo.has(identity.callId)) return memo.get(identity.callId);
    // A model may issue parallel dynamic calls. One run has only one index and candidate head.
    const operation = tail.then(async () => {
      await assertLease();
      try { return await handler(args); }
      catch (failure) { if (failure.code === 'RESULT_UNKNOWN') tainted = true; throw failure; }
    });
    tail = operation.catch(() => {});
    if (identity.callId) memo.set(identity.callId, operation);
    return operation;
  };
  const validate = async () => {
    if (tainted) fail('RESULT_UNKNOWN', 'The previous Git operation is unknown; this tool instance cannot expose or mutate another candidate until reconciliation');
    if (await realpath(worktree) !== worktree || await realpath(repository) !== repository || await realpath(task.execution.repository) !== repository) fail('ORCHESTRATION_GIT_BINDING', 'The frozen repository or worktree root changed');
    if ((await git(worktree, ['rev-parse', '--show-toplevel'])).trim() !== worktree
      || (await git(repository, ['rev-parse', '--show-toplevel'])).trim() !== repository) fail('ORCHESTRATION_GIT_BINDING', 'Git root changed');
    if ((await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim() !== workspace.gitDirectory
      || (await git(repository, ['rev-parse', '--absolute-git-dir'])).trim() !== workspace.repositoryGitDirectory
      || (await readFile(path.join(workspace.gitDirectory, 'HEAD'), 'utf8')).trim().replace(/^[a-f0-9]{40,64}$/, 'DETACHED') !== workspace.gitBranch
      || (await realpath(path.resolve(workspace.gitDirectory, (await readFile(path.join(workspace.gitDirectory, 'gitdir'), 'utf8')).trim()))) !== path.join(worktree, '.git')) {
      fail('ORCHESTRATION_GIT_BINDING', 'The worktree-specific Git directory, branch or registered backlink changed');
    }
    const common = (await git(worktree, ['rev-parse', '--git-common-dir'])).trim();
    if (await realpath(path.resolve(worktree, common)) !== workspace.gitCommonDirectory) fail('ORCHESTRATION_GIT_BINDING', 'The worktree belongs to a different Git object store');
    if ((await git(worktree, ['rev-parse', 'HEAD'])).trim() !== currentHead) fail('ORCHESTRATION_GIT_HEAD_CHANGED', 'The leased worktree HEAD changed outside its controlled Git tool');
  };
  const artifact = async () => { await validate(); return { commit: currentHead, artifact: { ref: 'git:' + currentHead, sha256: await gitArtifactSha256(repository, currentHead) } }; };
  const specs = [{ type: 'function', name: 'orchestration_git_artifact', description: 'Read the exact pinned/committed Git artifact and its git show SHA256 for this leased worktree. No arbitrary command or commit argument.', inputSchema: object({}) }];
  const handlers = { orchestration_git_artifact: withinTurn(artifact) };
  if (run.phase === 'WORK') {
    specs.push({ type: 'function', name: 'orchestration_commit_candidate', description: 'Stage only the specified individual worktree-relative files and commit a candidate using the controlled host. Use this for Git metadata writes; native sandbox Git index writes may be denied. Returns exact commit and artifact SHA256. Never pushes.',
      inputSchema: object({ paths: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } }) });
    handlers.orchestration_commit_candidate = withinTurn(async args => {
      await validate();
      if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 2000 || args.message.includes('\0')) fail('ORCHESTRATION_GIT_MESSAGE', 'A bounded commit message is required');
      const files = await validateGitPaths(worktree, args.paths);
      await assertSafeGitMutation(worktree, { paths: files.map(item => item.path) });
      if ((await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', '-z'])).length) fail('ORCHESTRATION_GIT_INDEX_DIRTY', 'The isolated index already contains staged changes; do not adopt them');
      await git(worktree, ['add', '--', ...files.map(item => item.path)]);
      const changed = (await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
      if (changed.some(name => !args.paths.includes(name))) fail('ORCHESTRATION_GIT_INDEX_SCOPE', 'The staged index includes an unrequested file');
      if (!changed.length) return { status: 'UNCHANGED', ...await artifact() };
      for (const item of files) if (!item.deleted && hash(await git(worktree, ['show', ':' + item.path], { buffer: true })) !== item.sha256) fail('ORCHESTRATION_GIT_BYTES_CHANGED', 'The staged bytes differ from the observed worktree file');
      const prior = currentHead;
      const expectedTree = (await git(worktree, ['write-tree'])).trim();
      await assertLease();
      await git(worktree, ['commit', '-m', args.message]);
      const committed = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (!exactCommit(committed) || (await git(worktree, ['rev-parse', committed + '^'])).trim() !== prior
        || (await git(worktree, ['rev-parse', committed + '^{tree}'])).trim() !== expectedTree) fail('RESULT_UNKNOWN', 'The candidate commit identity does not have the frozen parent and tree');
      const actual = (await git(worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', committed])).split('\0').filter(Boolean);
      if (actual.some(name => !args.paths.includes(name))) fail('RESULT_UNKNOWN', 'The candidate commit changed an unexpected file');
      currentHead = committed;
      return { status: 'COMMITTED', changedPaths: actual, ...await artifact() };
    });
  }
  if (run.phase === 'FINALIZE') {
    specs.push({ type: 'function', name: 'orchestration_fast_forward', description: 'Fast-forward only the frozen execution.repository to the exact QA-approved candidate. Refuses dirty repositories, changed HEAD or non-fast-forward integration. No push or arbitrary arguments.', inputSchema: object({}) });
    handlers.orchestration_fast_forward = withinTurn(async () => {
      await validate();
      const approved = task.artifacts?.filter(item => item.ref.startsWith('git:')) || [];
      if (approved.length !== 1 || approved[0].ref !== 'git:' + currentHead || await gitArtifactSha256(repository, currentHead) !== approved[0].sha256) fail('ORCHESTRATION_ARTIFACT_DRIFT', 'Finalization must use the single exact QA-approved candidate');
      const checkoutPaths = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', task.execution.baseCommit, currentHead])).split('\0').filter(Boolean);
      await assertSafeGitMutation(repository, { paths: checkoutPaths, source: currentHead });
      if ((await git(repository, ['status', '--porcelain', '--untracked-files=all'])).trim()) fail('ORCHESTRATION_GIT_SOURCE_DIRTY', 'The integration repository contains unconfirmed changes');
      const branch = (await git(repository, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
      if (!branch.startsWith('refs/heads/') || 'ref: ' + branch !== workspace.repositoryBranch) fail('ORCHESTRATION_GIT_SOURCE_DETACHED', 'Integration requires the frozen checked-out branch');
      const before = (await git(repository, ['rev-parse', 'HEAD'])).trim();
      if (before !== task.execution.baseCommit && before !== currentHead) fail('ORCHESTRATION_GIT_SOURCE_DRIFT', 'Integration repository HEAD moved from the task base');
      if (before !== currentHead) {
        await git(repository, ['merge-base', '--is-ancestor', before, currentHead]);
        // Check again directly before mutation; Git itself takes its index/ref locks during merge.
        if ((await git(repository, ['rev-parse', 'HEAD'])).trim() !== before || (await git(repository, ['status', '--porcelain', '--untracked-files=all'])).trim()) fail('ORCHESTRATION_GIT_SOURCE_DRIFT', 'Integration source changed before fast-forward');
        await assertLease();
        await git(repository, ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', currentHead]);
      }
      if ((await git(repository, ['rev-parse', 'HEAD'])).trim() !== currentHead || (await git(repository, ['status', '--porcelain', '--untracked-files=all'])).trim()) fail('RESULT_UNKNOWN', 'Fast-forward completed without an exact clean readback');
      return { status: before === currentHead ? 'ALREADY_INTEGRATED' : 'FAST_FORWARDED', repository, branch, previousHead: before, ...await artifact() };
    });
  }
  return { specs, handlers };
}
