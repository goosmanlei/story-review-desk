import {GET as readConversations} from '../conversations/route';

// Bounded read-only SSE sessions: reconnecting never resubmits a model request.
// The existing read route supplies exactly the same authentication and redaction.
export async function GET(request:Request){
 const initial=await readConversations(request);if(!initial.ok)return initial;
 const encoder=new TextEncoder();let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 let wake:(()=>void)|undefined;
 const stop=()=>{stopped=true;if(timer)clearTimeout(timer);wake?.();};
 request.signal.addEventListener('abort',stop,{once:true});
 const stream=new ReadableStream<Uint8Array>({
  async start(controller){
   let previous='',response=initial;const deadline=Date.now()+20000;
   try{while(!stopped&&Date.now()<deadline){
    const text=await response.text();if(Buffer.byteLength(text)>2*1024**2)throw Error('Assistant stream frame exceeds bound');
    if(!response.ok){controller.enqueue(encoder.encode('event: error\ndata: '+JSON.stringify({error:'助手运行状态暂不可用，请重新读取。'})+'\n\n'));break;}
    if(text!==previous){controller.enqueue(encoder.encode('data: '+text+'\n\n'));previous=text;}else controller.enqueue(encoder.encode(': heartbeat\n\n'));
    await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000);});wake=undefined;
    if(stopped)break;response=await readConversations(request);
   }}catch{if(!stopped)controller.enqueue(encoder.encode('event: error\ndata: {"error":"助手流已结束，请重新读取。"}\n\n'));}
   finally{request.signal.removeEventListener('abort',stop);if(timer)clearTimeout(timer);if(!stopped)controller.close();}
  },cancel:stop,
 });
 return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store','X-Accel-Buffering':'no','Vary':'Cookie, Authorization'}});
}
