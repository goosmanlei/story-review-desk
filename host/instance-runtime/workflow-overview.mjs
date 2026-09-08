import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from './creator-production-workflow.mjs';
import {projectWorkspaceModules} from './workspace-projection.mjs';
const slug=id=>String(id).toLowerCase().replaceAll('_','-');
export function workflowOverview(model,preparation,context={}){
 const workflow=model.systemConfiguration?.config?.workflow;
 const phases=workflow?.phases||model.productionPhases||[];
 const gates=workflow?.gates||model.productionGates||[];
 const currentPlan=(model.episodePlanRevisions||[]).find(p=>p.isCurrent===true&&p.scopeRole==='CURRENT');
 // Base-model discovery cannot establish formal denominators or permission.
 // The operational queue and workbench own exact gate/ScopeLock progress.
 const ready=Boolean(preparation?.content&&!preparation.stale);
 const preparationDetail=preparation?.content?`${preparation.content.scenes.length} 场准备稿${preparation.stale?' · 依据已变化，需重新核对':' · 可阅读、修改和记录意见'}`:'准备稿尚未登记';
 const productionNodes=CREATOR_PRODUCTION_STAGES.map(stage=>{
  const missingGateIds=stage.gateIds.filter(id=>{
   const rows=gates.filter(g=>g.id===id),canonical=creatorProductionGateDefinition(id);
   return rows.length!==1||rows[0].phaseId!==canonical.phaseId||rows[0].scopeType!==canonical.scopeType;
  });
  const entry=creatorProductionGateDefinition(stage.defaultGateId);
  return {id:stage.id,label:stage.label,group:'全剧制作',order:stage.order,
   href:'?view=pipeline&creatorStage='+slug(stage.id)+'&productionPhase='+slug(entry.phaseId)+'&productionGate='+slug(entry.gateId),
   detail:stage.id==='SHOT_PRODUCTION'?preparationDetail+'；'+stage.purpose:stage.purpose,
   gateIds:stage.gateIds,exportGateIds:stage.exportGateIds,navigationScopeType:stage.scope,
   definitionState:missingGateIds.length?'INCOMPLETE':'DEFINED',missingGateIds};
 });
 const nodes=[
 {id:'SOURCES',label:'来源资料',group:'故事创作',href:'?view=story&storyMode=source',detail:'登记来源、阅读原文和核对资料'},
 {id:'STORY',label:'故事与剧本审阅',group:'故事创作',href:'?view=story&storyMode=logic',detail:context.queue?.storyProgress?.headline||(currentPlan?'已发布分集可阅读；正式采用与逐场制作状态见当前工作投影':preparation?.candidate?'完整分集候选待审阅与受控采用':'先建立完整故事与分集候选')},
 {id:'SETTINGS',label:'主体与空间设定',group:'故事设定',href:'?view=settings',detail:'分类查看主体与空间；关系和永久身份共用'},
 {id:'MATERIALS',label:'实体状态与素材',group:'素材管理',href:'?view=materials',detail:'已定义 → 待生成 → 待审阅 → 已通过；精确版本用于下游'},
 ...productionNodes];
 const pairs=[['SOURCES','STORY'],['SOURCES','SETTINGS'],['SETTINGS','MATERIALS'],['STORY','SHOT_PRODUCTION'],['MATERIALS','SHOT_PRODUCTION'],...productionNodes.slice(0,-1).map((n,i)=>[n.id,productionNodes[i+1].id])];
 const edges=pairs.map(([from,to])=>({id:from+'-'+to,from,to,label:from==='STORY'?'按精确对象完成正式采用与源同步':from==='MATERIALS'?'精确版本输入':'依赖',directed:true}));
 return {schemaVersion:'1.1',nodes,edges,denominatorState:'UNKNOWN',
  ...projectWorkspaceModules({...context,model,preparation}),
  definition:{phases,gates,creatorStages:CREATOR_PRODUCTION_STAGES,creatorProjectionVersion:'2.0'},
  preparationWork:preparation?.content?{id:'PREPARATION:'+preparation.revisionId,title:ready?'核对逐场制作准备稿':'重新核对制作准备稿依据',sceneCount:preparation.content.scenes.length,href:productionNodes[0].href,status:ready?'READY':'BLOCKED',capabilities:ready?['人可推进','AI可辅助']:[],reason:ready?'核对本场作用、动作节拍、空间状态和素材缺项；意见与修改保存在准备稿中。':'候选或场正文已变化，原稿保留，不自动换绑。',boundary:'准备稿不构成正式审阅、生成授权或镜头制作分母。'}:null};
}
