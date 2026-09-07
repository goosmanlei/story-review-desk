export const EXECUTION_PROTOCOL='REVIEW_CONTROLLED_ACTIONS_V1';
export const DRAFT_ACTIONS=Object.freeze(['inspect_settings','save_settings_draft','preview_settings_draft','inspect_preparation','save_preparation_scene','preview_preparation_revalidation','apply_preparation_revalidation']);
export const EXECUTION_ACTIONS=Object.freeze([...DRAFT_ACTIONS,'publish_settings']);
export function validExecutionGrant(value){
 return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='allowedActions,baseReleaseId,instanceId,protocol,runtimeEpoch'
  &&value.protocol===EXECUTION_PROTOCOL&&['instanceId','runtimeEpoch','baseReleaseId'].every(key=>typeof value[key]==='string'&&value[key].length>0&&value[key].length<=300)
  &&Array.isArray(value.allowedActions)&&value.allowedActions.length>0&&new Set(value.allowedActions).size===value.allowedActions.length&&value.allowedActions.every(action=>EXECUTION_ACTIONS.includes(action)));
}
export function validTurnExecution(turn){
 const mode=turn?.mode===undefined?'DISCUSS':turn.mode;
 return mode==='DISCUSS'?turn?.execution===undefined:mode==='EXECUTE'&&Boolean(turn.assistantContext)&&validExecutionGrant(turn.execution);
}
export function createExecutionGrant(metadata,{allowSettingsPublish=false}={}){
 const grant={protocol:EXECUTION_PROTOCOL,instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,baseReleaseId:metadata.releaseId,allowedActions:[...DRAFT_ACTIONS,...(allowSettingsPublish?['publish_settings']:[])]};
 if(!validExecutionGrant(grant))throw Error('执行模式需要完整实例身份、运行期与当前发布');
 return grant;
}
