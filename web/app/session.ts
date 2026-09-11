'use client';
import {useEffect,useState} from 'react';
export function useSession<T>(key:string,initial:T):[T,(value:T|((previous:T)=>T))=>void]{
  const [value,setValue]=useState(initial);
  useEffect(()=>{try{const stored=sessionStorage.getItem(key);setValue(stored?JSON.parse(stored):initial);}catch{}},[key]);
  return [value,next=>setValue(previous=>{const result=typeof next==='function'?(next as (p:T)=>T)(previous):next;try{sessionStorage.setItem(key,JSON.stringify(result));}catch{}return result;})];
}
export const readingPositions=new Map<string,number>();
export function rememberPosition(key:string,value:number){readingPositions.delete(key);readingPositions.set(key,value);if(readingPositions.size>1000)readingPositions.delete(readingPositions.keys().next().value!);}
