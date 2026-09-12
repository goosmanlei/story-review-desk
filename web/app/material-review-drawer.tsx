'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {announceReviewOverlay} from './review-overlay-host';

/** Native modal top layer, independent from either catalog's scroll container. */
export function MaterialReviewDrawer({open,title,kind,onClose,children}:{open:boolean;title:string;kind:string;onClose:()=>boolean;children:ReactNode}){
 const dialog=useRef<HTMLDialogElement|null>(null),returnFocus=useRef<HTMLElement|null>(null),closeButton=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{
  const element=dialog.current;if(!element)return;
  if(open){returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;element.showModal();}
  else if(element.open)element.close();
  announceReviewOverlay();
  return()=>{
   if(!open)return;
   if(element.open)element.close();
   announceReviewOverlay();
   // Native close restores focus synchronously. A delayed restoration can
   // steal the user's next keyboard target; only fill a missing focus here.
   const previous=returnFocus.current,active=document.activeElement;
   if(previous?.isConnected&&(active===document.body||element.contains(active)))previous.focus({preventScroll:true});
  };
 },[open]);
 useEffect(()=>{if(open)closeButton.current?.focus({preventScroll:true});},[open,title,kind]);
 return <dialog ref={dialog} data-review-overlay-host className="material-review-drawer" data-material-panel={kind} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target!==event.currentTarget)return;const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();}}>
  <header className="material-review-drawer-header"><div><small>{({entity:'实体',state:'状态、发展与方位',material:'素材',relation:'关系'} as Record<string,string>)[kind]||'精确对象'}</small><h2>{title}</h2></div><button ref={closeButton} type="button" autoFocus aria-label="关闭详情" onClick={()=>onClose()}>×</button></header>
  <div className="material-review-drawer-content">{open?children:null}</div>
 </dialog>;
}
