import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validContextWorkspace,validContextReceipt,validContextLocalDraft,validContextPending,reconcileContextPending} from '../app/asset-context-revalidation-client.mjs';

const target={familyId:'AF-LEGACY',versionId:'AF-LEGACY@V001',sha256:'a'.repeat(64)};
const content={purpose:'LEGACY_ADOPTION_DOMAIN_REVALIDATION',action:'CONFIRM_CURRENT_DOMAIN',observedVersionId:target.versionId,observedSha256:target.sha256,criterionFindings:[{criterionId:'identity',verdict:'PASS',note:'Observed original identity in the current relation.'}],note:'Original image inspected for the stated current relation.'};
function workspace(){return {...target,protocol:'ASSET_CONTEXT_REVALIDATION_V1',supported:true,readOnly:false,releaseId:'release-one',basisHash:'b'.repeat(64),revalidationId:'ACTX-one',sourceVersion:{...target},legacyAdoptionProof:{},domainContext:{},reviewSpec:{hash:'c'.repeat(64),criteria:[{id:'identity',label:'Identity',question:'Is identity consistent?',allowNA:false}]},head:null,draftHeadRevisionId:'draft-one',draft:{...target,revalidationId:'ACTX-one',revisionId:'draft-one',baseReleaseId:'release-one',basisHash:'b'.repeat(64),content},staleDraft:null,blockers:[],jobs:[]};}
const receiptBase={modelCalls:0,formalAdoptionPerformed:false,contextRevalidationPerformed:false};
function preview(w){return {...receiptBase,previewHash:'d'.repeat(64),revalidation:{schemaVersion:'ASSET_CONTEXT_REVALIDATION_SOURCE_V1',revalidationId:w.revalidationId,baseReleaseId:w.releaseId,draftRevisionId:w.draft.revisionId,basis:{source:target,current:{reviewSpec:w.reviewSpec}},content:structuredClone(content)}};}
function pending(action='save'){return {action,target,requestId:'original-request',basisHash:'b'.repeat(64),releaseId:'release-one',oldDraftRevisionId:null,content};}

test('context workspace and receipt preserve exact image and reviewed content',()=>{const w=workspace();assert.equal(validContextWorkspace(w,target),w);assert.ok(validContextReceipt(preview(w),'preview',w));assert.ok(validContextReceipt({...receiptBase,revisionId:'draft-two'},'save',w));assert.ok(validContextReceipt({...receiptBase,jobId:'job-one',status:'QUEUED'},'publish',w));});
for(const [label,change] of [
 ['wrong image SHA',w=>{w.sha256='e'.repeat(64);}],
 ['wrong source version',w=>{w.sourceVersion.versionId='AF-OTHER@V001';}],
 ['unsupported runtime',w=>{w.supported=false;}],
 ['missing read-only boundary',w=>{delete w.readOnly;}],
 ['duplicate criteria',w=>{w.reviewSpec.criteria.push({...w.reviewSpec.criteria[0]});}],
 ['stale draft presented as current',w=>{w.draft.basisHash='e'.repeat(64);}],
 ['wrong draft observation',w=>{w.draft.content.observedSha256='e'.repeat(64);}],
 ['unknown job status',w=>{w.jobs=[{jobId:'j',requestId:'r',status:'DONE'}];}],
])test('context client rejects '+label,()=>{const w=structuredClone(workspace());change(w);assert.throws(()=>validContextWorkspace(w,target));});
for(const [label,change] of [
 ['wrong version',p=>{p.revalidation.basis.source={...target,versionId:'wrong'};}],
 ['changed decision',p=>{p.revalidation.content.criterionFindings[0].verdict='NA';}],
 ['wrong review standard',p=>{p.revalidation.basis.current.reviewSpec={hash:'f'.repeat(64)};}],
 ['wrong draft',p=>{p.revalidation.draftRevisionId='other';}],
 ['missing zero-model-call proof',p=>{delete p.modelCalls;}],
 ['already applied response on preview',p=>{p.contextRevalidationPerformed=true;}],
])test('context preview rejects '+label,()=>{const w=workspace(),p=preview(w);change(p);assert.throws(()=>validContextReceipt(p,'preview',w));});
test('unknown save reconciles only exact content and prior basis',()=>{const w=workspace(),p=pending();assert.equal(validContextPending(p,target),p);assert.equal(reconcileContextPending(p,w).confirmed,true);w.draft.content={...content,note:'Other observer note'};assert.equal(reconcileContextPending(p,w).confirmed,false);});
test('unknown publish reconciles the original request, not a neighboring successful job',()=>{const w=workspace(),p=pending('publish');w.jobs=[{jobId:'other',requestId:'other-request',status:'SUCCEEDED'}];assert.equal(reconcileContextPending(p,w).confirmed,false);w.jobs.push({jobId:'original',requestId:p.requestId,status:'RESULT_UNKNOWN'});assert.equal(reconcileContextPending(p,w).job.status,'RESULT_UNKNOWN');});
test('local incomplete observations persist without pretending to be a formal decision',()=>{const local={target,releaseId:'release-one',basisHash:'b'.repeat(64),content:{...content,originalViewed:false,note:'',criterionFindings:[{criterionId:'identity',verdict:'',note:''}]}};assert.ok(validContextLocalDraft(local,target));assert.throws(()=>validContextPending({...pending(),content:local.content},target));assert.throws(()=>validContextLocalDraft(local,{...target,sha256:'f'.repeat(64)}));});
