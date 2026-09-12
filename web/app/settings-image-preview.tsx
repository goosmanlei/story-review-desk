'use client';


import {runtimePath} from './runtime-path';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

function ImageDialog({src,label,onClose}:{src:string;label:string;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const element=dialog.current;
    if(!element)return;
    const origin=document.activeElement instanceof HTMLElement?document.activeElement:null;
    element.showModal();
    return()=>{element.close();if(origin?.isConnected)origin.focus({preventScroll:true});};
  },[]);
  return createPortal(<dialog ref={dialog} className="settings-image-dialog" aria-label={label+' · 图片预览'} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}} onClick={event=>{event.stopPropagation();if(event.target===event.currentTarget)onClose();}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Tab'){event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus();}}}>
    <header><strong>{label}</strong><button type="button" autoFocus aria-label="关闭图片预览" onClick={onClose}>×</button></header>
    {failed?<p role="status">此图片暂不可读取，请关闭后重试。</p>:<img src={runtimePath(src)} alt={label} onError={()=>setFailed(true)}/>}
  </dialog>,document.body);
}

/** Image browsing stays in the current page and never changes a media binding. */
export function SettingsImagePreview({src,label,onError}:{src:string;label:string;onError?:()=>void}){
  const [open,setOpen]=useState(false);
  return <><button type="button" className="settings-image-trigger" aria-label={'放大图片：'+label} onClick={()=>setOpen(true)}><img src={runtimePath(src)} alt={label} loading="lazy" decoding="async" onError={onError}/></button>{open&&<ImageDialog src={src} label={label} onClose={()=>setOpen(false)}/>}</>;
}
