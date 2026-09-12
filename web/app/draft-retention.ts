'use client';
import {useCallback,useLayoutEffect,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {instanceSessionStorage} from './client-storage';
export function readWorkspaceDraft<T>(key:string):T|null {try{const value=instanceSessionStorage.getItem('editor-draft:'+key);return value?JSON.parse(value) as T:null;}catch{return null;}}
function store(key:string,value:unknown){if(value===null)instanceSessionStorage.removeItem('editor-draft:'+key);else instanceSessionStorage.setItem('editor-draft:'+key,JSON.stringify(value));}
// Draft storage is separate from disposable read caches. Saving failure keeps
// the in-memory draft and enables the ordinary navigation guard.
export function useRetainedDraft<T>(key:string):[T|null,Dispatch<SetStateAction<T|null>>,boolean]{
 const [state,setState]=useState<{key:string;value:T|null}>({key:'',value:null}),[retained,setRetained]=useState(false),current=useRef(state);current.current=state;
 useLayoutEffect(()=>{const value=readWorkspaceDraft<T>(key);setState({key,value});setRetained(true);},[key]);
 const set=useCallback<Dispatch<SetStateAction<T|null>>>(update=>{const previous=current.current.key===key?current.current.value:null,value=typeof update==='function'?(update as (v:T|null)=>T|null)(previous):update;try{store(key,value);setRetained(true);}catch{setRetained(false);}current.current={key,value};setState({key,value});},[key]);
 return [state.key===key?state.value:null,set,retained&&state.key===key];
}
export function useWorkspaceDraftRetention(key:string,ready:boolean,dirty:boolean,value:unknown){
 const [retained,setRetained]=useState(false);
 useLayoutEffect(()=>{if(!ready)return;try{store(key,dirty?value:null);setRetained(true);}catch{setRetained(false);}},[key,ready,dirty,value]);
 return retained;
}
