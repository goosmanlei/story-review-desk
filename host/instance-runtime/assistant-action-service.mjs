import {canonicalJson,sha256} from './bytes.mjs';
import {EXECUTION_PROTOCOL,validTurnExecution} from './assistant-execution-policy.mjs';
import {getDomainWorkspace,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace} from './domain-workspaces.mjs';
import {readProductionPreparation,saveProductionPreparation,previewProductionPreparationRevalidation,applyProductionPreparationRevalidation} from './production-preparation.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const decode=record=>{if(!record||record.deleted)return null;if(sha256(record.bytes)!==record.sha256)fail('ASSISTANT_RECORD_INVALID','操作依据哈希不符');return JSON.parse(record.bytes);};
const exact=(value,fields)=>{if(!object(value)||Object.keys(value).some(key=>!fields.includes(key)))fail('ASSISTANT_ACTION_INVALID','操作参数超出白名单');};
const text=(value,name)=>{if(typeof value!=='string'||!value.trim()||value.length>300)fail('ASSISTANT_ACTION_INVALID',name+'无效');return value;};
const nullable=(value,name)=>{if(value!==null)text(value,name);return value;};
const authoringKeys=['sceneRole','audienceTakeaway','informationBoundary','beats','visualIntent','soundAndDialogueIntent','entityStateRequirements','timeAndSpace','materialGaps','nextPreparationAction','reviewFocus'];
const collectionNames=['entities','states','representations','relations'];
const defaults={getDomainWorkspace,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace,readProductionPreparation,saveProductionPreparation,previewProductionPreparationRevalidation,applyProductionPreparationRevalidation};
const receiptPrefix=turnId=>'actions/'+turnId+'/';
export async function executeAssistantAction(tx,input,handlers=defaults){
 exact(input,['turnId','conversationId','requestHash','claim','callId','action','arguments']);
 for(const key of ['turnId','conversationId'])if(!/^[a-z][a-z0-9_-]{7,79}$/.test(input[key]||''))fail('ASSISTANT_ACTION_INVALID','轮次身份无效');
 text(input.callId,'callId');text(input.action,'action');
 if(!object(input.arguments)||Buffer.byteLength(canonicalJson(input.arguments))>512*1024)fail('ASSISTANT_ACTION_INVALID','操作内容不是有界对象');
 const metadata=await tx.getMetadata(),turnRecord=await tx.getAux('assistant-public','turns/'+input.turnId+'.json'),turn=decode(turnRecord);
 if(!turn||turn.mode!=='EXECUTE'||!validTurnExecution(turn)||turn.conversationId!==input.conversationId||turn.requestHash!==input.requestHash||turn.capabilityProfile!=='CONTROLLED_PROJECT_ACTIONS')fail('ASSISTANT_EXECUTION_REQUIRED','本轮没有明确的执行授权');
 const grant=turn.execution;
 if(grant.instanceId!==metadata.instanceId||grant.runtimeEpoch!==metadata.runtimeEpoch||turnRecord.metadata?.runtimeEpoch!==metadata.runtimeEpoch)fail('ASSISTANT_EPOCH_CHANGED','实例或运行期已变化');
 const profile=await tx.getProfile();if(profile.projectId!==turn.projectId||profile.instanceId!==grant.instanceId||profile.capabilities?.assistantEnabled===false)fail('ASSISTANT_PROJECT_MISMATCH','操作不属于当前项目');
 if(!grant.allowedActions.includes(input.action))fail('ASSISTANT_ACTION_DENIED','本轮未授权该操作');
 const currentClaim=decode(await tx.getAux('assistant-public','claims/'+input.turnId+'.json'));
 const claimKeys=['turnId','conversationId','bridgeInstanceId','slotId','leaseId','fencingToken'];
 if(!currentClaim||!object(input.claim)||claimKeys.some(key=>currentClaim[key]===undefined||currentClaim[key]!==input.claim[key])||currentClaim.turnId!==input.turnId||currentClaim.conversationId!==input.conversationId)fail('ASSISTANT_CLAIM_LOST','当前执行者租约已失效');
 if(await tx.getAux('assistant-public','cancel/'+input.turnId+'.json')||await tx.getAux('assistant-public','results/'+input.turnId+'.json'))fail('ASSISTANT_TURN_CLOSED','本轮已取消或结束');
 // A claim has no expiry of its own. The scheduler's current private generation
 // plus its live ACTIVE heartbeat establishes a short, bounded execution lease.
 const healthRecord=await tx.getAux('assistant-public','health.json'),health=decode(healthRecord);
 const fenceRecord=await tx.getAux('assistant-private','scheduler/slots/'+currentClaim.slotId+'.json'),fence=decode(fenceRecord);
 const checkedAt=Date.parse(health?.checkedAt||''),leaseExpiresAt=checkedAt+15000,now=Date.now();
 const activeSlot=health?.slots?.find(slot=>slot.slotId===currentClaim.slotId);
 if(!Number.isFinite(checkedAt)||now<checkedAt-2000||now>leaseExpiresAt||healthRecord.metadata?.runtimeEpoch!==metadata.runtimeEpoch
  ||!['PROCESSING','DEGRADED'].includes(health.status)||health.bridgeInstanceId!==currentClaim.bridgeInstanceId
  ||health.schedulerProtocol!==profile.assistant?.schedulerProtocol||activeSlot?.status!=='ACTIVE'||activeSlot.runtimePoisoned===true
  ||!fence||fenceRecord.metadata?.runtimeEpoch!==metadata.runtimeEpoch||fence.bridgeInstanceId!==currentClaim.bridgeInstanceId
  ||fence.slotId!==currentClaim.slotId||fence.schedulerProtocol!==health.schedulerProtocol||fence.fencingToken!==currentClaim.fencingToken
  ||!Number.isSafeInteger(fence.fencingToken)||fence.fencingToken<1)fail('ASSISTANT_LEASE_EXPIRED','当前调度租约已过期、失联或换代，禁止执行');

 const key=receiptPrefix(input.turnId)+sha256(input.callId)+'.json',semanticHash=sha256(canonicalJson({action:input.action,arguments:input.arguments})),prior=decode(await tx.getAux('assistant-public',key));
 if(prior){if(prior.requestHash!==semanticHash)fail('ASSISTANT_ACTION_CONFLICT','调用身份不能更换参数');return prior.response;}
 const priorReceipts=(await tx.listAux('assistant-public',{prefix:receiptPrefix(input.turnId)})).map(decode).filter(Boolean);
 if(priorReceipts.length>=32)fail('ASSISTANT_ACTION_LIMIT','本轮操作达到上限，请核查后新建一轮');
 const allowedReleases=new Set([grant.baseReleaseId,...priorReceipts.map(record=>record.response?.receipt?.resultReleaseId).filter(Boolean)]);
 if(!allowedReleases.has(metadata.releaseId))fail('ASSISTANT_RELEASE_CHANGED','其他操作更新了发布，请结束本轮并重新读取上下文');
 const args=input.arguments,operationId='assistant_action_'+sha256(input.turnId+':'+input.callId),owner='SETTINGS';
 let result,mutated=false;
 switch(input.action){
  case 'inspect_settings':{
   exact(args,['collection','offset','id']);const collection=args.collection||'entities';
   if(!collectionNames.includes(collection)||args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||args.offset<0))fail('ASSISTANT_ACTION_INVALID','设定读取范围无效');
   const state=await handlers.getDomainWorkspace(tx,owner),all=state.graph[collection]||[],selected=args.id?all.filter(row=>row.id===args.id):all.slice(args.offset||0,(args.offset||0)+8);
   result={releaseId:state.releaseId,revisionId:state.revisionId,draftRevisionId:state.draftHeadRevisionId,existingDraft:state.draft?{revisionId:state.draft.revisionId,changeCount:state.draft.changes.length,selectedChanges:state.draft.changes.filter(change=>change.collection===collection&&selected.some(row=>row.id===change.id))}:null,owner,collection,count:all.length,records:selected.map(value=>({value,beforeHash:sha256(canonicalJson(value)),ownership:state.ownership[collection+':'+value.id]})),nextOffset:args.id?null:(args.offset||0)+selected.length<all.length?(args.offset||0)+selected.length:null,configuration:state.configuration};break;
  }
  case 'save_settings_draft':
   exact(args,['expectedReleaseId','expectedDraftRevisionId','changes']);text(args.expectedReleaseId,'expectedReleaseId');nullable(args.expectedDraftRevisionId,'expectedDraftRevisionId');
   if(!Array.isArray(args.changes)||!args.changes.length||args.changes.length>50||args.changes.some(change=>!object(change)||!collectionNames.includes(change.collection)||!change.value))fail('ASSISTANT_ACTION_DENIED','仅允许本模块主体、状态、表现和关系的新增或修改，不提供删除');
   {const state=await handlers.getDomainWorkspace(tx,owner);const changes=new Map((state.draft?.changes||[]).map(change=>[change.collection+':'+change.id,change]));
    for(const change of args.changes)changes.set(change.collection+':'+change.id,change);
    result=await handlers.saveDomainWorkspace(tx,{...args,changes:[...changes.values()],owner});mutated=true;break;}
  case 'preview_settings_draft':
   exact(args,['draftRevisionId']);text(args.draftRevisionId,'draftRevisionId');result=await handlers.previewDomainWorkspace(tx,{...args,owner});break;
  case 'publish_settings':
   exact(args,['draftRevisionId','previewHash']);text(args.draftRevisionId,'draftRevisionId');text(args.previewHash,'previewHash');
   if(!priorReceipts.some(record=>record.action==='preview_settings_draft'&&record.response.result?.draftRevisionId===args.draftRevisionId&&record.response.result?.previewHash===args.previewHash))fail('ASSISTANT_PREVIEW_REQUIRED','必须先在本轮预览精确草稿');
   result=await handlers.publishDomainWorkspace(tx,{...args,owner,requestId:operationId});mutated=true;break;
  case 'inspect_preparation':{
   exact(args,['sceneId']);const state=await handlers.readProductionPreparation(tx);
   result={releaseId:state.releaseId,revisionId:state.revisionId,materialLinksRevisionId:state.materialLinksRevisionId,directoryRevisionId:state.directoryRevisionId,stale:state.stale,basis:state.content?.basis,scene:args.sceneId?state.content?.scenes.find(scene=>scene.sceneId===args.sceneId)||null:null,sceneDirectory:args.sceneId?undefined:state.content?.scenes.map(({sceneId,displayId,episodeUid})=>({sceneId,displayId,episodeUid})),candidate:state.candidate?{revisionId:state.candidate.revisionId,contentHash:state.candidate.contentHash}:null,allowedPreparationFields:authoringKeys};break;
  }
  case 'save_preparation_scene':{
   exact(args,['expectedReleaseId','expectedRevisionId','sceneId','fields']);text(args.expectedReleaseId,'expectedReleaseId');text(args.expectedRevisionId,'expectedRevisionId');text(args.sceneId,'sceneId');exact(args.fields,authoringKeys);
   const state=await handlers.readProductionPreparation(tx);
   if(state.releaseId!==args.expectedReleaseId||state.revisionId!==args.expectedRevisionId||!state.content)fail('ASSISTANT_ACTION_CONFLICT','准备稿版本已变化');
   const content=structuredClone(state.content),scene=content.scenes.find(scene=>scene.sceneId===args.sceneId);if(!scene)fail('ASSISTANT_ACTION_INVALID','永久场身份不在准备稿中');
   scene.preparation={...scene.preparation,...args.fields};result=await handlers.saveProductionPreparation(tx,{expectedReleaseId:args.expectedReleaseId,expectedRevisionId:args.expectedRevisionId,content,requestId:operationId});mutated=true;break;
  }
  case 'preview_preparation_revalidation':
  case 'apply_preparation_revalidation':{
   exact(args,['expectedReleaseId','expectedRevisionId','expectedLinksRevisionId','expectedDirectoryRevisionId','candidateRevisionId','candidateContentHash','sceneUpdates','materialUpdates','previewHash']);
   if(input.action==='apply_preparation_revalidation'&&!priorReceipts.some(record=>record.action==='preview_preparation_revalidation'&&record.response.result?.previewHash===args.previewHash))fail('ASSISTANT_PREVIEW_REQUIRED','必须先在本轮预览精确重核范围');
   result=await handlers[input.action==='preview_preparation_revalidation'?'previewProductionPreparationRevalidation':'applyProductionPreparationRevalidation'](tx,{...args,requestId:operationId});mutated=input.action==='apply_preparation_revalidation';break;
  }
  default:fail('ASSISTANT_ACTION_DENIED','不支持该操作');
 }
 const serializedResult=canonicalJson(result),previousChars=priorReceipts.reduce((sum,record)=>sum+canonicalJson(record.response.result).length,0);
 if(serializedResult.length>16000||previousChars+serializedResult.length>48000)fail('ASSISTANT_ACTION_LIMIT','操作结果达到本轮完整读取预算；请按永久对象身份缩小范围或新建一轮，不截断正文');
 const after=await tx.getMetadata(),receipt={protocol:EXECUTION_PROTOCOL,operationId,turnId:turn.turnId,action:input.action,status:'SUCCEEDED',mutated,instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,beforeReleaseId:metadata.releaseId,resultReleaseId:after.releaseId,resultRevisionId:result.revisionId||null,resultHash:sha256(canonicalJson(result))};
 receipt.sequence=priorReceipts.length+1;receipt.recordedAt=new Date().toISOString();
 if(Date.now()>leaseExpiresAt)fail('ASSISTANT_LEASE_EXPIRED','动作超出当前租约时限，事务未提交');
 const response={receipt,result};
 await tx.putAux({namespace:'assistant-public',key,bytes:canonicalJson({action:input.action,requestHash:semanticHash,response}),expectedRevisionId:null,mediaType:'application/json',metadata:{runtimeEpoch:metadata.runtimeEpoch}});
 return response;
}
export async function assistantActionReceipts(tx,turnId){
 if(!/^[a-z][a-z0-9_-]{7,79}$/.test(turnId))return [];
 return (await tx.listAux('assistant-public',{prefix:receiptPrefix(turnId)})).map(decode).filter(Boolean).map(record=>record.response?.receipt).filter(receipt=>receipt?.protocol===EXECUTION_PROTOCOL&&receipt.turnId===turnId&&receipt.mutated).sort((a,b)=>a.sequence-b.sequence);
}
