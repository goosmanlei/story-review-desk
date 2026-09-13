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
    if(key==='reading'&&typeof item==='number'&&Number.isFinite(item)&&item>=0)result.reading[id]=item;
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
  readPosition:(key:string)=>memory.current.reading[key]||0,
  savePosition:(key:string,value:number)=>{memory.current.reading[key]=value;save();}};
}

export function usePreparationReading(key:string,ready:boolean,navigation:ReturnType<typeof usePreparationNavigation>){
 const pane=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null),latest=useRef(navigation);latest.current=navigation;
 useLayoutEffect(()=>{
  const element=pane.current,content=body.current;if(!ready||!element||!content)return;
  let target=latest.current.readPosition(key),restoring=true;
  const restore=()=>{if(!restoring)return;element.scrollTop=target;if(Math.abs(element.scrollTop-target)<1)restoring=false;};
  const scroll=()=>{if(!restoring)latest.current.savePosition(key,element.scrollTop);};
  const interact=()=>{restoring=false;latest.current.savePosition(key,element.scrollTop);};
  restore();const observer=new ResizeObserver(restore);observer.observe(content);
  element.addEventListener('scroll',scroll);element.addEventListener('wheel',interact,{passive:true});element.addEventListener('touchstart',interact,{passive:true});element.addEventListener('keydown',interact);element.addEventListener('pointerdown',interact);
  return()=>{observer.disconnect();element.removeEventListener('scroll',scroll);element.removeEventListener('wheel',interact);element.removeEventListener('touchstart',interact);element.removeEventListener('keydown',interact);element.removeEventListener('pointerdown',interact);};
 },[key,ready]);
 return {pane,body};
}
