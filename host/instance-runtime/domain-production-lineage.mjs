import {canonicalJson,sha256} from './bytes.mjs';

const hash=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const sha=/^[a-f0-9]{64}$/;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.length>0;
const sequence=e=>Number.isSafeInteger(e?.eventSequence)&&e.eventSequence>0;
const group=(rows,key)=>{const result=new Map();for(const row of rows)if(object(row)&&text(row[key]))result.set(row[key],[...(result.get(row[key])||[]),row]);return result;};
const ordered=rows=>[...rows].sort((a,b)=>a.eventSequence-b.eventSequence);
const runState=r=>r.runState||r.state;
const requestState=r=>r.requestState||r.status;
const runtime=v=>object(v)&&Object.keys(v).sort().join(',')==='instanceId,runtimeEpoch'&&text(v.instanceId)&&text(v.runtimeEpoch);
const input=b=>({familyId:b.familyId||b.assetFamilyRef,versionId:b.versionId||b.assetVersionRef,sha256:b.sha256});
const transitions={PLANNED:['PLANNED','SUBMITTED','CANCELLED'],SUBMITTED:['SUBMITTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','RESULT_UNKNOWN'],RUNNING:['RUNNING','SUCCEEDED','FAILED','CANCELLED','RESULT_UNKNOWN'],RESULT_UNKNOWN:['RESULT_UNKNOWN','SUCCEEDED','FAILED'],SUCCEEDED:['SUCCEEDED'],FAILED:['FAILED'],CANCELLED:['CANCELLED']};

/** Only a complete immutable producer chain can distinguish a genuinely new
 * descendant from an old/late-registered output. This grants no execution or
 * Review authority: it only supplies a lower bound on proven production time.
 * Historical rows without this evidence retain their previous held state. */
export function domainProductionProofs({candidates=[],requests=[],runs=[],versions}){
 const result=new Map(),byVersion=group(candidates,'versionId'),candidateRequests=group(candidates,'executionRequestId'),byRequest=group(requests,'executionRequestId'),runsByRequest=group(runs,'executionRequestId');
 for(const [versionId,rows]of byVersion){
  if(rows.length!==1)continue;const c=rows[0],v=versions.get(versionId);if(candidateRequests.get(c.executionRequestId)?.length!==1)continue;
  if(!v||c.eventKind!=='asset-version'||c.schemaVersion!=='1.1'||!sequence(c)||!text(c.eventId)||c.familyId!==v.familyId||c.sha256!==v.sha256||!sha.test(c.sha256||'')||c.path!==v.path||!Number.isSafeInteger(c.byteSize)||c.byteSize<=0||c.outputState!=='PRESENT'||c.expectationState!=='REALIZED'||c.registrationState!=='CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED'||!text(c.expectedOutputId)||!text(c.runId)||!text(c.executionRequestId)||!text(c.executionDefinitionId)||!sha.test(c.callPackageHash||'')||c.executionDefinitionHash!==c.callPackageHash||!text(c.snapshotId))continue;
  const bindings=c.inputBindings;
  if(!Array.isArray(bindings)||!bindings.length||bindings.some((b,i)=>!object(b)||Object.keys(b).sort().join(',')!=='assetFamilyRef,assetVersionRef,order,path,sha256'||b.order!==i+1||!text(b.path)||!text(b.assetFamilyRef)||!text(b.assetVersionRef)||!sha.test(b.sha256||''))||new Set(bindings.map(b=>b.assetFamilyRef)).size!==bindings.length||c.inputBindingsHash!==hash(bindings))continue;
  const inputs=bindings.map(input);
  if(!same(inputs,(v.inputVersionBindings||[]).map(input))||inputs.some(b=>{const p=versions.get(b.versionId);return !p||p.familyId!==b.familyId||p.sha256!==b.sha256;}))continue;
  const qs=ordered(byRequest.get(c.executionRequestId)||[]),rs=ordered(runsByRequest.get(c.executionRequestId)||[]);
  if(!qs.length||!rs.length||[...qs,...rs].some(e=>!sequence(e)||!text(e.eventId)||e.eventSequence>=c.eventSequence)||new Set([...qs,...rs,c].map(e=>e.eventId)).size!==qs.length+rs.length+1||new Set([...qs,...rs,c].map(e=>e.eventSequence)).size!==qs.length+rs.length+1)continue;
  const auth=qs[0],claim=qs[1];
  if(auth.eventKind!=='execution-request'||auth.action!=='AUTHORIZE'||requestState(auth)!=='AUTHORIZED'||auth.authorized!==true||auth.maxOutputs!==1||!['CODEX','USER_EXTERNAL'].includes(auth.executor)||!runtime(auth.authorizationRuntime))continue;
  if(auth.executor==='CODEX'?(qs.length!==2||claim.action!=='CLAIM'||requestState(claim)!=='CLAIMED'||claim.eventSequence<=auth.eventSequence):(qs.length!==1))continue;
  if(qs.some(q=>q.eventKind!=='execution-request'||q.schemaVersion!=='1.0'||q.executionDefinitionId!==c.executionDefinitionId||q.callPackageHash!==c.callPackageHash||q.executionDefinitionHash!==c.callPackageHash||q.familyId!==c.familyId||!text(q.workItemId)||q.workItemId!==auth.workItemId||q.snapshotId!==auth.snapshotId||q.snapshotId!==c.snapshotId||q.authorized!==true||q.executor!==auth.executor||q.maxOutputs!==1||q.inputBindingsHash!==c.inputBindingsHash||!same(q.inputBindings,bindings)||!same(q.authorizationRuntime,auth.authorizationRuntime)||q.status!=null&&q.status!==q.requestState))continue;
  const startedAfter=claim?.eventSequence||auth.eventSequence,runGroups=group(rs,'runId');
  if(!runGroups.has(c.runId)||runGroups.size!==1)continue; // no retry/multiple-run inference
  const chain=ordered(runGroups.get(c.runId));
  if(chain.some(r=>r.eventKind!=='run'||r.schemaVersion!=='2.0'||r.executionDefinitionId!==c.executionDefinitionId||r.callPackageHash!==c.callPackageHash||r.executionDefinitionHash!==c.callPackageHash||r.snapshotId!==c.snapshotId||r.inputBindingsHash!==c.inputBindingsHash||r.eventSequence<=startedAfter||!transitions[runState(r)]||r.runState!=null&&r.state!=null&&r.runState!==r.state))continue;
  if(!['PLANNED','SUBMITTED'].includes(runState(chain[0]))||runState(chain.at(-1))!=='SUCCEEDED')continue;
  let valid=true;
  for(let i=1;i<chain.length;i++){
   const prev=runState(chain[i-1]),next=runState(chain[i]);
   if(!transitions[prev].includes(next)){valid=false;break;}
   if(prev==='RESULT_UNKNOWN'&&['SUCCEEDED','FAILED'].includes(next)){
    const proof=chain[i].reconciliationEvidence;
    if(!object(proof)||proof.requestId!==c.executionRequestId||proof.providerConclusion!==next||!text(proof.logId)||!text(proof.providerStatusCheckedAt)||!Number.isFinite(Date.parse(proof.providerStatusCheckedAt))){valid=false;break;}
   }
  }
  const submitted=chain.find(r=>runState(r)==='SUBMITTED');
  if(!valid||!submitted||auth.eventSequence>=submitted.eventSequence)continue;
  result.set(versionId,{authorizedSequence:auth.eventSequence,submittedSequence:submitted.eventSequence,candidateSequence:c.eventSequence,inputs});
 }
 return result;
}
