import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const PASTE_START='\u001b[200~',PASTE_END='\u001b[201~';
const OPEN_DECISIONS=new Set(['OPEN','ANSWERED','DELIVERY_UNKNOWN','NEEDS_RECONCILIATION','FOLLOWUP_READY']);
const segments=new Intl.Segmenter(undefined,{granularity:'grapheme'});

const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
const scalar=value=>value===null||value===undefined?'—':typeof value==='string'?clean(value):clean(JSON.stringify(value,null,2));
const summaryOf=value=>typeof value==='string'?clean(value):value&&typeof value.summary==='string'?clean(value.summary):'— 未提供摘要';
const fingerprint=value=>JSON.stringify(value??null);
const receiptText=receipt=>receipt?.message||receipt?.reason||receipt?.status||'已接收';
const activeDecision=decision=>decision&&OPEN_DECISIONS.has(decision.status||'OPEN')&&!['RESOLVED','CANCELLED'].includes(decision.status);
const answerableDecision=decision=>activeDecision(decision)&&(decision.status||'OPEN')==='OPEN'&&!decision.answer;

function lastGrapheme(value) {
 const parts=[...segments.segment(value)];
 return parts.length?value.slice(0,parts.at(-1).index):value;
}

function matchingSuffix(value,sequence) {
 for(let length=Math.min(value.length,sequence.length-1);length>0;length--)
  if(sequence.startsWith(value.slice(-length)))return length;
 return 0;
}

/** Decode raw terminal input without turning pasted newlines into submissions. */
export class AttachInputDecoder {
 constructor({onText,onSubmit,onDetach}) {
  this.onText=onText;this.onSubmit=onSubmit;this.onDetach=onDetach;
  this.decoder=new StringDecoder('utf8');this.buffer='';this.normal='';this.paste=false;this.detached=false;this.skipLf=false;
 }
 write(bytes) {
  if(this.detached)return;
  this.buffer+=this.decoder.write(bytes);
  this.consume();
 }
 consume() {
  while(this.buffer&&!this.detached) {
   if(this.paste) {
    const end=this.buffer.indexOf(PASTE_END);
    const detachAt=[this.buffer.indexOf('\u0003'),this.buffer.indexOf('\u0004')].filter(index=>index>=0).sort((a,b)=>a-b)[0];
    if(detachAt!==undefined&&(end<0||detachAt<end)) {
     if(detachAt)this.onText(this.buffer.slice(0,detachAt));
     this.buffer='';this.paste=false;this.detached=true;this.onDetach();break;
    }
    if(end>=0) {
     if(end)this.onText(this.buffer.slice(0,end));
     this.buffer=this.buffer.slice(end+PASTE_END.length);this.paste=false;continue;
    }
    const held=matchingSuffix(this.buffer,PASTE_END),text=this.buffer.slice(0,this.buffer.length-held);
    if(text)this.onText(text);
    this.buffer=this.buffer.slice(this.buffer.length-held);break;
   }
   const start=this.buffer.indexOf(PASTE_START);
   if(start>=0) {
    this.consumeNormal(this.buffer.slice(0,start));
    this.buffer=this.buffer.slice(start+PASTE_START.length);this.paste=true;continue;
   }
   const held=matchingSuffix(this.buffer,PASTE_START),text=this.buffer.slice(0,this.buffer.length-held);
   this.buffer=this.buffer.slice(this.buffer.length-held);
   this.consumeNormal(text);break;
  }
 }
 consumeNormal(text) {
  this.normal+=text;
  while(this.normal&&!this.detached) {
   if(this.normal[0]==='\u001b') {
    const control=this.normal.match(/^\u001b(?:\[[0-?]*[ -/]*[@-~]|.)/s);
    if(!control)break;
    this.normal=this.normal.slice(control[0].length);continue;
   }
   const char=String.fromCodePoint(this.normal.codePointAt(0));this.normal=this.normal.slice(char.length);
   if(char==='\u0003'||char==='\u0004') {this.detached=true;this.onDetach();break;}
   if(char==='\u007f'||char==='\b') {this.onText(null);continue;}
   if(char==='\r'||char==='\n') {
    if(char==='\n'&&this.skipLf){this.skipLf=false;continue;}
    this.skipLf=char==='\r';this.onSubmit();continue;
   }
   this.skipLf=false;
   if(char==='\t'||char>=' ')this.onText(char);
  }
 }
 end() {this.buffer+=this.decoder.end();this.consume();}
}

function treeNodes(nodes) {
 const byParent=new Map(),known=new Set(nodes.map(node=>node.id));
 for(const node of nodes) {
  const parent=known.has(node.parentAssignmentId)?node.parentAssignmentId:null;
  if(!byParent.has(parent))byParent.set(parent,[]);
  byParent.get(parent).push(node);
 }
 const result=[],visited=new Set();
 const visit=(node,depth)=>{
  if(visited.has(node.id))return;visited.add(node.id);result.push({node,depth});
  for(const child of byParent.get(node.id)||[])visit(child,depth+1);
 };
 for(const node of byParent.get(null)||[])visit(node,0);
 for(const node of nodes)visit(node,0);
 return result;
}

function messageText(message) {
 if(typeof message?.text==='string')return clean(message.text);
 const rest={...message};delete rest.id;delete rest.type;
 return scalar(rest);
}

function renderMessages(node,messages=node.messages||[]) {
 if(!messages.length)return `\n— ${clean(node.title||node.id)} 暂无输出`;
 return messages.map(message=>{
  const type=clean(message.type||'message').toUpperCase();
  return `\n[${type}] ${clean(node.title||node.id)} · ${clean(message.id||'—')}\n${messageText(message)}`;
 }).join('\n');
}

function renderTree(nodes,numberFor) {
 if(!nodes.length)return '— 当前没有工作节点';
 return treeNodes(nodes).map(({node,depth})=>{
  const model=[node.model,node.effort].filter(Boolean).map(clean).join('/'),availability=node.canSend?'可发送':`不可发送${node.reason?'：'+clean(node.reason):''}`;
  return `${'  '.repeat(depth)}${depth?'└─ ':''}[${numberFor(node.id)}] ${clean(node.title||node.id)} (${[node.role,node.status,model,availability].filter(Boolean).map(clean).join(' · ')})\n${'  '.repeat(depth+1)}${clean(node.id)}`;
 }).join('\n');
}

function renderDecisionList(decisions,numberFor) {
 const pending=decisions.filter(activeDecision);
 if(!pending.length)return '— 无待处理决定';
 return pending.map(decision=>`[${numberFor(decision.id)}] ${clean(decision.kind||'UNKNOWN')} · ${clean(decision.status||'OPEN')} · ${clean(decision.question||decision.id)}\n    /decision ${clean(decision.id)}`).join('\n');
}

/** Deterministic plain-text snapshot used by TTY and non-TTY read-only mode. */
export function renderAttachSnapshot(snapshot,{numberForNode=id=>id,numberForDecision=id=>id,includeMessages=true}={}) {
 const task=snapshot?.task||{},nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[],decisions=Array.isArray(snapshot?.decisions)?snapshot.decisions:[],connection=snapshot?.connection||{};
 const sections=[
  `任务 ${clean(task.displayId||task.id||'UNKNOWN')} · ${clean(task.title||'未命名')} · ${clean(task.status||'UNKNOWN')}`,
  `连接 ${clean(connection.status||'UNKNOWN')}${connection.reason?' · '+clean(connection.reason):''}`,
  `\n工作节点\n${renderTree(nodes,numberForNode)}`,
  `\n待处理决定\n${renderDecisionList(decisions,numberForDecision)}`,
 ];
 if(task.checkpoint!==undefined&&task.checkpoint!==null)sections.push(`\n检查点摘要\n${summaryOf(task.checkpoint)}`);
 if(task.result!==undefined&&task.result!==null)sections.push(`\n结果摘要\n${summaryOf(task.result)}`);
 if(includeMessages)sections.push(`\n完整输出${nodes.map(node=>renderMessages(node)).join('')||'\n— 暂无输出'}`);
 return sections.join('\n');
}

function decisionDetails(value) {
 const decision=value?.decision||value||{},runtime=value?.runtime;
 const lines=[
  `决定 ${clean(decision.id||'UNKNOWN')} · ${clean(decision.kind||'UNKNOWN')} · ${clean(decision.status||'UNKNOWN')}`,
  clean(decision.question||'未提供问题'),
 ];
 if(decision.context)lines.push(`\n背景\n${clean(decision.context)}`);
 if(decision.questions?.length)for(const [index,question] of decision.questions.entries()) {
  lines.push(`\n问题 ${index+1}/${decision.questions.length} · ${clean(question.header||question.id)}\n${clean(question.question)}`);
  if(question.options?.length)lines.push(question.options.map((option,i)=>`  ${i+1}. ${clean(option.label)} — ${clean(option.description||'')}`).join('\n'));
 }
 if(decision.options?.length)lines.push(`\n选项\n${decision.options.map((option,i)=>`  ${i+1}. ${clean(option.label)} — ${clean(option.description||'')}`).join('\n')}`);
 if(decision.recommendation)lines.push(`\n建议\n${clean(decision.recommendation)}`);
 if(decision.pendingWork?.length)lines.push(`\n待决步骤\n${decision.pendingWork.map(x=>'  - '+clean(x)).join('\n')}`);
 if(runtime!==undefined)lines.push(`\n原始请求核对\n${scalar(runtime)}`);
 return lines.join('\n');
}

function answerChoice(text,options) {
 const trimmed=text.trim(),index=/^[1-9]\d*$/.test(trimmed)?Number(trimmed)-1:-1;
 return index>=0&&index<options.length?options[index].label:options.find(option=>option.label===trimmed)?.label;
}

function promptFor(state) {
 if(state.decision) {
  const decision=state.decision.decision;
  if(decision.kind==='INPUT') {
   const question=decision.questions[state.decision.inputIndex];
   return `决定 ${clean(decision.id)} · ${clean(question?.header||question?.id||'输入')} > `;
  }
  return `决定 ${clean(decision.id)} · ${clean(decision.kind)} > `;
 }
 if(state.focus)return `${clean(state.focus.title||state.focus.id)} > `;
 return '任务总览 > ';
}

function operation(prefix) {return `${prefix}-${randomUUID()}`;}

/**
 * Attach an observer/input terminal to one formal task. Opening and polling are
 * read-only; turns begin only after an explicit send or typed decision answer.
 */
export async function runAttach(project,taskId,{
 assignment=null,readOnly=false,input=process.stdin,output=process.stdout,
 openClient,pollIntervalMs=1000,operationId=operation,now=()=>new Date().toISOString(),
 }={}) {
 const opener=openClient||((await import('./task-attach-service.mjs')).openAttachClient);
 const client=await opener(project,taskId);
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;await client.close();};
 try {
  const first=await client.snapshot();
  const interactive=Boolean(input?.isTTY&&output?.isTTY&&typeof input.on==='function');
  if(!interactive) {
   if(!readOnly)throw Error('TASK_ATTACH_TTY_REQUIRED：非交互终端仅支持 --read-only 单次快照；发送消息请在 TTY 中运行');
   output.write(renderAttachSnapshot(first,{includeMessages:false})+'\n');
   return {status:'DETACHED',mode:'READ_ONLY_SNAPSHOT',taskId:first?.task?.id||taskId};
  }

  const state={snapshot:first,focus:null,decision:null,draft:'',nodeNumbers:new Map(),decisionNumbers:new Map(),seen:new Map(),openedNodes:new Set(),lastMeta:null,ended:false};
  let nextNode=1,nextDecision=1,serial=Promise.resolve(),polling=false,resolveDone,rejectDone;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const numberForNode=id=>{if(!state.nodeNumbers.has(id))state.nodeNumbers.set(id,nextNode++);return state.nodeNumbers.get(id);};
  const numberForDecision=id=>{if(!state.decisionNumbers.has(id))state.decisionNumbers.set(id,nextDecision++);return state.decisionNumbers.get(id);};
  const redraw=()=>{
   if(state.ended)return;
   const draft=clean(state.draft).replaceAll('\n',' ↵ ');
   output.write(`\r\u001b[2K${promptFor(state)}${draft}`);
  };
  const announce=text=>{
   if(state.ended)return;
   output.write(`\r\u001b[2K${String(text).replace(/\n?$/,'\n')}`);redraw();
  };
  const takeMessages=(node,{complete=false}={})=>{
   const selected=[];
   for(const message of node.messages||[]) {
    const key=`${node.id}:${message.id}`,value=fingerprint(message);
    if(complete||state.seen.get(key)!==value)selected.push(message);
    state.seen.set(key,value);
   }
   return selected;
  };
  const setFocus=selector=>{
   const value=String(selector||'').trim();
   const numbered=[...state.nodeNumbers.entries()].find(([,number])=>String(number)===value)?.[0];
   const candidates=state.snapshot.nodes.filter(node=>node.id===value||node.id.startsWith(value)||node.title===value||node.id===numbered);
   if(candidates.length!==1) {announce(candidates.length?'节点选择不唯一，请输入完整编号。':'未找到工作节点；输入 /agents 查看当前列表。');return false;}
   state.focus=candidates[0];state.decision=null;
   const firstVisit=!state.openedNodes.has(state.focus.id),messages=takeMessages(state.focus,{complete:firstVisit});
   state.openedNodes.add(state.focus.id);
   announce(`已进入节点 ${clean(state.focus.id)}${messages.length?renderMessages(state.focus,messages):'\n— 无新增输出'}`);return true;
  };
  const metaOf=snapshot=>fingerprint({task:snapshot.task,nodes:snapshot.nodes.map(({messages,...node})=>node),decisions:snapshot.decisions,connection:snapshot.connection});
  const ingest=(snapshot,{initial=false,force=false}={})=>{
   snapshot={task:snapshot?.task||{},nodes:Array.isArray(snapshot?.nodes)?snapshot.nodes:[],decisions:Array.isArray(snapshot?.decisions)?snapshot.decisions:[],connection:snapshot?.connection||{}};
   for(const node of snapshot.nodes)numberForNode(node.id);
   for(const decision of snapshot.decisions)numberForDecision(decision.id);
   const priorMeta=state.lastMeta,nextMeta=metaOf(snapshot);state.snapshot=snapshot;state.lastMeta=nextMeta;
   if(state.focus)state.focus=snapshot.nodes.find(node=>node.id===state.focus.id)||state.focus;
   if(initial) {
    announce(renderAttachSnapshot(snapshot,{numberForNode,numberForDecision,includeMessages:false}));
    return;
   }
   const chunks=[];
   if(force||priorMeta!==nextMeta)chunks.push(`任务状态更新\n${renderAttachSnapshot(snapshot,{numberForNode,numberForDecision,includeMessages:false})}`);
   for(const node of snapshot.nodes) {
    if(node.id!==state.focus?.id)continue;
    for(const message of node.messages||[]) {
    const key=`${node.id}:${message.id}`,value=fingerprint(message);
    if(state.seen.get(key)===value)continue;
    chunks.push(`${state.seen.has(key)?'输出更新':'新输出'}${renderMessages(node,[message])}`);state.seen.set(key,value);
    }
   }
   if(chunks.length)announce(chunks.join('\n\n'));
  };
  const refresh=async force=>{try{ingest(await client.snapshot(),{force});}catch(error){announce(`刷新失败：${clean(error.message)}\n连接保留，稍后继续重试。`);}};
  const detach=()=>{
   if(state.ended)return;state.ended=true;
   output.write('\r\u001b[2K已脱离任务；工作线程未被中断。\n\u001b[?2004l');
   serial.then(()=>resolveDone({status:'DETACHED',mode:readOnly?'READ_ONLY':'INTERACTIVE',taskId:state.snapshot.task.id||taskId}),rejectDone);
  };
  const showHelp=()=>announce(`命令
  数字 / /agent NODE   进入工作节点
  /agents              返回并刷新完整节点树
  /back                返回任务总览或退出决定输入
  /decision [ID|数字]  查看待处理决定并进入明确答复
  /help                显示帮助
  /detach              脱离观察（不打断工作线程）

粘贴多行文本会保留换行；按 Enter 才发送。Ctrl+C / Ctrl+D 只脱离观察。${readOnly?'\n当前为只读模式，不能发送消息或回答决定。':''}`);
  const openDecision=async selector=>{
   const pending=state.snapshot.decisions.filter(activeDecision),value=String(selector||'').trim();
   if(!value){announce(`待处理决定\n${renderDecisionList(state.snapshot.decisions,numberForDecision)}\n使用 /decision ID 或编号明确进入一个决定。`);return;}
   const numbered=[...state.decisionNumbers.entries()].find(([,number])=>String(number)===value)?.[0];
   const matches=pending.filter(decision=>decision.id===value||decision.id.startsWith(value)||decision.id===numbered);
   if(matches.length!==1){announce(matches.length?'决定编号不唯一，请输入完整编号。':'未找到可答复的待处理决定。');return;}
   const shown=await client.showDecision(matches[0].id),decision=shown?.decision||shown;
   if(!answerableDecision(decision)){announce(`该决定当前为 ${clean(decision.status||'UNKNOWN')}，不能再次答复；原答复和送达状态仍保留。`);return;}
   const displayed=decisionDetails(shown);
   state.decision={shown,decision,inputIndex:0,inputAnswers:{},presentedEvidence:`attach 终端于 ${now()} 向用户展示以下原问题回执：\n${displayed}`};
   announce(`${displayed}\n\n现在输入明确答复；/back 可取消本次输入且不会代答。`);
  };
  const answerDecision=async text=>{
   if(readOnly){announce('当前为只读 attach，不能回答决定。');return;}
   const current=state.decision,decision=current.decision;
   if(!decision.supported&&decision.supported!==undefined){announce(`该请求不能由 attach 回传：${clean(decision.limitation||'UNSUPPORTED')}`);return;}
   let answer;
   if(decision.kind==='BUSINESS')answer={text:text.trim()};
   else if(decision.kind==='APPROVAL') {
    const choice=answerChoice(text,decision.options||[]);
    if(!choice){announce('审批答复必须精确输入上方选项文字或编号；未发送任何答复。');return;}
    answer={decision:choice};
   } else if(decision.kind==='INPUT') {
    const question=decision.questions?.[current.inputIndex];
    if(!question){announce('原输入问题结构缺失，未发送任何答复。');return;}
    let value=text.trim();
    if(question.options?.length)value=answerChoice(text,question.options)||'';
    if(!value){announce('请输入非空答复；有选项时须输入选项文字或编号。');return;}
    current.inputAnswers[question.id]={answers:[value]};current.inputIndex++;
    if(current.inputIndex<decision.questions.length){announce(`已暂存第 ${current.inputIndex} 项，尚未发送。\n${decisionDetails({decision:{...decision,questions:[decision.questions[current.inputIndex]]}})}`);return;}
    answer={answers:current.inputAnswers};
   } else {announce(`决定类型 ${clean(decision.kind||'UNKNOWN')} 不支持在终端答复。`);return;}
   if(decision.kind==='BUSINESS'&&!answer.text){announce('业务决定不能为空，未发送任何答复。');return;}
   const receipt=await client.answer({decisionId:decision.id,answer,operationId:operationId('attach-answer'),presentedEvidence:current.presentedEvidence});
   state.decision=null;announce(`决定答复回执：${clean(receiptText(receipt))}${receipt?.operationId?' · '+clean(receipt.operationId):''}`);await refresh(true);
  };
  const submit=async text=>{
   const trimmed=text.trim();if(!trimmed)return;
   if(trimmed==='/detach'){detach();return;}
   if(trimmed==='/help'){showHelp();return;}
   if(trimmed==='/agents'){state.focus=null;state.decision=null;await refresh(true);return;}
   if(trimmed==='/back'){
    if(state.decision){state.decision=null;announce('已退出决定输入，未发送答复。');}
    else {state.focus=null;announce(`任务总览\n${renderTree(state.snapshot.nodes,numberForNode)}`);}
    return;
   }
   if(trimmed==='/decision'||trimmed.startsWith('/decision ')){await openDecision(trimmed.slice('/decision'.length));return;}
   if(trimmed.startsWith('/agent ')){setFocus(trimmed.slice('/agent '.length));return;}
   if(state.decision){await answerDecision(text);return;}
   if(!state.focus&&/^\d+$/.test(trimmed)){setFocus(trimmed);return;}
   if(!state.focus){announce('当前在任务总览；先输入节点数字或 /agent NODE，再发送消息。');return;}
   if(readOnly){announce('当前为只读 attach，不能发送消息。');return;}
   const node=state.snapshot.nodes.find(item=>item.id===state.focus.id);
   if(!node){announce('目标节点已不在当前任务树中，消息未发送。');state.focus=null;return;}
   if(node.canSend!==true){announce(`节点当前不可发送：${clean(node.reason||node.status||'状态未知')}。消息未发送。`);return;}
   const receipt=await client.send({assignmentId:node.id,text,operationId:operationId('attach-send')});
   announce(`发送回执：${clean(receiptText(receipt))}${receipt?.operationId?' · '+clean(receipt.operationId):''}`);await refresh(false);
  };
  const decoder=new AttachInputDecoder({
   onText:value=>{state.draft=value===null?lastGrapheme(state.draft):state.draft+value;redraw();},
   onSubmit:()=>{const text=state.draft;state.draft='';redraw();serial=serial.then(()=>submit(text)).catch(error=>announce(`操作失败：${clean(error.message)}`));},
   onDetach:detach,
  });
  const onData=bytes=>decoder.write(bytes),onEnd=()=>detach(),onError=error=>{if(!state.ended){state.ended=true;rejectDone(error);}};
  const onSignal=()=>detach();
  const wasRaw=input.isRaw===true;let timer;
  try {
   input.on('data',onData);input.once('end',onEnd);input.once('error',onError);
   process.once('SIGTERM',onSignal);process.once('SIGHUP',onSignal);process.once('SIGINT',onSignal);
   if(typeof input.setRawMode==='function')input.setRawMode(true);
   input.resume?.();output.write('\u001b[?2004h');
   for(const node of first.nodes||[])numberForNode(node.id);
   ingest(first,{initial:true});
   if(assignment&&!setFocus(assignment))throw Error(`TASK_ATTACH_ASSIGNMENT：未找到唯一节点 ${assignment}`);
   showHelp();
   timer=setInterval(async()=>{if(polling||state.ended)return;polling=true;serial=serial.then(()=>refresh(false)).finally(()=>{polling=false;});await serial;},Math.max(20,pollIntervalMs));
   return await done;
  }
  finally {
   clearInterval(timer);decoder.end();input.off('data',onData);input.off('end',onEnd);input.off('error',onError);
   process.off('SIGTERM',onSignal);process.off('SIGHUP',onSignal);process.off('SIGINT',onSignal);
   if(typeof input.setRawMode==='function')input.setRawMode(wasRaw);
   input.pause?.();input.unref?.();
   output.write('\u001b[?2004l');
  }
 } finally {await close();}
}
