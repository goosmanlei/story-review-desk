'use client';

import {type ReactNode} from 'react';
import {runtimePath} from './runtime-path';
export {runtimePath} from './runtime-path';

const BUILD_BASE_PATH = process.env.NEXT_PUBLIC_REVIEW_BASE_PATH || '';
type Binding = {deploymentId:string;runtimeEpoch:string;basePath:string};
let binding:Binding|null=null;
let installed=false;

export function configureRuntimeBinding(value:Binding){
  if(value.basePath!==BUILD_BASE_PATH)throw Error('页面构建路径与当前部署不一致，请重新发布。');
  binding=Object.freeze({...value});
}

function install(){
  if(installed||typeof window==='undefined')return;installed=true;
  const nativeFetch=window.fetch.bind(window);
  window.fetch=(input:RequestInfo|URL,init?:RequestInit)=>{
    let target:RequestInfo|URL=input;
    const url=new URL(input instanceof Request?input.url:String(input),window.location.href);
    const owned=url.origin===window.location.origin;
    if(owned){
      url.pathname=runtimePath(url.pathname);
      target=input instanceof Request?new Request(url,input):url;
    }
    const method=String(init?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    if(owned&&binding&&!['GET','HEAD','OPTIONS'].includes(method)){
      const headers=new Headers(input instanceof Request?input.headers:undefined);
      new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
      headers.set('X-Review-Deployment-Id',binding.deploymentId);
      headers.set('X-Review-Runtime-Epoch',binding.runtimeEpoch);
      headers.set('X-Review-Runtime',binding.runtimeEpoch);
      init={...init,headers};
    }
    return nativeFetch(target,init).then(response=>{
      if(owned&&response.status===409&&response.headers.get('x-review-runtime-changed')==='1')window.dispatchEvent(new Event('review:runtime-changed'));
      return response;
    });
  };
}

export function RuntimeRequestBoundary({children}:{children:ReactNode}){install();return children;}
