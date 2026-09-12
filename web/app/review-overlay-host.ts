'use client';
import {useEffect,useState} from 'react';
export function announceReviewOverlay(){window.dispatchEvent(new Event('review:overlay-host'));}
// Keep the global assistant reachable while a native detail dialog makes the
// background inert. Modal ownership changes, not polling, select the host.
export function useReviewOverlayHost(){
 const [host,setHost]=useState<HTMLElement|null>(null);
 useEffect(()=>{const sync=()=>setHost(Array.from(document.querySelectorAll<HTMLElement>('dialog[data-review-overlay-host][open]')).at(-1)||document.body);sync();window.addEventListener('review:overlay-host',sync);return()=>window.removeEventListener('review:overlay-host',sync);},[]);
 return host;
}
