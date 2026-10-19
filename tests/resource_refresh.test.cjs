const {test}=require('node:test'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8');
class Element {
 constructor(tag,cls){this.tagName=tag;this.className=cls;this.children=[];this.dataset={};this.style={};this.attributes={};this.isConnected=true;this.paused=true;this.currentTime=0;this.duration=10;this.classList={add(){},toggle(){}};this.events=new Map();this.handlers=new Map();for(const name of ['loadedmetadata','ended','timeupdate','play','pause','ratechange','seeked','error'])Object.defineProperty(this,'on'+name,{set:callback=>{const old=this.handlers.get(name);if(old)this.events.set(name,this.events.get(name).filter(x=>x!==old));const row={callback};this.handlers.set(name,row);const list=this.events.get(name)||[];list.push(row);this.events.set(name,list)},get:()=>this.handlers.get(name)?.callback});}
 append(...nodes){this.children.push(...nodes)} setAttribute(k,v){this.attributes[k]=v} addEventListener(name,callback,options={}){const list=this.events.get(name)||[];list.push({callback,once:options.once});this.events.set(name,list)}
 dispatch(name){for(const row of [...(this.events.get(name)||[])]){row.callback({type:name,target:this});if(row.once)this.events.set(name,this.events.get(name).filter(x=>x!==row))}}
 focus(){}scrollIntoView(){}pause(){const changed=!this.paused;this.paused=true;if(changed)this.dispatch('pause')}play(){this.paused=false;this.playCalls=(this.playCalls||0)+1;this.dispatch('play');return Promise.resolve()}load(){this.loadCalls=(this.loadCalls||0)+1;this.error=null;this.currentTime=0;this.paused=true}get lastElementChild(){return this.children.at(-1)}all(){return this.children.flatMap(c=>[c,...c.all()])}
}
function fixture(){const ctx={state:{comments:[]},window:{addEventListener(){}},document:{createElementNS:(_ns,tag)=>new Element(tag)},el:(tag,cls)=>new Element(tag,cls),reviewURL:v=>'https://review.example'+v,URL,location:{href:'https://review.example/'},Date};ctx.setTimeout=fn=>{ctx.timer=fn;return 1};ctx.clearTimeout=()=>{ctx.timer=null};ctx.nodeText=(tag,cls,value,parent)=>{const n=new Element(tag,cls);n.textContent=value;parent?.append(n);return n};ctx.productionButton=(parent,label,action)=>{const n=ctx.nodeText('button',null,label,parent);n.onclick=action;return n};vm.createContext(ctx);vm.runInContext(source,ctx);ctx.reviewWaveform=()=>new Promise(()=>{});const player=ctx.reviewMediaPlayer(new Element('main'),{id:'original',file:'original.wav',mime:'audio/wav',duration_seconds:10},{id:'exact-r1'}, {},false);return {ctx,player,media:player.children[0]};}

function begin(){const f=fixture();f.media.dispatch('loadedmetadata');f.player.reviewLocate({type:'time',component_id:'original',asset_file:'original.wav',start_seconds:1,end_seconds:2});f.media.currentTime=4;f.media.dispatch('timeupdate');f.media.play();f.media.error={code:2};f.media.dispatch('error');return f}
function state(f){const play=f.player.all().find(n=>n.tagName==='button'&&['播放','暂停'].includes(n.textContent));const status=f.player.all().find(n=>n.className==='review-wave-status');return {time:f.media.currentTime,paused:f.media.paused,playCalls:f.media.playCalls,playDisabled:!!play?.disabled,selection:f.player.all().filter(n=>n.tagName==='input').map(n=>n.value),reviewSeek:f.media.dataset.reviewSeek,status:status.textContent,isConnected:f.media.isConnected}}
function check(name,action,expected){test(name,()=>{const actual=action();for(const key of Object.keys(expected))assert.deepEqual(actual[key],expected[key],key)})}
check('refresh-clears-failure-state',()=>{const f=begin();f.media.dispatch('loadedmetadata');const snapshot=state(f);snapshot.auditionAccepted=f.player.reviewAudition({start_seconds:1,end_seconds:2});return snapshot},{time:4,paused:false,playDisabled:false,selection:['1.00','2.00'],auditionAccepted:true});
check('late-metadata-after-detach',()=>{const f=begin();f.media.pause();f.player.isConnected=false;f.media.isConnected=false;f.media.dispatch('loadedmetadata');return state(f)},{paused:true,playCalls:1,isConnected:false});
check('reviewPause-during-refresh',()=>{const f=begin();f.player.reviewPause();f.media.dispatch('loadedmetadata');return state(f)},{time:4,paused:true,playCalls:1,playDisabled:false,selection:['1.00','2.00']});
check('new-comment-location-during-refresh',()=>{const f=begin();assert.equal(f.player.reviewLocate({type:'time',component_id:'original',asset_file:'original.wav',start_seconds:6,end_seconds:7}),true);assert.equal(f.media.currentTime,6);assert.equal(f.media.dataset.reviewSeek,'6');f.media.dispatch('loadedmetadata');return state(f)},{time:6,paused:true,playCalls:1,playDisabled:false,selection:['6.00','7.00'],reviewSeek:'6'});

function stalledPlayer(paused=false){
 const f=fixture(),timers=new Map();let sequence=0;
 f.ctx.setTimeout=(callback,delay)=>{timers.set(++sequence,{callback,delay});return sequence};f.ctx.clearTimeout=id=>timers.delete(id);f.timers=timers;
 f.expire=()=>{for(const [id,row] of [...timers])if(row.delay===8000){timers.delete(id);row.callback()}};
 f.media.dispatch('loadedmetadata');if(!paused)f.media.play();f.media.currentTime=4;f.media.readyState=4;f.media.dispatch('timeupdate');
 f.media.currentTime=8;f.media.seeking=true;f.media.readyState=1;f.media.dispatch('seeking');return f;
}
for(const paused of [false,true])test(`expired seek preserves target and ${paused?'paused':'playing'} state without a media error`,()=>{
 const f=stalledPlayer(paused);f.media.dispatch('waiting');f.media.dispatch('stalled');assert.equal(f.timers.size,1);assert.equal(f.media.error,undefined);
 f.expire();assert.equal(f.media.loadCalls,1);assert.equal(f.media.reviewRefreshing,true);assert.equal(f.media.dataset.reviewSeek,'8');
 f.media.dispatch('timeupdate');f.media.seeking=false;f.media.readyState=4;f.media.dispatch('loadedmetadata');assert.equal(f.media.currentTime,8);assert.equal(f.media.paused,paused);assert.equal(f.media.reviewRefreshing,false);
 f.media.error={code:2};f.media.dispatch('error');f.media.dispatch('waiting');f.expire();assert.equal(f.media.loadCalls,1);
});
test('ordinary buffering progress cancels the deadline but identical timeupdate does not',()=>{
 const f=stalledPlayer();f.media.dispatch('timeupdate');assert.equal(f.timers.size,1);
 f.media.seeking=false;f.media.readyState=4;f.media.currentTime=8.2;f.media.dispatch('timeupdate');assert.equal(f.timers.size,0);f.expire();assert.equal(f.media.loadCalls,undefined);
});
for(const event of ['playing','canplay','ended'])test(`${event} cancels the stall deadline`,()=>{const f=stalledPlayer();f.media.dispatch(event);assert.equal(f.timers.size,0);f.expire();assert.equal(f.media.loadCalls,undefined)});
for(const change of ['detach','source','pause'])test(`${change} prevents a stale stall refresh`,()=>{
 const f=stalledPlayer();if(change==='detach')f.media.isConnected=false;else if(change==='source')f.media.src='https://review.example/another';else{f.media.seeking=false;f.media.pause()}
 f.expire();assert.equal(f.media.loadCalls,undefined);
});
test('a newer stalled seek wins and explicit pause during refresh prevents resumption',()=>{
 const f=stalledPlayer();f.media.currentTime=9;f.media.dispatch('seeking');assert.equal(f.timers.size,1);f.expire();f.player.reviewPause();f.media.dispatch('loadedmetadata');assert.equal(f.media.currentTime,9);assert.equal(f.media.paused,true);
});
test('a paused seek with a decoded current frame does not need future frames or a refresh',()=>{
 const f=stalledPlayer(true);f.media.seeking=false;f.media.readyState=2;f.media.dispatch('seeked');assert.equal(f.timers.size,0);f.expire();assert.equal(f.media.loadCalls,undefined);
});
