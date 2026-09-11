'use client';
import {useState,useEffect} from 'react';
import {read} from './client';
import {kindLabels,type Summary} from './types';
export function LinkPicker({kind,label,onChoose}:{kind:string;label:string;onChoose:(item:Summary)=>void}){
 const [query,setQuery]=useState(''),[items,setItems]=useState<Summary[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;const timer=setTimeout(()=>{read('objects?'+new URLSearchParams({kind,query,limit:'20'})).then(r=>{if(active){setItems(r.items);setError('');}}).catch(e=>active&&setError(e.message));},150);return()=>{active=false;clearTimeout(timer);};},[kind,query]);
 return <details className="link-picker"><summary>{label}</summary><input aria-label={'查找'+kindLabels[kind]} value={query} placeholder={'按名称查找'+kindLabels[kind]} onChange={e=>setQuery(e.target.value)}/>{error&&<p role="alert">{error}</p>}<div>{items.map(item=><button type="button" key={item.id} onClick={()=>onChoose(item)}>{item.displayId&&item.displayId+' · '}{item.title}</button>)}</div></details>;
}
