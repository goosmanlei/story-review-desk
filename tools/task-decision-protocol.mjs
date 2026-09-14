import {createHash} from 'node:crypto';

const demand=(ok,message)=>{if(!ok)throw Error(message);};
const text=(s,name)=>{demand(typeof s==='string'&&s.trim()&&s.length<=30000,`DECISION_SCHEMA：${name}须为非空文本`);return s;};
const strings=(v,name)=>{demand(Array.isArray(v)&&v.length<=200,`DECISION_SCHEMA：${name}须为有界数组`);return v.map(x=>text(x,name));};
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export const decisionHash=x=>createHash('sha256').update(JSON.stringify(stable(x))??'undefined').digest('hex');
export const decisionPending=d=>!['RESOLVED','CANCELLED'].includes(d.status);
export const pendingDecisions=a=>(a.decisions||[]).filter(decisionPending);
export const decisionTool={type:'function',name:'review_task_decision',description:'Request a required user business decision through the coordinating session. Blocks this tool until an explicit user answer; do not assume a default or report completion while waiting. Use for missing user decisions, not ordinary authorized implementation choices. Never include credentials or machine identities.',inputSchema:{type:'object',additionalProperties:false,required:['key','question','context','options','recommendation','pendingWork','completedSteps'],properties:{key:{type:'string'},question:{type:'string'},context:{type:'string'},options:{type:'array',items:{type:'object',additionalProperties:false,required:['label','description'],properties:{label:{type:'string'},description:{type:'string'}}}},recommendation:{type:'string'},pendingWork:{type:'array',items:{type:'string'}},completedSteps:{type:'array',items:{type:'string'}}}}};
export const decisionInstructions='需要用户业务决定时，在执行中调用 review_task_decision，填写稳定 key、问题、背景、选项影响、建议、待决步骤和已完成工作。调用返回明确用户答复前暂停依赖步骤，不代答、不使用默认同意；普通已授权实现选择自主推进。该工具由主会话转达，approvalPolicy: never 不代表业务授权。工具不可用时停止依赖工作并明确报告 DECISION_CHANNEL_UNAVAILABLE，不能用最终结果冒充问题已解决。';

// Wire identities and raw permission/command payloads remain in runtime. Only
// the logical decision and user-visible context are copied into the task ledger.
export function describeDecision(message) {
 const p=message.params||{},method=message.method;
 if(method==='item/tool/call'&&p.tool==='review_task_decision'&&!p.namespace){
  const a=p.arguments;demand(a&&typeof a==='object'&&!Array.isArray(a),'DECISION_SCHEMA：工具参数无效');
  text(a.key,'key');demand(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(a.key),'DECISION_SCHEMA：key 无效');
  text(a.question,'question');text(a.context,'context');text(a.recommendation,'recommendation');
  demand(Array.isArray(a.options)&&a.options.length<=20,'DECISION_SCHEMA：options 无效');
  const options=a.options.map(o=>({label:text(o.label,'label'),description:text(o.description,'description')}));
  return {kind:'BUSINESS',key:a.key,question:a.question,context:a.context,options,recommendation:a.recommendation,pendingWork:strings(a.pendingWork,'pendingWork'),completedSteps:strings(a.completedSteps,'completedSteps'),supported:true};
 }
 if(method==='item/tool/requestUserInput'){
  demand(Array.isArray(p.questions)&&p.questions.length>0&&p.questions.length<=20,'DECISION_SCHEMA：questions 无效');
  const secret=p.questions.some(q=>q.isSecret),ids=new Set();
  const questions=p.questions.map(q=>{text(q.id,'question.id');demand(!ids.has(q.id),'DECISION_SCHEMA：重复 question.id');ids.add(q.id);return {id:q.id,header:text(q.header,'header'),question:text(q.question,'question'),options:(q.options||[]).map(o=>({label:text(o.label,'label'),description:text(o.description,'description')}))};});
  return {kind:'INPUT',question:secret?'此请求涉及秘密输入，任务决策通路不接收凭据':questions.map(q=>q.question).join('\n'),context:'工作会话请求用户输入；若涉及操作权限，主会话按审批说明核对。超时与默认选项不代表用户同意。',questions:secret?[]:questions,options:[],recommendation:'由用户明确作答',pendingWork:['等待所需输入'],completedSteps:[],supported:!secret,limitation:secret?'SECRET_INPUT_UNSUPPORTED':null};
 }
 if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(method))return {kind:'APPROVAL',question:p.reason||'工作会话需要人工核对操作权限',context:'原始命令、路径及请求权限仅存 runtime；先用 decisions show --runtime 核对精确操作和授权范围。不得代作业务裁决。',options:(method==='item/permissions/requestApproval'?['grant','deny']:['accept','decline','cancel']).map(label=>({label,description:label==='grant'||label==='accept'?'仅本次请求；需用户明确授权':'拒绝或取消该请求'})),recommendation:'先核对精确操作及授权',pendingWork:['人工权限审批'],completedSteps:[],supported:true};
 return {kind:'UNSUPPORTED',question:'当前宿主请求尚不支持：'+method,context:'已保留原协议消息；不能假称已向用户转达或自动批准。',options:[],recommendation:'核查原请求与宿主能力',pendingWork:['核查协议兼容性'],completedSteps:[],supported:false,limitation:'UNSUPPORTED_SERVER_METHOD'};
}

export function encodeDecisionAnswer(d,wire,answer) {
 demand(answer&&typeof answer==='object'&&!Array.isArray(answer),'DECISION_ANSWER：需要结构化用户答复');
 demand(d.supported,'DECISION_UNSUPPORTED：当前请求不支持自动回传');
 if(d.kind==='BUSINESS'){
  demand(Object.keys(answer).every(k=>k==='text'),'DECISION_ANSWER：业务决定只接受 text');
  return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({decisionId:d.id,userAnswer:text(answer.text,'answer.text')})}]};
 }
 if(d.kind==='INPUT'){
  demand(Object.keys(answer).length===1&&answer.answers&&typeof answer.answers==='object'&&!Array.isArray(answer.answers),'DECISION_ANSWER：需要 answers');
  const ids=d.questions.map(q=>q.id);demand(Object.keys(answer.answers).length===ids.length&&Object.keys(answer.answers).every(k=>ids.includes(k)),'DECISION_ANSWER：必须精确回答原问题 ID，不能串答');
  return {answers:Object.fromEntries(ids.map(id=>{const a=answer.answers[id];demand(a&&Object.keys(a).length===1&&Array.isArray(a.answers)&&a.answers.length>0,'DECISION_ANSWER：不得以空答复或默认同意代答');return [id,{answers:strings(a.answers,'answers')}];}))};
 }
 if(wire.method==='item/permissions/requestApproval'){
  demand(Object.keys(answer).length===1&&['grant','deny'].includes(answer.decision),'DECISION_ANSWER：权限仅支持本轮 grant/deny；不能扩大授权');
  return {permissions:answer.decision==='grant'?wire.params.permissions:{},scope:'turn'};
 }
 demand(Object.keys(answer).length===1&&['accept','decline','cancel'].includes(answer.decision),'DECISION_ANSWER：仅允许单次 accept/decline/cancel；会话或规则授权须另行核查');
 if(wire.params.availableDecisions?.length)demand(wire.params.availableDecisions.includes(answer.decision),'DECISION_ANSWER：不是原请求支持的选项');
 return {decision:answer.decision};
}

export function decisionBindingToken(wire) {
 return decisionHash({serviceId:wire.serviceId,generation:wire.generation,threadId:wire.threadId,turnId:wire.turnId,requestId:wire.requestId,method:wire.method,connectionId:wire.connectionId,requestHash:wire.requestHash});
}
