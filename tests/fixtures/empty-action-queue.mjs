import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {normalizeReviewSnapshot} from '../../host/instance-runtime/snapshot-contract.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const nativeRequire=createRequire(import.meta.url);

/** Same isolation boundary as empty-action-queue.test.mjs: run the real queue
 * builder with an empty, in-memory authority. No server, DB, credentials or
 * hand-written "ready" work/capabilities. Unexpected production reads fail. */
export async function buildEmptyActionQueueFixture(snapshot){
 const data=normalizeReviewSnapshot(snapshot);
 if(data.creativeLineage.scenes.length||data.productionModel.materialRequirements.length)throw Error('Empty queue fixture requires an empty instance');
 const operations={snapshotId:data.snapshotId,baseSnapshotId:data.snapshotId,operationRevision:'OP-EMPTY-UI-FIXTURE',etag:'"empty-ui-fixture"',reviews:{events:[]},creativeRevisions:{events:[]},candidates:{events:[]},runs:{events:[]},executionRequests:{current:[]},sourceOperations:{latestById:[]},stateProjection:{workItemsById:{},materialWorkItemsById:{},assetFamiliesById:{},assetVersionsById:{},materialRequirementsById:{},scopeLocksById:{},structuresById:{},scriptScenesById:{}}};
 const store={reviewData:async()=>data,operationalSnapshot:async()=>operations,recipeCatalog:async()=>data.executionRecipeSummary,storyConfirmationTargets:()=>data.actionQueueInputs.rewrittenSceneConfirmations,audioVerificationTargets:()=>[],assertCreativeRevisionBasisCurrent:()=>{throw Error('Empty fixture has no current plan basis');},stableObjectHash:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),workProductReviewBinding:()=>{throw Error('Unexpected production output in empty fixture');}};
 const modules=new Map();
 function load(filename){
  if(modules.has(filename))return modules.get(filename).exports;
  const module={exports:{}};modules.set(filename,module);
  // Playwright intercepts native require(.mjs); transpile the same source in
  // this isolated loader. A .ts virtual filename prevents TS preserving ESM
  // syntax just because the real file has an .mjs extension.
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},fileName:filename.replace(/\.mjs$/,'.ts')}).outputText;
  const require=specifier=>{
   if(specifier.endsWith('/_store')||specifier==='./_store')return store;
   if(!specifier.startsWith('.'))return nativeRequire(specifier);
   return load(path.resolve(path.dirname(filename),/\.[cm]?[jt]sx?$/.test(specifier)?specifier:specifier+'.ts'));
  };
  new Function('require','module','exports',source)(require,module,module.exports);
  return module.exports;
 }
 const before=JSON.stringify(snapshot),queue=await load(path.join(appRoot,'app/api/v8/_action-queue.ts')).buildActionQueue();
 if(JSON.stringify(snapshot)!==before)throw Error('Queue fixture changed its source snapshot');
 return {...queue,workUnits:queue.workUnits||[],rowCount:queue.items.length,workUnitCount:queue.workUnits?.length||0,summaryScope:'GLOBAL'};
}
