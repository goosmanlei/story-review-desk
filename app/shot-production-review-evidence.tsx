'use client';
/* eslint-disable @next/next/no-img-element */
import {useEffect,useState} from 'react';
import type {ShotProductionEvidence,ShotProductionEvidenceTemplate,ShotProductionFinding} from '../host/instance-runtime/shot-production-locks.mjs';
import './shot-production-review-evidence.css';

type ObservationMedia={versionId:string;familyId:string;sha256:string;kind:string;mediaUrl?:string};
export type ProductionEvidenceTemplate=ShotProductionEvidenceTemplate&{snapshotId?:string;observationMedia?:ObservationMedia[]};
const findingsKeys={jointFindings:['continuity','composition'],videoFindings:['action','camera','consistency','timing','adjacency']} as const;
const labels:Record<string,string>={continuity:'首尾及中间状态连续性',composition:'构图、身份与美术一致性',action:'动作与表演',camera:'摄影机运动',consistency:'人物、场景与道具一致性',timing:'时长、对白与动作节拍',adjacency:'完整预演中的前后镜衔接'};
function bindings(value:ShotProductionEvidence|null|undefined){if(!value)return null;const {observedImageIds,observedVideoIds,jointFindings,videoFindings,...base}=value;void observedImageIds;void observedVideoIds;void jointFindings;void videoFindings;return base;}
const sameBindings=(a:ShotProductionEvidence|null|undefined,b:ShotProductionEvidence|null|undefined)=>JSON.stringify(bindings(a))===JSON.stringify(bindings(b));
export function shotProductionEvidenceReady(template:ProductionEvidenceTemplate|null,evidence:ShotProductionEvidence|undefined){
 if(!template)return false;if(!template.required)return true;if(!template.evidence||!evidence||!sameBindings(template.evidence,evidence))return false;
 const observed=(actual:string[]|undefined,expected:string[]|undefined)=>(actual===undefined||Array.isArray(actual))&&(expected||[]).every(id=>actual?.includes(id))&&new Set(actual||[]).size===(actual||[]).length;
 if(!observed(evidence.observedImageIds,template.requiredObservedImageIds)||!observed(evidence.observedVideoIds,template.requiredObservedVideoIds))return false;
 const passed=(value:ShotProductionFinding|undefined)=>value?.outcome==='PASS'&&typeof value.note==='string'&&Boolean(value.note.trim())&&value.note.length<=4000;
 if(template.requiresJointReview&&!findingsKeys.jointFindings.every(key=>passed(evidence.jointFindings?.[key])))return false;
 if(evidence.kind==='SHOT_LOCK'&&!findingsKeys.videoFindings.every(key=>passed(evidence.videoFindings?.[key])))return false;
 return true;
}
export function useShotProductionEvidence({required,workItemId,versionId,snapshotId,revisionKey,value,onChange}:{required:boolean;workItemId:string;versionId?:string;snapshotId:string;revisionKey:string;value?:ShotProductionEvidence;onChange:(value:ShotProductionEvidence)=>void}){
 const [state,setState]=useState<{key:string;template:ProductionEvidenceTemplate|null;error:string}>({key:'',template:null,error:''}),[refreshKey,setRefreshKey]=useState(0);
 const key=[required,workItemId,versionId,snapshotId,revisionKey,refreshKey].join('|');
 useEffect(()=>{let active=true;if(!required||!versionId)return;const query=new URLSearchParams({workItemId,versionId});
  fetch('/api/v8/ui/shot-production-review-evidence?'+query,{cache:'no-store'}).then(async response=>{const result=await response.json() as ProductionEvidenceTemplate&{error?:string};if(!response.ok)throw Error(result.error||'制作验收依据暂不可用');if(result.snapshotId!==snapshotId||!result.required||!result.evidence)throw Error('当前验收依据已变化，请重新读取运行快照');if(active)setState({key,template:result,error:''});}).catch(error=>{if(active)setState({key,template:null,error:error instanceof Error?error.message:'制作验收依据暂不可用'});});return()=>{active=false;};
 },[required,workItemId,versionId,snapshotId,key]);
 const template=state.key===key?state.template:null;
 useEffect(()=>{if(template?.evidence&&!sameBindings(template.evidence,value))onChange(structuredClone(template.evidence));},[template,value,onChange]);
 return {template,error:state.key===key?state.error:'',loading:required&&Boolean(versionId)&&state.key!==key,ready:!required||shotProductionEvidenceReady(template,value),refresh:()=>setRefreshKey(value=>value+1)};
}

function Observation({media,kind,checked,disabled,onChange}:{media:ObservationMedia;kind:'IMAGE'|'VIDEO';checked:boolean;disabled:boolean;onChange:(checked:boolean)=>void}){
 const key=[media.versionId,media.sha256,media.mediaUrl].join('|'),valid=/^[a-f0-9]{64}$/.test(media.sha256);
 const [resolved,setResolved]=useState<{key:string;url:string|null;error:string}>({key:'',url:null,error:''}),[loadedKey,setLoadedKey]=useState(''),[playedKey,setPlayedKey]=useState('');
 const url=valid?(media.mediaUrl||(resolved.key===key?resolved.url:null)):null,error=!valid?'缺少此版本的精确SHA':resolved.key===key?resolved.error:'';
 useEffect(()=>{let active=true;if(!valid||media.mediaUrl)return;
  crypto.subtle.digest('SHA-256',new TextEncoder().encode(media.versionId)).then(hash=>{const base64=btoa(String.fromCharCode(...new Uint8Array(hash))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');if(active)setResolved({key,url:'/api/v8/media/m_'+base64.slice(0,28),error:''});}).catch(()=>{if(active)setResolved({key,url:null,error:'无法解析原件'});});return()=>{active=false;};
 },[key,valid,media.versionId,media.mediaUrl]);
 function failed(message:string){setLoadedKey('');setResolved({key,url,error:message});}
 return <figure><figcaption>{media.versionId}<small>SHA {media.sha256||'UNKNOWN'}</small></figcaption>
  {url&&(kind==='IMAGE'?<img src={url} alt={'联合验收原图 '+media.versionId} onLoad={()=>setLoadedKey(key)} onError={()=>failed('原件无法加载')}/>:<video src={url} controls preload="metadata" onCanPlay={()=>setLoadedKey(key)} onPlay={()=>setPlayedKey(key)} onError={()=>failed('原件无法播放')}/>)}
  {error&&<p role="alert">{error}</p>}
  <label><input type="checkbox" checked={checked} disabled={disabled||loadedKey!==key||(kind==='VIDEO'&&playedKey!==key)} onChange={e=>onChange(e.target.checked)}/>{kind==='IMAGE'?'我已观察这张精确版本原图':'我已播放并检查这份精确版本视频'}</label>
 </figure>;
}

export function ShotProductionEvidencePanel({template,evidence,onChange,disabled,versions=[]}:{template:ProductionEvidenceTemplate;evidence?:ShotProductionEvidence;onChange:(value:ShotProductionEvidence)=>void;disabled:boolean;versions?:Array<{id:string;familyId:string;sha256:string|null;path:string|null}>}){
 const current=evidence&&sameBindings(template.evidence,evidence)?evidence:template.evidence;if(!current)return null;
 function observe(key:'observedImageIds'|'observedVideoIds',id:string,checked:boolean){onChange({...current!,[key]:checked?[...new Set([...(current![key]||[]),id])]:(current![key]||[]).filter(value=>value!==id)});}
 function media(id:string):ObservationMedia{const supplied=template.observationMedia?.find(row=>row.versionId===id);if(supplied)return supplied;const member=current!.members?.find(m=>m.versionId===id),version=versions.find(v=>v.id===id);return{versionId:id,familyId:member?.familyId||version?.familyId||'',sha256:member?.sha256||version?.sha256||'',kind:''};}
 function findings(group:'jointFindings'|'videoFindings'){return findingsKeys[group].map(key=>{const entries=current![group] as Record<string,ShotProductionFinding>|undefined,finding=entries?.[key];return <fieldset key={key}><legend>{labels[key]}</legend><label>验收结论<select value={finding?.outcome||''} disabled={disabled} onChange={e=>{const next={...(entries||{})};if(e.target.value)next[key]={outcome:'PASS',note:finding?.note||''};else delete next[key];onChange({...current!,[group]:next});}}><option value="">尚未判断</option><option value="PASS">观察后确认通过</option></select></label><label>实际观察与判断依据<textarea value={finding?.note||''} maxLength={4000} disabled={disabled} onChange={e=>onChange({...current!,[group]:{...(entries||{}),[key]:{outcome:finding?.outcome,note:e.target.value}}} as ShotProductionEvidence)}/></label></fieldset>;});}
 return <section className="shot-production-evidence" aria-label="镜头制作验收证据"><h4>{current.kind==='INPUT_LOCK'?'实际输入基线核对':current.kind==='KEYFRAME'?'关键帧联合验收':'单镜完整上下文验收'}</h4>
  <p>{current.kind==='INPUT_LOCK'?'本次结论绑定当前输入清单与空间条件。':current.kind==='KEYFRAME'?'逐张核对原图，完整集合还须说明连续性和构图。':'播放本镜视频及完整预演，再逐项说明动作、运镜、一致性、时间与前后镜衔接。'}</p>
  <details><summary>本次精确制作依据</summary><pre>{JSON.stringify(bindings(current),null,2)}</pre></details>
  <div className="shot-production-observations">{(template.requiredObservedImageIds||[]).map(id=><Observation key={'image:'+id} media={media(id)} kind="IMAGE" checked={current.observedImageIds?.includes(id)||false} disabled={disabled} onChange={checked=>observe('observedImageIds',id,checked)}/>)}{(template.requiredObservedVideoIds||[]).map(id=><Observation key={'video:'+id} media={media(id)} kind="VIDEO" checked={current.observedVideoIds?.includes(id)||false} disabled={disabled} onChange={checked=>observe('observedVideoIds',id,checked)}/>)}</div>
  {template.requiresJointReview&&findings('jointFindings')}{current.kind==='SHOT_LOCK'&&findings('videoFindings')}
 </section>;
}
