 'use client';
import {useEffect,useState} from 'react';
import {useRuntimeMode} from './runtime-mode';
export function TrialScopeEntry(){
 const {hostedReadOnly}=useRuntimeMode();const [entry,setEntry]=useState<string|null>(null);
 useEffect(()=>{if(hostedReadOnly)return;let active=true;void fetch('/api/instance/configuration',{cache:'no-store'}).then(r=>r.ok?r.json():null).then((s:unknown)=>{const value=s as {trialAvailable?:boolean;configuration?:{presentation:{trialEnabled:boolean;trialLabel:string}}}|null;if(active&&value?.trialAvailable&&value.configuration?.presentation.trialEnabled)setEntry(value.configuration.presentation.trialLabel);}).catch(()=>{});return()=>{active=false;};},[hostedReadOnly]);
 return !hostedReadOnly&&entry?<a className="trial-entry" href="/trial?view=materials">{entry} · 素材审阅 →</a>:null;
}
