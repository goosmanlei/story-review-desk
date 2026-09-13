import { constants } from 'node:fs';
import { open, mkdir, readlink, symlink, rename, rm, lstat, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { check, hash } from '../shared/contracts.mjs';
import { transaction } from '../db.mjs';
import { libraryHead, librarySnapshot } from './catalog.mjs';
import { LIBRARY_FORMAT, libraryPath } from './contract.mjs';
import { processLock, openPhase } from '../../tools/process-resources.mjs';
import { startProcessPhase, main as processCommand } from '../../tools/process.mjs';

const absent = error => { if (error.code !== 'ENOENT') throw error; return null; };
const info = file => lstat(file).catch(absent);
const queues = new Map();
const metadataRoot = root => path.join(root, 'runtime/review-library');
async function plainDirectory(directory, create = false) {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create && !await info(current)) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const st = await lstat(current);
    check(st.isDirectory() && !st.isSymbolicLink(), 'LIBRARY_DIRECTORY', '审阅目录父路径不是普通目录', 409);
  }
}
async function readBytes(file, max = 24 * 1024 ** 2) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    check(st.isFile() && st.size <= max, 'LIBRARY_METADATA', '审阅元数据文件无效', 409);
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function write(file, bytes, mode = 0o400) {
  const handle = await open(file, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function stateRead(root) {
  if (!await info(metadataRoot(root))) return { current: null, previous: null, retired: [] };
  await plainDirectory(metadataRoot(root));
  const file = path.join(metadataRoot(root), 'state.json');
  return await info(file) ? JSON.parse(await readBytes(file)) : { current: null, previous: null, retired: [] };
}
async function stateWrite(root, state) {
  const tmp = path.join(metadataRoot(root), randomUUID() + '.tmp');
  try { await write(tmp, JSON.stringify(state) + '\n', 0o600); await rename(tmp, path.join(metadataRoot(root), 'state.json')); }
  finally { await rm(tmp, { force: true }); }
}
function directoryFor(root, generation) {
  check(/^\.process\/shared\/review-library-[a-f0-9-]{36}$/.test(generation?.directory || ''), 'LIBRARY_OWNER', '审阅目录不属于受管资源', 409);
  return path.join(path.dirname(root), generation.directory);
}
async function manifestRead(root, generation) {
  const directory = directoryFor(root, generation);
  await plainDirectory(directory);
  const bytes = await readBytes(path.join(directory, 'manifest.json'));
  check(hash(bytes) === generation.manifestSha256, 'LIBRARY_MANIFEST_HASH', '审阅索引已改变', 409);
  const manifest = JSON.parse(bytes);
  check(Number.isInteger(manifest.formatVersion) && manifest.formatVersion >= 1 && manifest.formatVersion <= LIBRARY_FORMAT && Array.isArray(manifest.entries), 'LIBRARY_FORMAT', '审阅索引格式不兼容', 409);
  return manifest;
}
async function assertRoot(root, state) {
  const entry = path.join(path.dirname(root), 'review-library');
  const st = await info(entry);
  if (!st) return null;
  check(st.isSymbolicLink(), 'LIBRARY_ROOT_OCCUPIED', 'review-library 已被其他文件或目录占用，未覆盖', 409);
  const target = await readlink(entry);
  const candidates = [state.current, state.previous, state.pending].filter(Boolean);
  const generation = candidates.find(g => target === g.directory + '/tree');
  check(generation, 'LIBRARY_ROOT_OCCUPIED', 'review-library 不是本实例登记的入口，未覆盖', 409);
  return generation;
}
const fingerprint = st => [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode].map(String).join(':');
async function verifyBlob(file, sha256, size, fingerprints, full, protect = false) {
  check(/^[a-f0-9]{64}$/.test(sha256), 'LIBRARY_SHA', '媒体 SHA 无效');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    check(false, 'LIBRARY_BLOB_MISSING', '审阅原件缺失或路径不是普通文件', 409, { sha256, cause: error.code });
  });
  try {
    let st = await handle.stat({ bigint: true });
    check(st.isFile() && Number(st.size) === size, 'LIBRARY_BLOB_SIZE', '审阅原件与登记大小不一致', 409, { sha256 });
    if (full || fingerprints[sha256] !== fingerprint(st)) {
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await handle.stat({ bigint: true });
      check(fingerprint(st) === fingerprint(after) && digest.digest('hex') === sha256, 'LIBRARY_BLOB_HASH', '审阅原件与登记 SHA 不一致', 409, { sha256 });
    }
    if (protect && (Number(st.mode) & 0o222) !== 0) { await handle.chmod(Number(st.mode) & ~0o222); st = await handle.stat({ bigint: true }); }
    check(fingerprint(st) === fingerprint(await lstat(file, { bigint: true })), 'LIBRARY_BLOB_CHANGED', '校验过程中原件路径被替换', 409, { sha256 });
    fingerprints[sha256] = fingerprint(st);
  } finally { await handle.close(); }
}
function targetFor(root, generation, entry) {
  return entry.kind === 'media' ? path.join(root, 'media', entry.sha256) : path.join(directoryFor(root, generation), 'text-blobs', entry.sha256);
}
async function checkGeneration(root, generation, fingerprints = {}, full = false, checkMedia = true) {
  const manifest = await manifestRead(root, generation), directory = directoryFor(root, generation);
  check(hash(await readBytes(path.join(directory, 'tree/README.md'))) === manifest.readmeSha256, 'LIBRARY_README_HASH', '目录说明已被修改', 409);
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!entry.path) continue;
    libraryPath(entry.path);
    const file = path.join(directory, 'tree', entry.path), target = targetFor(root, generation, entry);
    await plainDirectory(path.dirname(file));
    check((await info(file))?.isSymbolicLink() && await readlink(file) === path.relative(path.dirname(file), target), 'LIBRARY_LINK_CHANGED', '审阅链接被替换或指向其他原件', 409, { path: entry.path });
    if (!seen.has(target) && (checkMedia || entry.kind !== 'media')) { await verifyBlob(target, entry.sha256, entry.bytes, fingerprints, full, checkMedia); seen.add(target); }
  }
  check(await readlink(path.join(directory, 'tree/.catalog.json')) === '../manifest.json', 'LIBRARY_INDEX_CHANGED', '目录索引入口已改变', 409);
  return { manifest, fingerprints, checkedBlobs: seen.size };
}
// Only the owned tree is inspected; links are checked as directory entries and never followed for deletion.
async function assertOwnedContents(root, generation) {
  const directory = directoryFor(root, generation), manifest = await manifestRead(root, generation);
  const expected = new Set(['manifest.json','tree/README.md','tree/.catalog.json']);
  for (const entry of manifest.entries.filter(e => e.path)) {
    expected.add('tree/' + entry.path);
    if (entry.kind !== 'media') expected.add('text-blobs/' + entry.sha256);
  }
  async function scan(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path.join(dir, entry.name), relative + '/');
      else check(expected.delete(relative), 'LIBRARY_UNOWNED_FILE', '审阅目录存在未登记文件，保留并停止清理', 409, { path: relative });
    }
  }
  await scan(directory);
  check(expected.size === 0, 'LIBRARY_OWNED_FILE_MISSING', '旧审阅目录不完整，停止清理', 409);
  await checkGeneration(root, generation, {}, true, false);
}
async function retire(root, state) {
  const pending = [];
  for (const generation of state.retired || []) {
    try {
      if (await info(directoryFor(root, generation))) {
        check(![state.current, state.previous, state.pending].some(g => g?.directory === generation.directory), 'LIBRARY_IN_USE', '不能清理当前审阅目录');
        const active = await assertRoot(root, state);
        check(active?.directory !== generation.directory, 'LIBRARY_IN_USE', '审阅入口仍在使用该目录');
        await assertOwnedContents(root, generation);
        const phase = await openPhase({ ...generation.context, root: path.dirname(root) });
        await phase.update(record => {
          const resource = record.resources.find(r => r.path === directoryFor(root, generation));
          check(resource?.state === 'RETAINED', 'LIBRARY_OWNER', '旧目录没有保留回执');
          resource.state = 'TEMPORARY'; delete resource.reason; record.status = 'CLEANING';
        });
        const receipt = await phase.finish();
        check(receipt.status === 'CLEANED', 'LIBRARY_CLEANUP', '旧目录仍有消费者或未完成清理', 409);
      }
    } catch (error) { pending.push({ ...generation, error: error.message }); }
  }
  state.retired = pending;
}
function readme(snapshot) {
  const texts = snapshot.entries.filter(e => e.kind !== 'media');
  return Buffer.from(`# 资源审阅目录\n\n此目录由审阅台自动维护。文件名使用业务语义，正文保留原语言。\n\n` +
    `媒体入口绑定固定版本和 SHA；当前剧本是随系统正文更新的只读导出。软链没有独立写权限，请通过业务接口保存修改。\n\n` +
    `- 查看同步状态：\`npm run review -- library status\`\n- 完整校验：\`npm run review -- library verify\`\n- 精确定位：\`npm run review -- library resolve review-library/相对文件路径\`\n- 列举文件：\`rg --files --hidden --no-ignore -L review-library\`\n- 名称、版本及来源映射：\`.catalog.json\`（含中文名称，可供搜索）\n\n` +
    `## 文本\n\n${texts.map(e => `- [${e.title}](${e.path})（${e.state}）`).join('\n') || '本项目尚未选择目录文本。'}\n\n` +
    `## 媒体\n\nimages 按人物、场景、道具、分镜及参考组织；audio 按声音、对白、环境声、音乐、音效及来源组织；videos 按预演、镜头及合成组织。归属不足的文件位于 unclassified。\n\n候选、历史、预览和采用状态见索引。可打开、已登记或同步成功不表示已观察、已采用或权利已确认。\n`);
}
const countsFor = entries => ({ entries: entries.length, files: entries.filter(e => e.path).length,
  media: entries.filter(e => e.kind === 'media' && e.path).length, texts: entries.filter(e => e.kind !== 'media').length,
  unavailable: entries.filter(e => !e.path && !e.excluded).length });
async function synchronize(pool, root, { full = false } = {}) {
  await plainDirectory(root);
  await plainDirectory(metadataRoot(root), true);
  return processLock(path.join(metadataRoot(root), 'sync.lock'), async () => {
    let state = await stateRead(root), phase, generation, retained = false;
    try {
      const active = await assertRoot(root, state);
      if (state.pending) {
        if (active?.directory === state.pending.directory) {
          await checkGeneration(root, state.pending, {}, true);
          if (state.previous) state.retired.push(state.previous);
          state.previous = state.current; state.current = state.pending;
        } else if (await info(directoryFor(root, state.pending))) state.retired.push(state.pending);
        delete state.pending;
        await stateWrite(root, state);
      }
      const head = await transaction(pool, libraryHead, { readOnly: true });
      check(JSON.parse(await readBytes(path.join(root, 'instance.json'))).id === head.instanceId, 'LIBRARY_INSTANCE', '目录与数据库实例身份不一致', 409);
      if (!head.enabled) { state.status = 'DISABLED'; await stateWrite(root, state); return publicState(state); }
      const fingerprints = state.fingerprints || {};
      if (state.current && active) {
        const previous = await manifestRead(root, state.current);
        const unchanged = previous.token === head.token && previous.formatVersion === LIBRARY_FORMAT;
        await checkGeneration(root, state.current, fingerprints, full, unchanged);
        if (unchanged) {
          Object.assign(state, { status: 'CURRENT', counts: countsFor(previous.entries), error: null, fingerprints, checkedAt: new Date().toISOString() });
          await retire(root, state); await stateWrite(root, state);
          return publicState(state);
        }
      }
      const snapshot = await librarySnapshot(pool), id = randomUUID();
      check(snapshot.enabled, 'LIBRARY_CHANGED', '目录配置在同步期间已改变', 409);
      const project = path.dirname(root), taskId = 'review-library-' + id;
      phase = await startProcessPhase(project, taskId, 'sync');
      await phase.budget();
      generation = { directory: '.process/shared/review-library-' + id, context: await phase.context() };
      const directory = await phase.directory(directoryFor(root, generation));
      for (const part of ['tree/texts/sources','tree/texts/screenplays','tree/images','tree/audio','tree/videos','tree/other','text-blobs']) await mkdir(path.join(directory, part), { recursive: true, mode: 0o700 });
      const previousManifest = state.current ? await manifestRead(root, state.current) : null;
      const oldNames = new Map((previousManifest?.entries || []).filter(e => e.kind === 'media').map(e => [e.key, e.path]));
      const names = new Set();
      for (const entry of snapshot.entries) {
        if (!entry.path) continue;
        if (entry.kind === 'media' && oldNames.get(entry.key)) entry.path = oldNames.get(entry.key);
        libraryPath(entry.path);
        check(!names.has(entry.path), 'LIBRARY_NAME_COLLISION', '审阅路径冲突', 409, { path: entry.path });
        names.add(entry.path);
      }
      for (const blob of snapshot.blobs) {
        const file = path.join(directory, 'text-blobs', blob.sha256);
        if (await info(file)) continue;
        const bytes = blob.bytes || await readBytes(path.join(root, 'media', blob.sourceMediaSha256));
        check(hash(bytes) === blob.sha256, 'LIBRARY_SOURCE_HASH', '文本缓存 SHA 不符', 409);
        await write(file, bytes);
      }
      for (const entry of snapshot.entries) {
        if (!entry.path) continue;
        const file = path.join(directory, 'tree', entry.path), target = targetFor(root, generation, entry);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await symlink(path.relative(path.dirname(file), target), file);
      }
      const description = readme(snapshot);
      await write(path.join(directory, 'tree/README.md'), description);
      const manifest = { formatVersion: LIBRARY_FORMAT, instanceId: snapshot.instanceId, runtimeEpoch: snapshot.runtimeEpoch, token: snapshot.token,
        createdAt: new Date().toISOString(), readmeSha256: hash(description), entries: snapshot.entries };
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      generation.manifestSha256 = hash(bytes);
      await write(path.join(directory, 'manifest.json'), bytes);
      await symlink('../manifest.json', path.join(directory, 'tree/.catalog.json'));
      const checked = await checkGeneration(root, generation, fingerprints, full);
      const latest = await transaction(pool, libraryHead, { readOnly: true });
      check(latest.token === snapshot.token, 'LIBRARY_CHANGED', '同步期间业务已更新，将重新生成目录', 409);
      state.pending = generation;
      await stateWrite(root, state);
      await phase.retain('path', directory, '当前或上一份资源审阅目录，可从数据库与 SHA 原件重建');
      retained = true;
      const swap = path.join(project, '.review-library-' + id);
      await symlink(generation.directory + '/tree', swap);
      try { await assertRoot(root, state); await rename(swap, path.join(project, 'review-library')); }
      finally { await rm(swap, { force: true }); }
      if (state.previous) state.retired.push(state.previous);
      state.previous = state.current; state.current = generation; delete state.pending;
      Object.assign(state, { status: 'CURRENT', error: null, checkedAt: new Date().toISOString(), fingerprints: checked.fingerprints,
        counts: countsFor(snapshot.entries) });
      await stateWrite(root, state);
      await retire(root, state); await stateWrite(root, state);
      return publicState(state);
    } catch (error) {
      if (!retained && state.pending?.directory === generation?.directory) delete state.pending;
      Object.assign(state, { status: error.code === 'LIBRARY_CHANGED' ? 'STALE' : 'ERROR', error: { code: error.code || 'LIBRARY_SYNC_FAILED', message: error.message }, checkedAt: new Date().toISOString() });
      await stateWrite(root, state);
      throw error;
    } finally {
      if (phase) {
        const record = await phase.finish({ outcome: state.status === 'CURRENT' ? 'SUCCEEDED' : 'FAILED' });
        if (record.status === 'CLEANED') await processCommand(['finish','--root',path.dirname(root),'--task',record.taskId]);
      }
    }
  });
}
export function syncLibrary(pool, root, options) {
  const prior = queues.get(root) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => synchronize(pool, root, options));
  queues.set(root, run);
  run.finally(() => { if (queues.get(root) === run) queues.delete(root); }).catch(() => {});
  return run;
}
function publicState(state) {
  return { status: state.status || 'NOT_BUILT', root: 'review-library', counts: state.counts || null,
    checkedAt: state.checkedAt || null, error: state.error || null, cleanupPending: state.retired?.length || 0,
    generation: state.current?.manifestSha256 || null };
}
export async function readLibrary(pool, root, { entryPath, entries = false } = {}) {
  const state = await stateRead(root), result = publicState(state);
  const head = await transaction(pool, libraryHead, { readOnly: true });
  check(JSON.parse(await readBytes(path.join(root, 'instance.json'))).id === head.instanceId, 'LIBRARY_INSTANCE', '目录与数据库实例身份不一致', 409);
  if (!head.enabled) return { ...result, status: 'DISABLED' };
  if (!state.current) return result;
  const active = await assertRoot(root, state);
  if (!active || active.directory !== state.current.directory) return { ...result, status: 'STALE' };
  const manifest = await manifestRead(root, state.current);
  if (manifest.token !== head.token && result.status !== 'ERROR') result.status = 'STALE';
  if (entryPath) {
    const relative = libraryPath(entryPath.replace(/^review-library\//, ''));
    const entry = manifest.entries.find(e => e.path === relative);
    check(entry, 'LIBRARY_ENTRY_NOT_FOUND', '此路径不在审阅索引中', 404);
    const file = path.join(directoryFor(root, state.current), 'tree', relative), target = targetFor(root, state.current, entry);
    await plainDirectory(path.dirname(file));
    check((await info(file))?.isSymbolicLink() && await readlink(file) === path.relative(path.dirname(file), target), 'LIBRARY_LINK_CHANGED', '审阅链接已改变', 409);
    await verifyBlob(target, entry.sha256, entry.bytes, {}, true);
    return { ...result, entry, exactPath: path.relative(path.dirname(root), target), instanceId: manifest.instanceId, runtimeEpoch: manifest.runtimeEpoch };
  }
  return { ...result, ...(entries ? { entries: manifest.entries } : {}) };
}
