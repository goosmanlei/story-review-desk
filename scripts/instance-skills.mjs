/** Install the Skill shipped by a project's exact software package. */
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {verifySoftwarePackage, verifySoftwarePin} from './instance-software-pin.mjs';

export const orchestrationSkillName = 'story-review-orchestrator';
export const orchestrationSkillPath = '.agents/skills/' + orchestrationSkillName;
const receiptName = 'managed-install.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const relativeFile = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const exists = async filename => {try {return await lstat(filename);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}};

async function directory(root, relative, create = false) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let info = await exists(current);
    if (!info && create) {await mkdir(current, {mode: 0o755}); info = await lstat(current);}
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw Error('Skill directory must be canonical and cannot be a symlink: ' + current);
  }
  return true;
}

async function packageInputs({project, software}) {
  if (typeof project !== 'string' || !project) throw Error('An explicit --project is required; parent projects are never searched');
  const root = path.resolve(project);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw Error('Project must be a canonical directory');
  const packaged = path.resolve(software || path.join(root, 'review-software'));
  if (packaged !== path.join(root, 'review-software')) throw Error('Skill source must be this project\'s portable review-software package');
  const source = await verifySoftwarePackage(packaged);
  if (await exists(path.join(root, 'core-lock.json'))) {
    const pin = await verifySoftwarePin(root);
    if (pin.software !== packaged || pin.pin.softwareManifestSha256 !== source.manifestSha256) throw Error('Core pin changed while verifying Skill source');
  }
  const declaration = source.manifest.skills?.filter(item => item.name === orchestrationSkillName);
  const prefix = orchestrationSkillPath + '/';
  const entries = source.manifest.files.filter(item => item.path.startsWith(prefix));
  const declared = declaration?.[0];
  if (declaration?.length !== 1 || declared.path !== orchestrationSkillPath || !Array.isArray(declared.files) || !entries.length ||
      JSON.stringify([...declared.files].sort()) !== JSON.stringify(entries.map(item => item.path).sort())) throw Error('Software manifest does not declare the complete orchestration Skill');
  const files = entries.map(item => ({path: item.path.slice(prefix.length), bytes: item.bytes, sha256: item.sha256})).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some(item => item.path === 'SKILL.md') || !files.some(item => item.path === 'agents/openai.yaml') || files.some(item => item.path === receiptName)) throw Error('Packaged Skill has an invalid entrypoint or receipt');
  return {root, software: packaged, source, files, target: path.join(root, orchestrationSkillPath)};
}

function validateReceipt(receipt) {
  if (receipt.schemaVersion !== '1.0' || receipt.kind !== 'MANAGED_PROJECT_SKILL' || receipt.name !== orchestrationSkillName ||
      receipt.packagePath !== 'review-software' || receipt.sourcePath !== orchestrationSkillPath || !/^[a-f0-9]{40}$/.test(receipt.coreCommit || '') ||
      !/^[a-f0-9]{64}$/.test(receipt.softwareManifestSha256 || '') || !Array.isArray(receipt.files) || !receipt.files.length) throw Error('Invalid managed Skill receipt; existing files are preserved');
  const paths = new Set();
  for (const file of receipt.files) {
    if (!relativeFile(file.path) || file.path === receiptName || paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw Error('Invalid managed Skill file entry');
    paths.add(file.path);
  }
  if (!paths.has('SKILL.md')) throw Error('Invalid managed Skill entrypoint');
}

async function inspectInstalled(target) {
  const info = await exists(target);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw Error('User Skill conflict: target must be a canonical directory');
  const receiptPath = path.join(target, receiptName), receiptInfo = await exists(receiptPath);
  if (!receiptInfo?.isFile() || receiptInfo.isSymbolicLink()) throw Error('User Skill conflict: no managed receipt; existing files are preserved');
  const receiptBytes = await readFile(receiptPath), receipt = JSON.parse(receiptBytes);
  validateReceipt(receipt);
  const known = new Map(receipt.files.map(file => [file.path, file]));
  const seen = new Set();
  async function walk(relative = '') {
    for (const item of await readdir(path.join(target, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + item.name : item.name, filename = path.join(target, name);
      if (item.isSymbolicLink() || await realpath(filename) !== filename) throw Error('User Skill conflict: symlink ' + name);
      if (item.isDirectory()) {
        if (![...known.keys()].some(key => key.startsWith(name + '/'))) throw Error('User Skill conflict: unknown directory ' + name);
        await walk(name);
      } else if (name === receiptName && item.isFile()) continue;
      else {
        const expected = known.get(name);
        if (!item.isFile() || !expected) throw Error('User Skill conflict: unknown file ' + name);
        const bytes = await readFile(filename);
        if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw Error('User-modified Skill file cannot be overwritten: ' + name);
        seen.add(name);
      }
    }
  }
  await walk();
  if (seen.size !== known.size) throw Error('User Skill conflict: managed files are missing');
  return {receipt, receiptSha256: digest(receiptBytes)};
}

function assertVersion(installed, input) {
  if (installed.receipt.coreCommit !== input.source.manifest.softwareCommit || installed.receipt.softwareManifestSha256 !== input.source.manifestSha256 ||
      JSON.stringify(installed.receipt.files) !== JSON.stringify(input.files)) throw Error('Skill version differs from the pinned software; run instance-skills.mjs install for the managed upgrade');
}

function result(input, status) {
  return {schemaVersion: '1.0', status, skill: orchestrationSkillName, projectRoot: input.root,
    coreCommit: input.source.manifest.softwareCommit, softwareManifestSha256: input.source.manifestSha256,
    manifestSha256: input.source.manifestSha256, fileCount: input.files.length, activationChanged: false};
}

export async function verifyProjectSkill(options) {
  const input = await packageInputs(options);
  await directory(input.root, '.agents/skills');
  const installed = await inspectInstalled(input.target);
  if (!installed) throw Error('Project Skill is not installed; run instance-skills.mjs install --project PROJECT');
  assertVersion(installed, input);
  return result(input, 'PROJECT_SKILL_VERIFIED');
}

async function removeKnownTree(target, files) {
  // Called only for our own staged bytes or a re-verified old managed copy.
  for (const file of [...files, {path: receiptName}]) await unlink(path.join(target, file.path));
  const directories = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') {directories.add(parent); parent = path.posix.dirname(parent);}
  }
  for (const item of [...directories].sort((a, b) => b.length - a.length)) await rmdir(path.join(target, item));
  await rmdir(target);
}

export async function installProjectSkill(options) {
  const input = await packageInputs(options);
  await directory(input.root, '.agents/skills');
  let previous = await inspectInstalled(input.target);
  if (previous) {
    try {assertVersion(previous, input); return result(input, 'PROJECT_SKILL_CURRENT');} catch { /* A verified older managed copy can be upgraded. */ }
  }
  await directory(input.root, '.agents/skills', true);
  const parent = path.dirname(input.target), lock = path.join(parent, '.' + orchestrationSkillName + '.install-lock');
  try {await mkdir(lock, {mode: 0o700});} catch (error) {if (error.code === 'EEXIST') throw Error('Another Skill installation is active or interrupted; inspect its lock before recovery'); throw error;}
  let stage = null, backup = null, stageReady = false;
  try {
    // Recheck after acquiring the installation lock; never adopt unknown files.
    previous = await inspectInstalled(input.target);
    stage = await mkdtemp(path.join(parent, '.' + orchestrationSkillName + '.install-'));
    for (const file of input.files) {
      const bytes = await readFile(path.join(input.software, orchestrationSkillPath, file.path));
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw Error('Packaged Skill changed during installation: ' + file.path);
      await mkdir(path.dirname(path.join(stage, file.path)), {recursive: true});
      await writeFile(path.join(stage, file.path), bytes, {flag: 'wx', mode: 0o644});
    }
    const receipt = {schemaVersion: '1.0', kind: 'MANAGED_PROJECT_SKILL', name: orchestrationSkillName, packagePath: 'review-software',
      sourcePath: orchestrationSkillPath, coreCommit: input.source.manifest.softwareCommit, softwareManifestSha256: input.source.manifestSha256, files: input.files};
    await writeFile(path.join(stage, receiptName), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o644});
    stageReady = true;
    const freshInput = await packageInputs(options);
    if (freshInput.source.manifestSha256 !== input.source.manifestSha256) throw Error('Software package changed during Skill installation');
    const current = await inspectInstalled(input.target);
    if (current?.receiptSha256 !== previous?.receiptSha256) throw Error('Installed Skill changed during upgrade; existing files are preserved');
    if (previous) {
      backup = stage + '.previous';
      await rename(input.target, backup);
    }
    try {await rename(stage, input.target); stage = null;}
    catch (error) {if (backup) {await rename(backup, input.target); backup = null;} throw error;}
    const verified = await verifyProjectSkill(options);
    if (backup) {
      try {await inspectInstalled(backup); await removeKnownTree(backup, previous.receipt.files); backup = null;}
      catch {return {...verified, status: 'PROJECT_SKILL_INSTALLED', preservedPreviousCopy: backup};}
    }
    return {...verified, status: previous ? 'PROJECT_SKILL_UPDATED' : 'PROJECT_SKILL_INSTALLED'};
  } finally {
    // Incomplete or externally edited staging/backup directories remain recoverable.
    if (stage && stageReady) {
      try {await inspectInstalled(stage); await removeKnownTree(stage, input.files);} catch { /* Preserve unverifiable bytes. */ }
    }
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {project: {type: 'string'}, software: {type: 'string'}}});
  const [command] = positionals;
  if (positionals.length !== 1 || !['install', 'verify'].includes(command)) throw Error('Usage: node scripts/instance-skills.mjs install|verify --project PROJECT [--software PROJECT/review-software]');
  console.log(JSON.stringify(await (command === 'install' ? installProjectSkill(values) : verifyProjectSkill(values)), null, 2));
}
