// One cache budget per process. TTL measures idle time, not the age of a busy entry.
export class BoundedCache {
  constructor({maxBytes=24*1024*1024,idleMs=300000,now=Date.now}={}){this.maxBytes=maxBytes;this.idleMs=idleMs;this.now=now;this.bytes=0;this.entries=new Map();}
  delete(key){const e=this.entries.get(key);if(e){this.bytes-=e.bytes;this.entries.delete(key);}}
  sweep(){const now=this.now();for(const [key,e] of this.entries)if(now-e.usedAt>=this.idleMs)this.delete(key);}
  get(key){this.sweep();const e=this.entries.get(key);if(!e)return undefined;e.usedAt=this.now();this.entries.delete(key);this.entries.set(key,e);return e.value;}
  set(key,value){this.delete(key);this.sweep();const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;if(bytes>this.maxBytes)return value;while(this.bytes+bytes>this.maxBytes)this.delete(this.entries.keys().next().value);this.entries.set(key,{value,bytes,usedAt:this.now()});this.bytes+=bytes;return value;}
  clear(){this.entries.clear();this.bytes=0;}
}
