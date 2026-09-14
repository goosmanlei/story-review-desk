'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {instanceSessionStorage} from './client-storage';

type NavigationMemory={expanded:Record<string,boolean>;scenes:Record<string,string>;reading:Record<string,number>};
const empty=():NavigationMemory=>({expanded:{},scenes:{},reading:{}});
const storageKey='production-navigation-v1';
function read():NavigationMemory{
 try{
  const value=JSON.parse(instanceSessionStorage.getItem(storageKey)||'null'),result=empty();
  for(const key of ['expanded','scenes','reading'] as const){
   if(!value?.[key]||typeof value[key]!=='object'||Array.isArray(value[key]))continue;
   for(const [id,item] of Object.entries(value[key]).slice(-256)){
    if(key==='expanded'&&typeof item==='boolean')result.expanded[id]=item;
    if(key==='scenes'&&typeof item==='string')result.scenes[id]=item;
    if(key==='reading'&&typeof item==='number'&&Number.isFinite(item))result.reading[id]=item;
   }
  }
  return result;
 }catch{return empty();}
}
// Disposable reading preferences only. They never establish story identity or
// replace the URL's explicit permanent episode/scene selection.
export function usePreparationNavigation(scope:string){
 const memory=useRef(empty()),[expanded,setExpanded]=useState<Record<string,boolean>>({});
 useLayoutEffect(()=>{memory.current=read();setExpanded(memory.current.expanded);},[scope]);
 function save(){try{const value=memory.current;value.reading=Object.fromEntries(Object.entries(value.reading).slice(-256));instanceSessionStorage.setItem(storageKey,JSON.stringify(value));}catch{/* Reading remains usable when storage is unavailable. Draft protection is separate. */}}
 return {expanded,setExpanded:(id:string,value:boolean)=>{memory.current.expanded={...memory.current.expanded,[id]:value};setExpanded(memory.current.expanded);save();},
  rememberScene:(episode:string,scene:string)=>{if(memory.current.scenes[episode]===scene)return;memory.current.scenes[episode]=scene;save();},
  lastScene:(episode:string)=>memory.current.scenes[episode],
  readPosition:(key:string)=>memory.current.reading[key],
  savePosition:(key:string,value:number)=>{memory.current.reading[key]=value;save();}};
}

export function usePreparationReading(key:string,ready:boolean,navigation:ReturnType<typeof usePreparationNavigation>){
 const pane=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null),latest=useRef(navigation);latest.current=navigation;
 const previousKey=useRef<string|null>(null);
 // One owner for the real page scrollport. The directory shares this page;
 // giving it a second restoration hook would race the content checkpoint.
 useLayoutEffect(()=>{
  if(!ready)return;
  const previous=window.history.scrollRestoration;window.history.scrollRestoration='manual';
  return()=>{window.history.scrollRestoration=previous;};
 },[ready]);
 useLayoutEffect(()=>{
  const element=pane.current,content=body.current;if(!ready||!element||!content)return;
  let ancestor=element.parentElement;
  while(ancestor&&ancestor!==document.body&&!/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY))ancestor=ancestor.parentElement;
  const host=ancestor&&ancestor!==document.body&&ancestor!==document.documentElement?ancestor:null;
  const scrollport=host||document.scrollingElement||document.documentElement,eventTarget=host||window;
  const offset=()=>((host?host.getBoundingClientRect().top+host.clientTop:0)-element.getBoundingClientRect().top);
  // Page offsets may be negative while the module navigation is in view.
  // A legacy pane offset still identifies the same distance into this body;
  // migrate it once, then keep page checkpoints separate from directory data.
  const positionKey='page:'+key,legacy=latest.current.readPosition(key);
  const saved=latest.current.readPosition(positionKey)??(legacy>=0?legacy:undefined);
  const target=saved??(previousKey.current===null?offset():Math.min(0,offset()));
  previousKey.current=key;
  let restoring=true,frame=0;
  const save=()=>latest.current.savePosition(positionKey,offset());
  const restore=()=>{
   if(!restoring)return;
   // Required child reads retain the previous layout. Wait for the new body
   // before consuming its checkpoint, even when the old height could fit it.
   if(content.querySelector('.workspace-read-boundary[aria-busy="true"]'))return;
   const maximum=Math.max(0,scrollport.scrollHeight-(host?host.clientHeight:window.innerHeight));
   const destination=Math.max(0,Math.min(maximum,scrollport.scrollTop+target-offset()));
   if(host)host.scrollTo({top:destination,behavior:'instant'});else window.scrollTo({top:destination,behavior:'instant'});
   restoring=false;save();
  };
  const schedule=()=>{if(restoring&&!frame)frame=requestAnimationFrame(()=>{frame=0;restore();});};
  const scroll=()=>{if(!restoring)save();};
  // User intent wins permanently for this visit, including while reads wait.
  const interact=()=>{restoring=false;save();};
  const keydown=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))interact();};
  const resize=new ResizeObserver(schedule);resize.observe(content);
  const mutation=new MutationObserver(schedule);mutation.observe(content,{subtree:true,attributes:true,attributeFilter:['aria-busy'],childList:true});
  schedule();eventTarget.addEventListener('scroll',scroll);
  window.addEventListener('wheel',interact,{passive:true});window.addEventListener('touchstart',interact,{passive:true});window.addEventListener('keydown',keydown);window.addEventListener('pointerdown',interact);
  return()=>{cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();eventTarget.removeEventListener('scroll',scroll);window.removeEventListener('wheel',interact);window.removeEventListener('touchstart',interact);window.removeEventListener('keydown',keydown);window.removeEventListener('pointerdown',interact);};
 },[key,ready]);
 return {pane,body};
}
