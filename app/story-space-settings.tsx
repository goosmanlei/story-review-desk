'use client';
import {useEffect,useState} from 'react';
import type {SpatialSettings} from '../host/instance-runtime/domain-spatial.mjs';
import {readManagementResponse} from './system-management-client';
const labels:Record<string,string>={tower:'建筑空间包',shops:'相邻场地空间包',masan:'院落与户外空间包',minimal_location_packages:'其他地点空间包',states:'既有冻结状态',scene_route_locks:'既有场景路线',bounds_m:'尺寸边界（米）',envelope_lock:'外轮廓锁定',zones:'区域',cameras:'固定机位',key_jar_anchors:'醋缸固定锚点',anchors:'固定锚点',east_gate_lock:'东门锁定',location_id:'地点身份',locationId:'地点身份',id:'永久编号',label:'名称',name:'名称',rect:'局部平面矩形',position:'位置',pos:'位置',note:'说明',description:'说明',orientation:'统一方向',coordinate_system:'坐标系统',version:'基线版本',state_id:'状态身份',scene_id:'原场号',camera_id:'机位身份',zone_id:'区域身份',fact:'故事事实',lock:'制作锁定',entrance:'入口',freeze_id:'冻结点'};
function valueLabel(value:unknown){return typeof value==='string'?value:JSON.stringify(value);}
function ReadValue({value,depth=0}:{value:unknown;depth?:number}){
 if(value===null||value===undefined)return <span>未登记</span>;
 if(typeof value!=='object')return <span>{String(value)}</span>;
 if(Array.isArray(value)){if(!value.length)return <span>尚未登记</span>;if(value.every(v=>typeof v!=='object'||v===null))return <span>{value.map(valueLabel).join(' · ')}</span>;return <div className="settings-spatial-items">{value.map((v,i)=><article key={i}><ReadValue value={v} depth={depth+1}/></article>)}</div>;}
 return <dl className="settings-facts">{Object.entries(value).map(([key,item])=><div key={key}><dt>{labels[key]||key}</dt><dd>{depth>2&&item&&typeof item==='object'?<details><summary>展开资料</summary><ReadValue value={item} depth={depth+1}/></details>:<ReadValue value={item} depth={depth+1}/>}</dd></div>)}</dl>;
}
export function StorySpaceSettings(){const [state,setState]=useState<SpatialSettings|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);useEffect(()=>{const controller=new AbortController();void fetch('/api/instance/spatial-settings',{cache:'no-store',signal:controller.signal}).then(readManagementResponse<SpatialSettings>).then(setState).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[attempt]);
 if(error)return <p role="alert">{error}<button onClick={()=>{setError('');setAttempt(v=>v+1);}}>重新读取空间资料</button></p>;
 if(!state)return <p role="status">正在读取已发布空间基线…</p>;
 if(state.status==='NOT_CONFIGURED')return <p className="settings-empty">尚未登记独立空间基线。可以先建立地点档案，再在受控资料中登记方向、区域、锚点和机位。</p>;
 const spec=state.specification||{},keys=Object.keys(spec),primary=['tower','shops','masan','minimal_location_packages','states','scene_route_locks'];
 return <section className="settings-spatial-baseline" aria-label="完整空间基线"><h2>空间基线与连续性依据</h2><p>总图与局部空间分开查阅。各地点使用自己的局部坐标，不将不同坐标系直接拼合。既有状态与路线保留原资料中的场号；未与当前剧本自动对应。</p><div className="settings-spatial-packages">{primary.filter(k=>keys.includes(k)).map(key=><details key={key} open={key==='tower'||key==='shops'||key==='masan'}><summary>{labels[key]}</summary><ReadValue value={spec[key]}/></details>)}</div><details><summary>全局方向、版本与其余设定</summary><ReadValue value={Object.fromEntries(Object.entries(spec).filter(([k])=>!primary.includes(k)))}/></details><details><summary>精确来源与适用修订</summary><p>{state.sourceBinding?.logicalPath}</p><code>{state.sourceBinding?.revisionId}<br/>{state.sourceBinding?.sha256}</code><p>空间锁定是制作依据，不冒充原故事或历史地理事实。</p></details></section>;
}
