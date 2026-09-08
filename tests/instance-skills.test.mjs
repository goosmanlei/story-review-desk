import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, writeFile, realpath, rename, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {installProjectSkill, verifyProjectSkill, orchestrationSkillPath, orchestrationSkillName} from '../scripts/instance-skills.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, {pin = true} = {}) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'project-skill-')));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const project = path.join(temporary, 'project'), software = path.join(project, 'review-software');
  await mkdir(software, {recursive: true});
  const source = new URL('../', import.meta.url), bytesByPath = new Map();
  async function copyTree(relative) {
    for (const item of await readdir(new URL(relative + '/', source), {withFileTypes: true})) {
      const filename = relative + '/' + item.name;
      if (item.isDirectory()) await copyTree(filename);
      else bytesByPath.set(filename, await readFile(new URL(filename, source)));
    }
  }
  await copyTree(orchestrationSkillPath);
  for (const name of ['scripts/instance-skills.mjs', 'scripts/instance-software-pin.mjs']) bytesByPath.set(name, await readFile(new URL(name, source)));
  let commit = 'a'.repeat(40), manifest;
  async function persist({newCommit, changes = {}} = {}) {
    if (newCommit) commit = newCommit;
    for (const [name, bytes] of Object.entries(changes)) {
      if (bytes === null) {bytesByPath.delete(name); await rm(path.join(software, name));}
      else bytesByPath.set(name, Buffer.from(bytes));
    }
    for (const [name, bytes] of bytesByPath) {
      await mkdir(path.dirname(path.join(software, name)), {recursive: true});
      await writeFile(path.join(software, name), bytes);
    }
    manifest = {schemaVersion: '1.0', kind: 'STORY_NEUTRAL_SOFTWARE', softwareCommit: commit, copiedBusinessData: false, copiedCredentials: false,
      productionStorySpecificHits: [], files: [...bytesByPath].map(([name, bytes]) => ({path: name, bytes: bytes.length, sha256: sha(bytes)})),
      skills: [{name: orchestrationSkillName, path: orchestrationSkillPath, files: [...bytesByPath.keys()].filter(name => name.startsWith(orchestrationSkillPath + '/')).sort()}]};
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(path.join(software, 'software-manifest.json'), bytes);
    if (pin) await writeFile(path.join(project, 'core-lock.json'), JSON.stringify({schemaVersion: '1.0', kind: 'CORE_SOFTWARE_PIN', packagePath: 'review-software',
      repository: 'https://github.com/example/core', commit, softwareManifestSha256: sha(bytes)}));
    return manifest;
  }
  await persist();
  return {temporary, project, software, bytesByPath, persist, installed: path.join(project, orchestrationSkillPath), manifest: () => manifest};
}

test('installation uses exact package Skill bytes, makes no activation, and is idempotent', async t => {
  const f = await fixture(t), result = await installProjectSkill({project: f.project});
  assert.equal(result.status, 'PROJECT_SKILL_INSTALLED');
  assert.equal(result.activationChanged, false);
  assert.equal(result.coreCommit, 'a'.repeat(40));
  for (const [name, bytes] of f.bytesByPath) if (name.startsWith(orchestrationSkillPath + '/')) assert.deepEqual(await readFile(path.join(f.project, name)), bytes);
  const receiptFile = path.join(f.installed, 'managed-install.json'), before = await readFile(receiptFile);
  assert.equal((await installProjectSkill({project: f.project})).status, 'PROJECT_SKILL_CURRENT');
  assert.deepEqual(await readFile(receiptFile), before);
  assert.equal((await verifyProjectSkill({project: f.project})).status, 'PROJECT_SKILL_VERIFIED');
  const receipt = JSON.parse(before);
  assert.equal(receipt.packagePath, 'review-software');
  assert(!before.toString().includes(f.project));
  assert.equal((await readdir(f.project)).includes('instance'), false);
});

test('fresh project creation can pin its Skill to the exact issued manifest before Git repository binding', async t => {
  const f = await fixture(t, {pin: false});
  assert.equal((await installProjectSkill({project: f.project})).status, 'PROJECT_SKILL_INSTALLED');
  assert.equal((await verifyProjectSkill({project: f.project})).softwareManifestSha256, sha(await readFile(path.join(f.software, 'software-manifest.json'))));
});

test('moving the whole project works without a core checkout or absolute installation paths', async t => {
  const f = await fixture(t); await installProjectSkill({project: f.project});
  const moved = path.join(f.temporary, 'moved'); await rename(f.project, moved);
  const run = spawnSync(process.execPath, [path.join(moved, 'review-software/scripts/instance-skills.mjs'), 'verify', '--project', moved], {cwd: f.temporary, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'PROJECT_SKILL_VERIFIED');
});

test('managed upgrade replaces exact old Skill bytes and removes only formerly managed files', async t => {
  const f = await fixture(t); await installProjectSkill({project: f.project});
  const retired = orchestrationSkillPath + '/references/development.md';
  await f.persist({newCommit: 'b'.repeat(40), changes: {[orchestrationSkillPath + '/SKILL.md']: '---\nname: story-review-orchestrator\ndescription: Updated fixture\n---\nUpdated\n', [retired]: null}});
  await assert.rejects(verifyProjectSkill({project: f.project}), /Skill version differs/);
  assert.equal((await installProjectSkill({project: f.project})).status, 'PROJECT_SKILL_UPDATED');
  assert.equal((await verifyProjectSkill({project: f.project})).coreCommit, 'b'.repeat(40));
  await assert.rejects(readFile(path.join(f.project, retired)), {code: 'ENOENT'});
  assert.deepEqual(await readdir(path.dirname(f.installed)), [orchestrationSkillName]);
});

test('user edits block both verification and upgrade without modifying either the edited or clean files', async t => {
  const f = await fixture(t); await installProjectSkill({project: f.project});
  const entry = path.join(f.installed, 'SKILL.md'), receipt = await readFile(path.join(f.installed, 'managed-install.json'));
  const unchanged = await readFile(path.join(f.installed, 'references/main.md'));
  await writeFile(entry, 'user work'); await f.persist({newCommit: 'b'.repeat(40)});
  await assert.rejects(verifyProjectSkill({project: f.project}), /User-modified/);
  await assert.rejects(installProjectSkill({project: f.project}), /User-modified/);
  assert.equal(await readFile(entry, 'utf8'), 'user work');
  assert.deepEqual(await readFile(path.join(f.installed, 'managed-install.json')), receipt);
  assert.deepEqual(await readFile(path.join(f.installed, 'references/main.md')), unchanged);
});

for (const kind of ['file', 'directory', 'symlink', 'missing-file', 'unmanaged-copy']) test('unknown or incomplete local Skill blocks installation: ' + kind, async t => {
  const f = await fixture(t); await installProjectSkill({project: f.project});
  if (kind === 'file') await writeFile(path.join(f.installed, 'user-note.md'), 'keep');
  if (kind === 'directory') await mkdir(path.join(f.installed, 'user-assets'));
  if (kind === 'symlink') await symlink(path.join(f.installed, 'SKILL.md'), path.join(f.installed, 'linked.md'));
  if (kind === 'missing-file') await rm(path.join(f.installed, 'references/main.md'));
  if (kind === 'unmanaged-copy') await rm(path.join(f.installed, 'managed-install.json'));
  await assert.rejects(installProjectSkill({project: f.project}), /User Skill conflict/);
  assert.deepEqual(await readdir(path.dirname(f.installed)), [orchestrationSkillName]);
});

test('source package, core lock, and installed Skill must share the exact version', async t => {
  const f = await fixture(t); await installProjectSkill({project: f.project});
  await writeFile(path.join(f.software, orchestrationSkillPath, 'SKILL.md'), 'changed source');
  await assert.rejects(verifyProjectSkill({project: f.project}), /Managed software changed/);
  await f.persist();
  const pinPath = path.join(f.project, 'core-lock.json'), pin = JSON.parse(await readFile(pinPath, 'utf8'));
  pin.commit = 'c'.repeat(40); await writeFile(pinPath, JSON.stringify(pin));
  await assert.rejects(installProjectSkill({project: f.project}), /manifest differs/);
});

test('unversioned software cannot install a managed production Skill', async t => {
  const f = await fixture(t, {pin: false}); await f.persist({newCommit: 'UNVERSIONED'});
  await assert.rejects(installProjectSkill({project: f.project}), /manifest differs/);
});

test('manifest omission cannot silently install an incomplete Skill', async t => {
  const f = await fixture(t, {pin: false}), manifest = f.manifest(); manifest.skills[0].files.pop();
  await writeFile(path.join(f.software, 'software-manifest.json'), JSON.stringify(manifest));
  await assert.rejects(installProjectSkill({project: f.project}), /complete orchestration Skill/);
});

test('explicit project and its portable package are required; parent or external sources are not inferred', async t => {
  const f = await fixture(t);
  await assert.rejects(installProjectSkill({}), /explicit --project/);
  await assert.rejects(installProjectSkill({project: f.project, software: path.join(f.temporary, 'other-software')}), /portable review-software/);
  const child = path.join(f.project, 'child'); await mkdir(child);
  await assert.rejects(installProjectSkill({project: child}), {code: 'ENOENT'});
});

test('symlinked Skill parent cannot redirect the installer outside the project', async t => {
  const f = await fixture(t), outside = path.join(f.temporary, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.project, '.agents'));
  await assert.rejects(installProjectSkill({project: f.project}), /symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test('installation lock stops conflicting writers and remains available for inspection', async t => {
  const f = await fixture(t), parent = path.join(f.project, '.agents/skills'); await mkdir(parent, {recursive: true});
  await mkdir(path.join(parent, '.' + orchestrationSkillName + '.install-lock'));
  await assert.rejects(installProjectSkill({project: f.project}), /installation is active or interrupted/);
  assert.deepEqual(await readdir(parent), ['.' + orchestrationSkillName + '.install-lock']);
});
