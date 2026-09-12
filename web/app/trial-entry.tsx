'use client';

import {runtimePath} from './runtime-path';

import {useEffect,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
import {loadTrialScopes} from './trial-asset-review';
export function TrialScopeEntry(){
 const {hostedReadOnly}=useRuntimeMode();const [entries,setEntries]=useState<Array<{id:string;title:string}>>([]);
 useEffect(()=>{if(hostedReadOnly)return;const controller=new AbortController();void fetch('/api/v1/workspaces/configuration',{cache:'no-store',signal:controller.signal}).then(r=>r.ok?r.json():null).then(async(raw:unknown)=>{const value=raw as {trialAvailable?:boolean;configuration?:{presentation:{trialEnabled:boolean}}}|null;if(value?.trialAvailable&&value.configuration?.presentation.trialEnabled){const index=await loadTrialScopes(controller.signal);if(!controller.signal.aborted)setEntries(index.scopes);}}).catch(()=>{});return()=>controller.abort();},[hostedReadOnly]);
 return !hostedReadOnly&&entries.length?<span>{entries.map(entry=><a key={entry.id} className="trial-entry" href={runtimePath(`/trial?view=materials&scopeId=${encodeURIComponent(entry.id)}`)}>{entry.title} · 素材审阅 →</a>)}</span>:null;
}
