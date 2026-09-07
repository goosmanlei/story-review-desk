'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** Native dialog supplies focus trapping and makes the underlying canvas inert. */
export function SettingsDetailDialog({enabled,children,onRequestClose,label='对象设定详情'}:{enabled:boolean;children:ReactNode;onRequestClose:()=>void;label?:string}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(!enabled)return;const element=dialog.current;if(!element)return;const origin=document.activeElement instanceof HTMLElement?document.activeElement:null;element.showModal();return()=>{element.close();if(origin?.isConnected)origin.focus({preventScroll:true});};},[enabled]);
 if(!enabled)return <>{children}</>;
 if(typeof document==='undefined')return null;
 return createPortal(<dialog ref={dialog} className="settings-detail-dialog" aria-label={label} tabIndex={-1} onCancel={event=>{event.preventDefault();onRequestClose();}} onClick={event=>{if(event.target===event.currentTarget)onRequestClose();}} onKeyDown={event=>{
  if(event.key!=='Tab')return;
  const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')).filter(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden');
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if(!first){event.preventDefault();event.currentTarget.focus();return;}
  if(event.shiftKey&&(active===first||!controls.includes(active as HTMLElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(active===last||!controls.includes(active as HTMLElement))){event.preventDefault();first.focus();}
 }}>{children}</dialog>,document.body);
}
