'use client';

import type {EpisodePlanEpisode} from './episode-plan-context';
import type {ReactNode} from 'react';
import {runtimeLabel,type RuntimeEstimate} from './narrative-revision';

export type NarrativeSceneLabel={displayId:string;title:string};
export type EpisodeNavigationState={label:string;failed:boolean;submitted:boolean};
type Props={
 episodes:EpisodePlanEpisode[];
 selectedEpisodeUid:string;
 selectedSceneId?:string|null;
 sceneLabels:Record<string,NarrativeSceneLabel>;
 states:Record<string,EpisodeNavigationState>;
 summary?:ReactNode;
 sceneReading?:ReactNode;
 sceneRuntimes?:Record<string,RuntimeEstimate>;
 lockedEpisodeUid?:string|null;
 onSelectEpisode:(episodeUid:string)=>void;
 onSelectScene?:(sceneId:string|null)=>void;
};

export function EpisodeSceneNavigator({episodes,selectedEpisodeUid,selectedSceneId,sceneLabels,states,summary,sceneReading,sceneRuntimes={},lockedEpisodeUid,onSelectEpisode,onSelectScene}:Props){
 const episode=episodes.find(item=>item.episodeUid===selectedEpisodeUid);
 const runtimeFor=(id:string)=>{const value=sceneRuntimes[id];return value&&[value.baseSec,value.compactSec,value.spaciousSec].every(seconds=>Number.isFinite(seconds)&&seconds>=0)?value:null;};
 return <section className="narrative-unit-navigator" aria-label="集与场审阅目录">
  <nav className="episode-review-navigator" aria-label="逐集审阅进度">{episodes.map(item=>{
   const state=states[item.episodeUid],selected=item.episodeUid===selectedEpisodeUid;
   const first=item.sceneIds[0],last=item.sceneIds.at(-1);
   return <button type="button" key={item.episodeUid} data-episode-uid={item.episodeUid} aria-pressed={selected} disabled={Boolean(lockedEpisodeUid&&lockedEpisodeUid!==item.episodeUid)} className={`${selected?'active ':''}${state?.failed?'has-failure':state?.submitted?'is-complete':''}`} onClick={()=>onSelectEpisode(item.episodeUid)}>
    <span>{item.displayId}</span><b>{sceneLabels[first]?.displayId||first}{last&&last!==first?'–'+(sceneLabels[last]?.displayId||last):''}</b><strong>{item.title}</strong><small>{state?.label||'状态待核'}</small>
   </button>;
  })}</nav>
  {summary}
  {onSelectScene&&episode&&<section className="episode-scene-navigator" aria-label={episode.displayId+'本集拆解与场次'}>
   <div className="episode-scene-table-scroll"><table className="episode-scene-timing-table" aria-label={episode.displayId+'场次与估时'}><colgroup><col className="scene-title-column"/><col className="scene-base-column"/><col className="scene-range-column"/></colgroup><thead><tr><th scope="col">场次</th><th scope="col">基准</th><th scope="col">紧凑／舒展</th></tr></thead><tbody>
    {episode.sceneIds.map((id,index)=>{const label=sceneLabels[id],runtime=runtimeFor(id);return <tr key={id} data-timing-scene-id={id} aria-selected={selectedSceneId===id} onClick={event=>{if(!(event.target as Element).closest('button'))onSelectScene(id);}}><th scope="row"><button type="button" data-scene-id={id} aria-pressed={selectedSceneId===id} onClick={()=>onSelectScene(id)}><small>{label?.displayId||'本集第 '+(index+1)+' 场'}</small><strong>{label?.title||id}</strong></button></th><td>{runtime?runtimeLabel(runtime.baseSec):'UNKNOWN'}</td><td>{runtime?runtimeLabel(runtime.compactSec)+' ／ '+runtimeLabel(runtime.spaciousSec):'UNKNOWN'}</td></tr>;})}
   </tbody></table></div>
   <div className="episode-scene-reading-slot">{sceneReading}</div>
  </section>}
  {onSelectScene&&<p className="narrative-unit-boundary">在正文中圈选评论，具体问题汇入下方六项集级判断。评论不替代正式结论或采用。</p>}
 </section>;
}
