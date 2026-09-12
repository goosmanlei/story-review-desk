import {transaction} from '../db.mjs';
import {hash} from '../shared/contracts.mjs';
import {conversationList} from './conversations.mjs';

export async function conversationEvents(pool,request,params){
  // The database transaction ends before any socket wait. Heartbeats only write
  // to this response stream; they create no business revisions or operations.
  const initial=await transaction(pool,tx=>conversationList(tx,params),{readOnly:true}),abort=new AbortController();
  request.signal.addEventListener('abort',()=>abort.abort(),{once:true});
  const encoder=new TextEncoder();
  const wait=()=>new Promise(resolve=>{const finish=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',finish);resolve();},timer=setTimeout(finish,2000);abort.signal.addEventListener('abort',finish,{once:true});});
  return new Response(new ReadableStream({
    async start(controller){
      let signature=hash(initial);
      try{
        controller.enqueue(encoder.encode('data: '+JSON.stringify(initial)+'\n\n'));
        for(let i=0;i<15&&!abort.signal.aborted;i++){
          await wait();if(abort.signal.aborted)break;
          const value=await transaction(pool,tx=>conversationList(tx,params),{readOnly:true}),next=hash(value);
          if(next!==signature){controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));signature=next;}
          else controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
        if(!abort.signal.aborted)controller.close();
      }catch(error){if(!abort.signal.aborted){controller.enqueue(encoder.encode('event: error\ndata: '+JSON.stringify({error:error.message})+'\n\n'));controller.close();}}
    },cancel(){abort.abort();}
  }),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
}
