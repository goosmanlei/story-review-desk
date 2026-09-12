'use client';
import {useState} from 'react';
import {readManagementResponse} from './system-management-client';
import {runtimePath} from './runtime-path';
type Item={revisionId:string;title:string;recordedAt:string;sha256:string};
export function StoryHistory(){
  const [open,setOpen]=useState(false),[items,setItems]=useState<Item[]|null>(null),[error,setError]=useState('');
  async function show(){setOpen(!open);if(items||open)return;try{setItems((await fetch('/api/v1/workspaces/story-history',{cache:'no-store'}).then(readManagementResponse<{items:Item[]}>)).items);}catch(e){setError(e instanceof Error?e.message:'历史版本读取失败');}}
  return <section className="management-card"><button type="button" aria-expanded={open} onClick={()=>void show()}>查看原始方案版本</button>{open&&<>{error&&<p role="alert">{error}</p>}{items?<><p>各版本按原候选保留。打开历史版本不会改变当前稿或采用状态。</p><ul>{items.map((item,index)=><li key={item.revisionId}><a href={runtimePath('?view=story&storyMode=story-structure&episodePlanArchive=1&episodePlanRevision='+encodeURIComponent(item.revisionId))}>方案 {index+1} · {item.recordedAt?new Date(item.recordedAt).toLocaleString('zh-CN'):item.revisionId}</a></li>)}</ul>{!items.length&&<p>尚无导入的原始方案历史。</p>}</>:!error&&<p role="status">正在读取历史目录…</p>}</>}</section>;
}
