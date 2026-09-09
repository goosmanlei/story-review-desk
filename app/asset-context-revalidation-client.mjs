const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const stable=v=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=()=>{throw Error('关系复核回执不完整或与当前原图不一致');};
const target=v=>object(v)&&text(v.familyId)&&text(v.versionId)&&hash(v.sha256);
export const sameContextTarget=(a,b)=>target(a)&&target(b)&&['familyId','versionId','sha256'].every(k=>a[k]===b[k]);
function content(c,t,editable=false){return object(c)&&c.purpose==='LEGACY_ADOPTION_DOMAIN_REVALIDATION'&&c.action==='CONFIRM_CURRENT_DOMAIN'&&c.observedVersionId===t.versionId&&c.observedSha256===t.sha256&&typeof c.note==='string'&&(editable||text(c.note))&&Array.isArray(c.criterionFindings)&&new Set(c.criterionFindings.map(f=>f.criterionId)).size===c.criterionFindings.length&&c.criterionFindings.every(f=>text(f.criterionId)&&(editable?['','PASS','FAIL','NA']:['PASS','FAIL','NA']).includes(f.verdict)&&typeof f.note==='string')&&(!editable||typeof c.originalViewed==='boolean');}
export function validContextWorkspace(v,t){
 if(v?.protocol!=='ASSET_CONTEXT_REVALIDATION_V1'||v.supported!==true)throw Error('当前系统尚未支持旧采用图片的关系复核，请更新后重读');
 if(!sameContextTarget(v,t)||!sameContextTarget(v.sourceVersion,t)||typeof v.readOnly!=='boolean'||!text(v.releaseId)||!hash(v.basisHash)||!text(v.revalidationId)||!(v.draftHeadRevisionId===null||text(v.draftHeadRevisionId))||!hash(v.reviewSpec?.hash)||!Array.isArray(v.reviewSpec.criteria)||!v.reviewSpec.criteria.length||new Set(v.reviewSpec.criteria.map(c=>c.id)).size!==v.reviewSpec.criteria.length||!v.reviewSpec.criteria.every(c=>text(c.id)&&text(c.label)&&typeof c.question==='string'&&typeof c.allowNA==='boolean')||!Array.isArray(v.blockers)||!v.blockers.every(text)||!Array.isArray(v.jobs)||!v.jobs.every(j=>text(j.jobId)&&text(j.requestId)&&['QUEUED','RUNNING','SUCCEEDED','FAILED','RESULT_UNKNOWN'].includes(j.status))||!object(v.domainContext)||!object(v.legacyAdoptionProof))fail();
 for(const d of [v.draft,v.staleDraft].filter(Boolean))if(!sameContextTarget(d,t)||d.revalidationId!==v.revalidationId||!text(d.revisionId)||!text(d.baseReleaseId)||!hash(d.basisHash)||!content(d.content,t))fail();
 if(v.draft===undefined||v.draft&&v.staleDraft||v.draft&&(v.draft.revisionId!==v.draftHeadRevisionId||v.draft.baseReleaseId!==v.releaseId||v.draft.basisHash!==v.basisHash))fail();
 return v;
}
export function validContextReceipt(v,action,w){
 if(!object(v)||v.modelCalls!==0||v.formalAdoptionPerformed!==false||v.contextRevalidationPerformed!==false)fail();
 if(action==='save'){if(!text(v.revisionId))fail();}
 else if(action==='publish'){if(!text(v.jobId)||v.status!=='QUEUED')fail();}
 else if(action==='preview'){const r=v.revalidation;if(!hash(v.previewHash)||r?.schemaVersion!=='ASSET_CONTEXT_REVALIDATION_SOURCE_V1'||r.revalidationId!==w.revalidationId||r.baseReleaseId!==w.releaseId||r.draftRevisionId!==w.draft?.revisionId||!sameContextTarget(r.basis?.source,w)||r.basis?.current?.reviewSpec?.hash!==w.reviewSpec.hash||!content(r.content,w)||stable(r.content)!==stable(w.draft.content))fail();}
 else fail();return v;
}
export function validContextPending(v,t){if(!object(v)||!sameContextTarget(v.target,t)||!['save','publish'].includes(v.action)||!text(v.requestId)||!hash(v.basisHash)||!text(v.releaseId)||!(v.oldDraftRevisionId===null||text(v.oldDraftRevisionId))||!content(v.content,t))fail();return v;}
export function validContextLocalDraft(v,t){if(!object(v)||!sameContextTarget(v.target,t)||!hash(v.basisHash)||!text(v.releaseId)||!content(v.content,t,true))fail();return v;}
export function reconcileContextPending(p,w){validContextPending(p,w);validContextWorkspace(w,p.target);if(p.action==='publish'){const jobs=w.jobs.filter(j=>j.requestId===p.requestId);return jobs.length===1?{confirmed:true,job:jobs[0]}:{confirmed:false};}const d=w.draft||w.staleDraft;return d&&d.revisionId===w.draftHeadRevisionId&&d.revisionId!==p.oldDraftRevisionId&&d.baseReleaseId===p.releaseId&&d.basisHash===p.basisHash&&stable(d.content)===stable(p.content)?{confirmed:true,draft:d}:{confirmed:false};}
