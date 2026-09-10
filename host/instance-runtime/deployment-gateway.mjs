import http from 'node:http';
import {isIP} from 'node:net';
import {trustedRequestIdentity,assertBrowserRuntimeBinding} from './deployment-http.mjs';

export function createDeploymentGateway({upstreamPort,proxyIp,secret,basePath,runtimeEpoch,maintenance=()=>false}){
 if(!isIP(proxyIp)||!secret||!runtimeEpoch)throw Error('Gateway requires an exact inspected proxy IP, private secret and restored runtime epoch');
 const normalize=ip=>ip?.replace(/^::ffff:/,'');
 let activeRequests=0;
 const server=http.createServer((request,response)=>{
  const fail=(code,message,changed=false)=>{response.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...(changed?{'X-Review-Runtime-Changed':'1'}:{})});response.end(JSON.stringify({error:message}));};
  // Health is container-loopback only and contains no business data. Nginx
  // preserves the prefix, so it cannot route this private path from the site.
  if(request.url==='/__review_health'&&['127.0.0.1','::1'].includes(normalize(request.socket.remoteAddress))){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({status:'GATEWAY_READY',runtimeEpoch,basePath,maintenance:maintenance(),activeRequests}));return;}
  if(normalize(request.socket.remoteAddress)!==normalize(proxyIp))return fail(403,'Untrusted ingress connection');
  if(!request.url?.startsWith(basePath+'/')&&request.url!==basePath)return fail(404,'Outside configured base path');
  // Drop the caller's gateway proof. Generate it only after the socket check.
  const headers={...request.headers,'x-review-internal-gateway':secret};
  delete headers.forwarded;delete headers['x-original-url'];delete headers['x-rewrite-url'];
  let browser;
  try{
   browser=new Request(process.env.REVIEW_PUBLIC_URL,{method:request.method,headers});
   const identity=trustedRequestIdentity(browser);
   if(!['GET','HEAD','OPTIONS'].includes(request.method)){
    if(browser.headers.get('origin')!==identity.origin)return fail(403,'Mutation origin is not allowed');
    try{assertBrowserRuntimeBinding(browser,runtimeEpoch);}catch{return fail(409,'Browser deployment changed; reload before writing',true);}
   }
  }catch{return fail(403,'Untrusted authenticated proxy headers');}
  if(maintenance())return fail(503,'审阅台维护中，请在发布完成后刷新。');
  if(request.url===basePath){response.writeHead(308,{Location:basePath+'/','Cache-Control':'no-store'});response.end();return;}
  activeRequests++;let settled=false;const finish=()=>{if(!settled){settled=true;activeRequests--;}};
  const upstream=http.request({host:'127.0.0.1',port:upstreamPort,path:request.url,method:request.method,headers},reply=>{
   const outgoing={...reply.headers};delete outgoing['x-review-internal-gateway'];
   response.writeHead(reply.statusCode||502,outgoing);reply.pipe(response);
   response.on('close',()=>reply.destroy());
  });
  upstream.on('error',()=>{if(!response.headersSent)fail(503,'Runtime is not ready');else response.destroy();});
  upstream.on('close',finish);
  request.on('aborted',()=>upstream.destroy());request.pipe(upstream);
 });
 // No websocket bypass: assistants use streamed HTTP responses.
 server.on('upgrade',(_request,socket)=>socket.destroy());
 return server;
}
