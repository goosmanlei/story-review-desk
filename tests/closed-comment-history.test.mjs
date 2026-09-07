import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real projection declarations. No database, rewrite or fallback implementation.
const text=readFileSync(new URL('../app/api/v8/_store.ts',import.meta.url),'utf8');
const parsed=ts.createSourceFile('store.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['scriptCommentTextHash','visibleScriptCommentEvents','projectScriptCommentEvents','closedScriptCommentHistory'];
const printer=ts.createPrinter(),parts=names.map(name=>{const found=parsed.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(found.length,1);return printer.printNode(ts.EmitHint.Unspecified,found[0],parsed);}).join('\n');
const {outputText}=ts.transpileModule(parts,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
const exports={};vm.runInNewContext(outputText,{exports,createHash});
const {projectScriptCommentEvents:project,closedScriptCommentHistory:history}=exports;
function fixture(closeAction='RESOLVE_AND_DELETE'){
  const create={schemaVersion:'1.1',eventId:'create',eventKind:'script-comment',eventSequence:1,commentId:'old-comment',sceneId:'S14',snapshotId:'old-snapshot',sceneContentHash:'a'.repeat(64),businessContextHash:'b'.repeat(64),anchor:{blockId:'old-block',quote:'当时的原文'},commentAction:'CREATE',commentText:'请明确动机',initialStatus:'AI_QUEUED',recordedAt:'2026-01-01T00:00:00Z'};
  const edit={...create,schemaVersion:'1.1',eventId:'edit',eventSequence:2,commentAction:'EDIT',commentRevisionId:'create',commentText:'请明确此处人物的行动动机',recordedAt:'2026-01-02T00:00:00Z'};
  const close={schemaVersion:'1.2',eventId:'close',eventKind:'script-comment',eventSequence:3,commentId:create.commentId,sceneId:create.sceneId,snapshotId:'new-snapshot',commentAction:closeAction,commentRevisionId:'edit',expectedLatestEventId:'edit',visibility:closeAction==='RESOLVE_AND_DELETE'?'DELETED_AUDIT':'CLOSED_HISTORY',resolutionStatus:'RESOLVED',resolutionNote:'已在新稿补充动作依据。',resolutionTarget:{candidateRevisionId:'candidate-new',candidateContentHash:'c'.repeat(64),sceneBindings:[{sceneId:'permanent-new-scene',contentHash:'d'.repeat(64),blockIds:['new-block'],blocksHash:'e'.repeat(64)}]},physicalHistoryDeleted:false,recordedAt:'2026-01-03T00:00:00Z'};
  return [close,edit,create];
}
test('previously hidden resolved comments retain original quote, edited text, exact identity and closure evidence',()=>{
 const events=fixture(),before=JSON.stringify(events),rows=history(events);assert.equal(rows.length,1);
 assert.equal(rows[0].commentText,'请明确此处人物的行动动机');assert.equal(rows[0].quote,'当时的原文');assert.equal(rows[0].resolutionNote,events[0].resolutionNote);
 assert.equal(rows[0].originalTarget.subjectId,'S14');assert.equal(rows[0].originalTarget.snapshotId,'old-snapshot');assert.equal(rows[0].originalTarget.contentHash,'a'.repeat(64));assert.equal(rows[0].originalTarget.revisionId,null);
 assert.equal(rows[0].resolutionTarget.sceneBindings[0].sceneId,'permanent-new-scene');assert.equal(rows[0].readOnly,true);assert.equal(rows[0].archived,true);assert.equal(rows[0].resolvedBy,null);
 assert.equal(JSON.stringify(events),before);assert.equal(project(events).length,0,'Old removed rows cannot re-enter operational queues');
});
test('future closure is visibly retained as resolved and cannot restart via a later replayed action',()=>{
 const events=fixture('RESOLVE_WITH_HISTORY'),rows=project(events);assert.equal(rows.length,1);assert.equal(rows[0].status,'RESOLVED');assert.equal(rows[0].archived,true);
 const later={...events[0],eventId:'reopen',eventSequence:4,commentAction:'REOPEN',recordedAt:'2026-01-04T00:00:00Z'};
 assert.equal(project([later,...events])[0].status,'RESOLVED');assert.equal(history([later,...events])[0].latestEventId,'close');
});
for(const field of ['commentRevisionId','expectedLatestEventId','visibility','resolutionStatus'])test('archive does not accept a mismatched '+field,()=>{
 const events=fixture();events[0][field]='wrong';assert.equal(history(events).length,0);
});
test('ordinary closure remains reopenable, but reopened comments are no longer classified as closed',()=>{
 const events=fixture();events[0].commentAction='RESOLVE_USER';assert.equal(history(events).length,1);assert.equal(history(events)[0].archived,false);assert.equal(history(events)[0].resolvedBy,'USER');
 const reopen={...events[0],eventId:'reopen',commentAction:'REOPEN',recordedAt:'2026-01-04T00:00:00Z'};assert.equal(history([reopen,...events]).length,0);assert.equal(project([reopen,...events])[0].status,'OPEN');
});
test('never-closed comments are not silently added to history',()=>{assert.equal(history(fixture().slice(1)).length,0);});
test('current design and script histories preserve their own permanent targets across revisions',()=>{
 for(const kind of ['SCENE_SCRIPT','EPISODE_DESIGN']){const events=fixture();events[2].schemaVersion='1.2';events[2].target={kind,subjectId:'permanent-original',label:'原集 原场',episodeUid:'episode-original',revisionId:'candidate-original',contentHash:'f'.repeat(64),blocks:[]};
 const row=history(events)[0];assert.equal(row.originalTarget.kind,kind);assert.equal(row.originalTarget.subjectId,'permanent-original');assert.equal(row.originalTarget.revisionId,'candidate-original');}
});
test('only the explicit history read opt-in exposes past hidden rows',()=>{
 const events=fixture();assert.equal(project(events).length,0);assert.equal(project(events,{includeRetired:true}).length,1);assert.equal(history(events)[0].commentRevisionId,'edit');
});
