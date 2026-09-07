import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { installHostedMedia, verifyHostedExport } from './instance-hosted-export.mjs';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const explicitHostedBuild = Boolean(process.env.REVIEW_EXPORT_DIR);
const hostedPublicTarget = path.join(siteRoot, '.hosted-public');
const publicRoot = explicitHostedBuild ? await mkdtemp(path.join(siteRoot, '.hosted-public-pending-')) : path.join(siteRoot, 'public');
const runtimeRoot = path.join(publicRoot, 'runtime');
const reviewDataPath = path.join(siteRoot, 'app', 'review-data.generated.json');
const recipePath = path.join(siteRoot, 'data', 'review-recipes.generated.json');
const hostedEventsPath = path.join(siteRoot, 'data', 'hosted-material-events.generated.json');
const sourceShardRoot = path.join(siteRoot, 'data');
const reviewCoreFilename = 'review-data-core.generated.json';
const reviewProductionAFilename = 'review-data-production-a.generated.json';
const reviewProductionBFilename = 'review-data-production-b.generated.json';
const productionShardAKeys = new Set([
  'schemaVersion', 'policy', 'reviewContextCatalog', 'workflowSteps',
  'continuityGroups', 'stageDefinitions', 'episodes', 'scenes', 'segments',
  'beats', 'shots', 'reviewContexts', 'structureCards', 'executionRecipeSummary',
]);

async function loadReviewData() {
  try {
    return JSON.parse(await readFile(reviewDataPath, 'utf8'));
  } catch (reason) {
    if (reason?.code !== 'ENOENT') throw reason;
    const [core, productionA, productionB] = await Promise.all([
      readFile(path.join(sourceShardRoot, reviewCoreFilename), 'utf8').then(JSON.parse),
      readFile(path.join(sourceShardRoot, reviewProductionAFilename), 'utf8').then(JSON.parse),
      readFile(path.join(sourceShardRoot, reviewProductionBFilename), 'utf8').then(JSON.parse),
    ]);
    if (core?.snapshotId !== productionA?.snapshotId || core?.snapshotId !== productionB?.snapshotId) {
      throw new Error('committed review snapshot shards diverge');
    }
    const rehydrated = {
      ...core,
      productionModel: {
        ...productionA.productionModel,
        ...productionB.productionModel,
      },
    };
    // Source archives intentionally store only sub-limit shards. Rehydrate the
    // local monolith during a clean build for the localhost filesystem runtime.
    await writeFile(reviewDataPath, `${JSON.stringify(rehydrated)}\n`, 'utf8');
    return rehydrated;
  }
}

let reviewData, recipes, hostedEvents, hostedExport;
if (process.env.REVIEW_EXPORT_DIR) {
  // Build inputs must be an explicit, immutable read-only export, never parent-directory discovery.
  hostedExport = await verifyHostedExport(path.resolve(process.env.REVIEW_EXPORT_DIR));
  if(process.env.REVIEW_EXPECTED_EXPORT_MANIFEST_SHA256&&hostedExport.manifest.manifestSha256!==process.env.REVIEW_EXPECTED_EXPORT_MANIFEST_SHA256)throw new Error('Hosted export differs from the build-frozen manifest');
  ({ snapshot: reviewData, recipes, events: hostedEvents } = hostedExport);
} else if (process.env.REVIEW_LEGACY_FIXTURE === '1') {
  reviewData=await loadReviewData();
  recipes=JSON.parse(await readFile(recipePath,'utf8'));
  hostedEvents=JSON.parse(await readFile(hostedEventsPath,'utf8'));
} else {
  const blank=blankSnapshot(blankProfile({title:'制作审阅台',instanceId:'template-instance',projectId:'template-story',episodePlanId:'template-episode-plan'}));
  reviewData={...blank.snapshot,snapshotId:'REVIEW-EMPTY-V1',snapshotDate:'UNKNOWN'};
  recipes={...blank.recipes,snapshotId:reviewData.snapshotId};
  hostedEvents={schemaVersion:'1.0',mode:'HOSTED_READ_ONLY_EVENT_PROJECTION',snapshotId:reviewData.snapshotId,events:{},counts:{}};
}
const MAX_HOSTED_ASSET_BYTES = 16 * 1024 * 1024;

if (!reviewData?.snapshotId || !reviewData?.schemaVersion || !reviewData?.productionModel) {
  throw new Error('review-data.generated.json is not a valid review snapshot');
}
if (recipes?.snapshotId !== reviewData.snapshotId) {
  throw new Error('review recipes do not match the current review snapshot');
}
if (hostedEvents?.snapshotId !== reviewData.snapshotId || hostedEvents?.mode !== 'HOSTED_READ_ONLY_EVENT_PROJECTION') {
  throw new Error('hosted material events do not match the current review snapshot');
}

const { productionModel, ...reviewDataCore } = reviewData;
const productionModelA = {};
const productionModelB = {};
for (const [key, value] of Object.entries(productionModel)) {
  (productionShardAKeys.has(key) ? productionModelA : productionModelB)[key] = value;
}
const outputs = [
  [reviewCoreFilename, reviewDataCore],
  [reviewProductionAFilename, { snapshotId: reviewData.snapshotId, productionModel: productionModelA }],
  [reviewProductionBFilename, { snapshotId: reviewData.snapshotId, productionModel: productionModelB }],
  ['review-recipes.generated.json', recipes],
  ['hosted-material-events.generated.json', hostedEvents],
].map(([filename, value]) => {
  const contents = `${JSON.stringify(value)}\n`;
  const sizeBytes = Buffer.byteLength(contents);
  if (sizeBytes > MAX_HOSTED_ASSET_BYTES) {
    throw new Error(`${filename} is ${sizeBytes} bytes; hosted runtime assets must stay at or below ${MAX_HOSTED_ASSET_BYTES} bytes`);
  }
  return {
    filename,
    contents,
    sizeBytes,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
});

if (hostedExport) {
  await copyFile(path.join(siteRoot, 'public', 'favicon.svg'), path.join(publicRoot, 'favicon.svg'));
  await installHostedMedia(hostedExport, publicRoot);
}

// This directory is generated and ignored. Remove stale monoliths before each
// build so an older oversized asset can never leak into a Sites package.
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
await Promise.all(outputs.map(({ filename, contents }) => (
  writeFile(path.join(runtimeRoot, filename), contents, 'utf8')
)));
await writeFile(path.join(runtimeRoot, 'manifest.json'), `${JSON.stringify({
  schemaVersion: '1.0',
  mode: 'HOSTED_READ_ONLY',
  snapshotId: reviewData.snapshotId,
  reviewSchemaVersion: reviewData.schemaVersion,
  recipeSnapshotId: recipes.snapshotId,
  ...(hostedExport ? { exportManifestSha256: hostedExport.manifest.manifestSha256, instanceId: hostedExport.manifest.instanceId, releaseId: hostedExport.manifest.releaseId, repositoryRevision: hostedExport.manifest.repositoryRevision, media: hostedExport.manifest.media.map(({url,path: exportPath,sha256,bytes}) => ({url,path: exportPath,sha256,bytes})) } : {}),
  maxAssetBytes: MAX_HOSTED_ASSET_BYTES,
  files: outputs.map(({ filename, sizeBytes, sha256 }) => ({ filename, sizeBytes, sha256 })),
}, null, 2)}\n`, 'utf8');

if (hostedExport) {
  try {
    const info = await lstat(hostedPublicTarget);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Hosted build target is not a generated directory');
    const previous = JSON.parse(await readFile(path.join(hostedPublicTarget, 'runtime/manifest.json'), 'utf8'));
    if (previous.mode !== 'HOSTED_READ_ONLY' || !previous.exportManifestSha256) throw new Error('Refusing to replace an unrecognized hosted public directory');
    await rm(hostedPublicTarget, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(publicRoot, hostedPublicTarget);
}
console.log(`Prepared hosted read-only snapshot ${reviewData.snapshotId}`);
