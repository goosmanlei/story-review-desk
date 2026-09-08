'use client';
import {useState} from 'react';
import {useManagementDraftGuard} from './management-draft-guard';
import {CAMERA_ANGLES,CAMERA_MOVEMENTS,KEYFRAME_STRATEGIES,SHOT_SIZES,canonicalShotDesign,type ShotDesign} from '../host/instance-runtime/shot-design-contract.mjs';
import './shot-design-editor.css';

type Binding={bindingType:string;bindingId:string;bindingHash:string};
type Shot={shotId:string;sceneId:string;order:number;title:string;coverageBeatRefs:string[];visualIntent:string;actionIntent:string;soundIntent:string;dialogueContext:string;narrativeBeat:string;audienceTakeaway:string;materialRequirementRefs:string[];inputBindings:Binding[];design?:ShotDesign};
type Content={sceneId?:string;identityChangeReason?:string;shots?:Shot[];beats?:Array<{beatId:string;narrativeBeat:string;materialRequirementRefs:string[]}>};
export type ShotDesignPlan={canAuthor:boolean;basisBindings:Binding[];candidate?:{creativeRevisionId:string;content:Content};template?:{planId:string;revisionHash:string;content?:Content;retiredShotIds?:string[]}};
const optionLabels:Record<string,string>={EXTREME_WIDE:'大远景',WIDE:'远景',FULL:'全景',MEDIUM:'中景',CLOSE_UP:'近景',EXTREME_CLOSE_UP:'特写',UNKNOWN:'待确认',EYE_LEVEL:'平视',HIGH:'俯拍',LOW:'仰拍',OVER_SHOULDER:'过肩',POV:'主观',TOP_DOWN:'正顶拍',DUTCH:'倾斜',OTHER:'其他（在构图中说明）',STATIC:'固定',PUSH:'推',PULL:'拉',PAN:'摇',TILT:'上下摇',TRACK:'移',FOLLOW:'跟拍',HANDHELD:'手持',CRANE:'升降',ORBIT:'环绕',UNDECIDED:'策略待确认',START_ONLY:'单首帧',START_END:'首尾帧',MULTI_KEYFRAME:'首尾及中间关键帧'};
const textFields=[['title','镜头标题'],['narrativeBeat','叙事目的与节拍'],['audienceTakeaway','观众所得'],['visualIntent','画面意图'],['actionIntent','角色动作'],['soundIntent','声音意图'],['dialogueContext','对白与表演上下文']] as const;
function newDesign():ShotDesign{return {shotSize:'UNKNOWN',cameraAngle:'UNKNOWN',cameraMovement:'UNKNOWN',composition:'UNKNOWN',performance:'UNKNOWN',lighting:'UNKNOWN',estimatedDurationSeconds:null,subjectIds:[],continuity:{startState:'UNKNOWN',endState:'UNKNOWN',previousShotId:null,nextShotId:null,transitionIn:'UNKNOWN',transitionOut:'UNKNOWN'},keyframeStrategy:{mode:'UNDECIDED',reason:'UNKNOWN',intermediateFrameCount:0}};}

export function ShotDesignSummary({design}:{design?:ShotDesign}) {
 if(!design)return <p className="shot-design-unknown">此版本尚未登记结构化镜头规格，设计估时和关键帧策略待确认。</p>;
 return <dl className="shot-design-summary">
  <div><dt>镜头</dt><dd>{[design.shotSize,design.cameraAngle,design.cameraMovement].map(x=>optionLabels[x]||x).join(' · ')}</dd></div>
  <div><dt>构图与光线</dt><dd>{design.composition}；{design.lighting}</dd></div>
  <div><dt>表演</dt><dd>{design.performance}</dd></div>
  <div><dt>设计估时</dt><dd>{design.estimatedDurationSeconds===null?'待确认':`${design.estimatedDurationSeconds} 秒（估计，尚非锁时）`}</dd></div>
  <div><dt>状态衔接</dt><dd>{design.continuity.startState} → {design.continuity.endState}；{design.continuity.transitionIn} / {design.continuity.transitionOut}</dd></div>
  <div><dt>关键帧策略</dt><dd>{optionLabels[design.keyframeStrategy.mode]}{design.keyframeStrategy.mode==='MULTI_KEYFRAME'?`，${design.keyframeStrategy.intermediateFrameCount} 张中间帧`:''}；{design.keyframeStrategy.reason}</dd></div>
 </dl>;
}

export function ShotDesignEditor({plan,coverage,sceneId,snapshotId,readOnly,onSaved}:{plan:ShotDesignPlan;coverage?:Content;sceneId:string;snapshotId:string;readOnly:boolean;onSaved:()=>void}) {
 const [editing,setEditing]=useState(false),[shots,setShots]=useState<Shot[]>([]),[selected,setSelected]=useState(0),[reason,setReason]=useState('NO_IDENTITY_CHANGE'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
 useManagementDraftGuard(editing,'镜头设计');
 const selectedShot=shots[selected],beats=coverage?.beats||[],source=plan.candidate?.content||plan.template?.content;
 function begin(){setShots(structuredClone(source?.shots||[]).map(shot=>({...shot,design:shot.design||newDesign()})));setReason(source?.identityChangeReason||'NO_IDENTITY_CHANGE');setSelected(0);setEditing(true);setMessage('');setUncertain(false);}
 function update(change:Partial<Shot>){setShots(rows=>rows.map((row,index)=>index===selected?{...row,...change}:row));}
 function updateDesign(change:Partial<ShotDesign>){if(selectedShot)update({design:{...selectedShot.design!,...change}});}
 function add(){const used=[...shots.map(s=>s.shotId),...(plan.template?.retiredShotIds||[]),...(plan.template?.content?.shots||[]).map(s=>s.shotId)];let number=Math.max(0,...used.map(id=>Number(id.startsWith(sceneId+'-SH')?id.slice(sceneId.length+3):0)||0))+1;while(used.includes(`${sceneId}-SH${String(number).padStart(2,'0')}`))number++;const shotId=`${sceneId}-SH${String(number).padStart(2,'0')}`;setShots(rows=>[...rows,{shotId,sceneId,order:rows.length+1,title:'',coverageBeatRefs:[],visualIntent:'',actionIntent:'',soundIntent:'',dialogueContext:'',narrativeBeat:'',audienceTakeaway:'',materialRequirementRefs:[],inputBindings:[],design:newDesign()}]);setSelected(shots.length);}
 function move(offset:number){const target=selected+offset;if(target<0||target>=shots.length)return;const next=[...shots];[next[selected],next[target]]=[next[target],next[selected]];setShots(next);setSelected(target);}
 async function save(){
  if(!plan.template||!plan.canAuthor||readOnly||busy||uncertain)return;
  setBusy(true);setMessage('');let submitted=false;
  try {
   const bindings=plan.basisBindings.map(({bindingType,bindingId,bindingHash})=>({bindingType,bindingId,bindingHash}));
   const rows=shots.map((shot,index)=>({...shot,order:index+1,sceneId,inputBindings:bindings,design:canonicalShotDesign({...shot.design,continuity:{...shot.design!.continuity,previousShotId:shots[index-1]?.shotId||null,nextShotId:shots[index+1]?.shotId||null}})}));
   if(!rows.length)throw Error('请至少编写一个镜头。');
   const bindingResponse=await fetch('/api/v8/operations/snapshot',{cache:'no-store'}),binding=await bindingResponse.json() as {snapshotId?:string;mutationEtag?:string};
   if(!bindingResponse.ok||binding.snapshotId!==snapshotId||!binding.mutationEtag)throw Error('当前依据已变化，请保留草稿并重新核对。');
   submitted=true;
   const response=await fetch('/api/v8/creative-revisions',{method:'POST',headers:{'Content-Type':'application/json','If-Match':binding.mutationEtag,'Idempotency-Key':`shot-design-${crypto.randomUUID()}`},body:JSON.stringify({snapshotId,subjectKind:'SHOT_PLAN_SET',subjectId:plan.template.planId,baseRevisionHash:plan.template.revisionHash,planningContractVersion:'3.0',authorityClass:'A',basisBindings:plan.basisBindings,content:{sceneId,identityChangeReason:reason,shots:rows}})});
   const result=await response.json() as {error?:string;creativeRevisionId?:string};
   if(!response.ok){if(response.status<500)submitted=false;throw Error(result.error||'候选登记失败');}
   if(!result?.creativeRevisionId?.trim())throw Error('候选登记回执不完整');
   setEditing(false);setMessage('镜头设计候选已登记，请在本场完成独立正式审阅。');onSaved();window.dispatchEvent(new CustomEvent('review:operations-updated'));
  }catch(error){if(submitted)setUncertain(true);setMessage((error instanceof Error?error.message:'提交未确认')+(submitted?' 请先核查当前候选；没有自动重试。':''));}finally{setBusy(false);}
 }
 if(readOnly||!plan.canAuthor)return null;
 return <section className="shot-design-editor" aria-label="结构化镜头设计编辑">
  {!editing?<button type="button" onClick={begin}>{source?.shots?.length?'编辑新镜头设计候选':'编写镜头设计'}</button>:<>
   <p>每镜先明确表达、构图与设计估时。保存会登记新候选，正式审阅与实际输入锁定各自完成。</p>
   <fieldset disabled={busy||uncertain} className="shot-design-authoring-fields"><div className="shot-design-editor-layout"><aside><nav aria-label="编辑中的镜头">{shots.map((shot,index)=><button key={shot.shotId} type="button" aria-pressed={index===selected} onClick={()=>setSelected(index)}>{index+1}. {shot.title||'未命名镜头'}</button>)}</nav><button type="button" onClick={add}>增加镜头</button></aside>
    <main>{selectedShot&&<>
     <p className="shot-design-identity">永久镜头：{selectedShot.shotId}</p>
     <div className="shot-design-actions"><button type="button" disabled={selected===0} onClick={()=>move(-1)}>前移</button><button type="button" disabled={selected===shots.length-1} onClick={()=>move(1)}>后移</button><button type="button" onClick={()=>{setShots(rows=>rows.filter((_,i)=>i!==selected));setSelected(Math.max(0,selected-1));}}>移除本镜</button></div>
     {textFields.map(([key,label])=><label key={key}>{label}<textarea value={selectedShot[key]} onChange={e=>update({[key]:e.target.value})}/></label>)}
     <fieldset><legend>覆盖已采用节拍</legend>{beats.map(beat=><label key={beat.beatId}><input type="checkbox" checked={selectedShot.coverageBeatRefs.includes(beat.beatId)} onChange={e=>{const refs=e.target.checked?[...selectedShot.coverageBeatRefs,beat.beatId]:selectedShot.coverageBeatRefs.filter(id=>id!==beat.beatId);const requirements=[...new Set(beats.filter(b=>refs.includes(b.beatId)).flatMap(b=>b.materialRequirementRefs))];update({coverageBeatRefs:refs,materialRequirementRefs:requirements});}}/>{beat.narrativeBeat}</label>)}</fieldset>
     <fieldset><legend>本镜素材需求</legend>{[...new Set(beats.filter(b=>selectedShot.coverageBeatRefs.includes(b.beatId)).flatMap(b=>b.materialRequirementRefs))].map(id=><label key={id}><input type="checkbox" checked={selectedShot.materialRequirementRefs.includes(id)} onChange={e=>update({materialRequirementRefs:e.target.checked?[...selectedShot.materialRequirementRefs,id]:selectedShot.materialRequirementRefs.filter(x=>x!==id)})}/>{id}</label>)}</fieldset>
     <div className="shot-design-three-fields">{([['shotSize','景别',SHOT_SIZES],['cameraAngle','机位',CAMERA_ANGLES],['cameraMovement','摄影机运动',CAMERA_MOVEMENTS]] as const).map(([key,label,options])=><label key={key}>{label}<select value={selectedShot.design![key]} onChange={e=>updateDesign({[key]:e.target.value})}>{options.map(value=><option key={value} value={value}>{optionLabels[value]}</option>)}</select></label>)}</div>
     {([['composition','构图与空间'],['performance','表演与情绪'],['lighting','时间与光线']] as const).map(([key,label])=><label key={key}>{label}<textarea value={selectedShot.design![key]} onChange={e=>updateDesign({[key]:e.target.value})}/></label>)}
     <label>设计估时（秒，留空为待确认）<input type="number" min="0.01" step="any" value={selectedShot.design!.estimatedDurationSeconds??''} onChange={e=>updateDesign({estimatedDurationSeconds:e.target.value===''?null:Number(e.target.value)})}/></label>
     <label>画面主体永久身份（逗号分隔，无主体留空）<input value={selectedShot.design!.subjectIds.join(', ')} onChange={e=>updateDesign({subjectIds:e.target.value.split(/[,，\s]+/).filter(Boolean)})}/></label>
     {([['startState','动作起点'],['endState','动作终点'],['transitionIn','前镜／前场承接'],['transitionOut','后镜／后场交接']] as const).map(([key,label])=><label key={key}>{label}<textarea value={selectedShot.design!.continuity[key]} onChange={e=>updateDesign({continuity:{...selectedShot.design!.continuity,[key]:e.target.value}})}/></label>)}
     <label>关键帧策略<select value={selectedShot.design!.keyframeStrategy.mode} onChange={e=>updateDesign({keyframeStrategy:{...selectedShot.design!.keyframeStrategy,mode:e.target.value as ShotDesign['keyframeStrategy']['mode'],intermediateFrameCount:e.target.value==='MULTI_KEYFRAME'?Math.max(1,selectedShot.design!.keyframeStrategy.intermediateFrameCount):0}})}>{KEYFRAME_STRATEGIES.map(value=><option key={value} value={value}>{optionLabels[value]}</option>)}</select></label>
     {selectedShot.design!.keyframeStrategy.mode==='MULTI_KEYFRAME'&&<label>中间关键帧数量<input type="number" min="1" max="100" step="1" value={selectedShot.design!.keyframeStrategy.intermediateFrameCount} onChange={e=>updateDesign({keyframeStrategy:{...selectedShot.design!.keyframeStrategy,intermediateFrameCount:Number(e.target.value)}})}/></label>}
     <label>关键帧策略依据<textarea value={selectedShot.design!.keyframeStrategy.reason} onChange={e=>updateDesign({keyframeStrategy:{...selectedShot.design!.keyframeStrategy,reason:e.target.value}})}/></label>
    </>}</main></div>
   <label>镜头增删或身份变更理由<textarea value={reason} onChange={e=>setReason(e.target.value)}/></label></fieldset>
   <div className="shot-design-actions"><button type="button" disabled={busy||uncertain||!shots.length} onClick={()=>void save()}>{busy?'正在登记…':'登记镜头设计候选'}</button><button type="button" disabled={busy} onClick={()=>{if(confirm('放弃本次未保存镜头设计？'))setEditing(false);}}>取消编辑</button>{uncertain&&<button type="button" onClick={()=>{setEditing(false);onSaved();}}>核查当前候选</button>}</div>
  </>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
