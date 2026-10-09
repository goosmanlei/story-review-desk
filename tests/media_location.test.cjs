const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Node {
 constructor(tag,cls){this.tagName=tag;this.className=cls;this.children=[];this.dataset={};this.style={};this.attributes={};this.isConnected=true;this.paused=true;this.currentTime=0;this.classList={add(){},toggle(){}}}
 append(...nodes){this.children.push(...nodes)}setAttribute(k,v){this.attributes[k]=v}addEventListener(){}focus(){this.focused=true}scrollIntoView(){this.scrolled=true}pause(){this.paused=true}get lastElementChild(){return this.children.at(-1)}
 all(){return this.children.flatMap(c=>[c,...c.all()])}
}
function fixture(){
 const ctx={state:{comments:[]},window:{addEventListener(){}},document:{createElementNS:(_ns,tag)=>new Node(tag)},el:(tag,cls)=>new Node(tag,cls),reviewURL:v=>v};
 ctx.nodeText=(tag,cls,value,parent)=>{const n=new Node(tag,cls);n.textContent=value;parent?.append(n);return n};
 ctx.productionButton=(parent,label,action)=>{const n=ctx.nodeText('button',null,label,parent);n.onclick=action;return n};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/review-ui.js'),'utf8'),ctx);ctx.reviewWaveform=()=>new Promise(()=>{});
 const component={id:'original',file:'original.wav',mime:'audio/wav',duration_seconds:10},parent=new Node('main');
 const player=ctx.reviewMediaPlayer(parent,component,{id:'exact-r1'}, {}, false),media=player.children[0];
 const anchor={type:'time',component_id:'original',asset_file:'original.wav',start_seconds:1,end_seconds:2};
 return {ctx,player,media,anchor};
}
test('late metadata retains the newest located range and never resumes playback',()=>{
 const f=fixture();f.media.paused=false;assert.equal(f.player.reviewLocate(f.anchor),true);
 const newer={...f.anchor,start_seconds:3,end_seconds:4};f.player.reviewLocate(newer);f.media.currentTime=0;f.media.duration=10;f.media.onloadedmetadata();
 assert.equal(f.media.currentTime,3);assert.equal(f.media.paused,true);const fields=f.player.all().filter(n=>n.tagName==='input');assert.equal(fields[0].value,'3.00');assert.equal(fields[1].value,'4.00');
});
test('closed player ignores late metadata and refuses to take focus again',()=>{
 const f=fixture();f.player.reviewLocate(f.anchor);f.player.isConnected=false;f.media.currentTime=0;f.media.duration=10;f.media.onloadedmetadata();
 assert.equal(f.media.currentTime,0);assert.equal(f.player.reviewLocate({...f.anchor,start_seconds:3,end_seconds:4}),false);
});
for(const patch of [{component_id:'preview'},{asset_file:'preview.mp3'},{end_seconds:11}])test('same-duration substitute or out-of-range anchor is refused '+JSON.stringify(patch),()=>{
 const f=fixture();assert.equal(f.player.reviewLocate({...f.anchor,...patch}),false);assert.equal(f.media.currentTime,0);assert.equal(f.player.scrolled,undefined);
});
test('a file read failure stays visible and does not advertise playback',()=>{
 const f=fixture();f.media.onerror();const status=f.player.all().find(n=>n.className==='review-wave-status'),play=f.player.all().find(n=>n.tagName==='button'&&n.textContent==='播放');
 assert.equal(status.hidden,false);assert.match(status.textContent,/原文件读取失败/);assert.equal(play.disabled,true);
});
