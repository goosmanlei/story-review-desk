import net from 'node:net';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';

const MAX_MESSAGE=8*1024*1024;
export const defaultNativeSocket=()=>path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'app-server-control','app-server-control.sock');

// App Server Unix listeners speak WebSocket, not JSONL. The CLI proxy forwards
// bytes unchanged, so sending JSON lines to it never completes HTTP Upgrade.
// Keep this transport dependency-free: project task tools run outside Next.js.
export function nativeSocket({socket=defaultNativeSocket(),timeoutMs=8000,onMessage,onFailure,connect=options=>net.createConnection(options)}={}) {
  if(!path.isAbsolute(socket))throw Error('原生 socket 必须是绝对路径');
  const key=randomBytes(16).toString('base64');
  const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  let buffer=Buffer.alloc(0),upgraded=false,closed=false,fragments=[],fragmentBytes=0,resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
  const stream=connect({path:socket});
  const fail=error=>{if(closed)return;closed=true;clearTimeout(timer);rejectReady(error);stream.destroy();onFailure?.(error);};
  const timer=setTimeout(()=>fail(Error('原生 WebSocket 握手超时')),timeoutMs);
  const frame=(opcode,payload=Buffer.alloc(0))=>{
    if(closed)throw Error('原生连接已关闭');
    if(payload.length>MAX_MESSAGE)throw Error('原生消息超过大小限制');
    const extra=payload.length<126?0:payload.length<=65535?2:8,header=Buffer.alloc(2+extra+4);
    header[0]=0x80|opcode;header[1]=0x80|(extra===0?payload.length:extra===2?126:127);
    if(extra===2)header.writeUInt16BE(payload.length,2);if(extra===8)header.writeBigUInt64BE(BigInt(payload.length),2);
    const mask=randomBytes(4);mask.copy(header,2+extra);const data=Buffer.from(payload);
    for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
    stream.write(Buffer.concat([header,data]));
  };
  const deliver=payload=>{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(payload);
    onMessage?.(JSON.parse(text));
  };
  const consume=()=>{
    if(!upgraded){
      const end=buffer.indexOf('\r\n\r\n');if(end<0){if(buffer.length>16384)throw Error('原生 WebSocket 握手响应过大');return;}
      const lines=buffer.subarray(0,end).toString('ascii').split('\r\n'),headers=new Map(lines.slice(1).map(line=>{const colon=line.indexOf(':');return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()];}));
      if(!/^HTTP\/1\.[01] 101\b/.test(lines[0])||headers.get('sec-websocket-accept')!==accept||headers.get('upgrade')?.toLowerCase()!=='websocket'||!headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade'))throw Error('原生 WebSocket 握手响应无效');
      buffer=buffer.subarray(end+4);upgraded=true;clearTimeout(timer);resolveReady();
    }
    while(buffer.length>=2){
      const first=buffer[0],second=buffer[1],opcode=first&15,fin=!!(first&128);let size=second&127,offset=2;
      if(first&112||second&128)throw Error('原生 WebSocket 帧格式无效');
      if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
      else if(size===127){if(buffer.length<10)return;const big=buffer.readBigUInt64BE(2);if(big>BigInt(MAX_MESSAGE))throw Error('原生消息超过大小限制');size=Number(big);offset=10;}
      if(size>MAX_MESSAGE||fragmentBytes+size>MAX_MESSAGE)throw Error('原生消息超过大小限制');
      if(opcode>=8&&(!fin||size>125))throw Error('原生 WebSocket 控制帧无效');
      if(buffer.length<offset+size)return;
      const payload=buffer.subarray(offset,offset+size);buffer=buffer.subarray(offset+size);
      if(opcode===8){fail(Error('原生 App Server 连接已结束'));return;}
      if(opcode===9){frame(10,payload);continue;}if(opcode===10)continue;
      if(opcode!==0&&opcode!==1)throw Error('原生 App Server 返回了非文本消息');
      if(opcode===0&&!fragments.length||opcode===1&&fragments.length)throw Error('原生 WebSocket 分片顺序无效');
      if(opcode===1&&fin){deliver(payload);continue;}
      fragments.push(payload);fragmentBytes+=size;
      if(fin){const message=Buffer.concat(fragments,fragmentBytes);fragments=[];fragmentBytes=0;deliver(message);}
    }
  };
  stream.on('connect',()=>stream.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  stream.on('data',data=>{if(closed)return;try{buffer=Buffer.concat([buffer,data]);consume();}catch(error){fail(error);}});
  stream.on('error',error=>fail(Error('原生 socket 连接失败：'+error.code)));
  stream.on('end',()=>fail(Error('原生 App Server 连接已结束')));
  stream.on('close',()=>{if(!closed)fail(Error('原生 App Server 连接已结束'));});
  return {socket,ready,async send(message){await ready;if(closed)throw Error('原生连接已关闭');frame(1,Buffer.from(JSON.stringify(message)));},close(){fail(Error('原生连接已关闭'));}};
}
