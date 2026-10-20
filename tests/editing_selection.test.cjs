const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class E{
 constructor(tag,cls=''){cls||='';Object.assign(this,{tag,className:cls,children:[],dataset:{},attrs:{},listeners:{},value:'',isConnected:true,paused:true,scrollLeft:0,clientWidth:912,style:{setProperty(){}}});const classes=new Set(cls.split(' '));this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x),contains:x=>classes.has(x)};}
 append(...n){this.children.push(...n)}replaceChildren(...n){this.children=n}setAttribute(k,v){this.attrs[k]=String(v)}removeAttribute(k){delete this.attrs[k]}getAttribute(k){return this.attrs[k]??null}
 all(){return [this,...this.children.flatMap(n=>n.all())]}querySelectorAll(s){return this.all().filter(n=>s==='button'?n.tag==='button':false)}querySelector(s){return this.all().find(n=>s==='video'?n.tag==='video':false)}
 addEventListener(k,fn){this.listeners[k]=fn}pause(){this.paused=true}play(){this.paused=false;return Promise.resolve()}getBoundingClientRect(){return {left:0,right:912,top:0,bottom:60}}hasPointerCapture(){return false}setPointerCapture(){}closest(){return null}
}
function fixture({tracks=true}={}){
 const host=new E('div'),frames=[],listeners={};const p={spec:{fps:{num:24,den:1},duration_frames:1000},episode:{object_id:'episode'},clips:[]};
 const output={object_id:'film',id:'revision',payload:{project:p,components:[{id:'subtitled',file:'film.mp4'}]}};
 const ctx={epoch:0,readEpoch:0,host,episode:'episode',output:'film',variant:'subtitled',views:{},data:{episodes:[],outputs:[output]},review:{tracks:tracks?[{key:'picture',title:'画面'},{key:'audio',title:'声音'},{key:'text',title:'字幕'}]:[],elements:[{track_key:'picture',element_type:'clip',element_id:'one',start_frame:0,end_frame:1000}]}};
 const c={AbortController,URL,location:{href:'http://fixture/',pathname:'/'},history:{replaceState(){}},state:{workspace:'settings.workspace'},productionReadEpoch:0,productionTab:()=> 'editing',document:{addEventListener:(k,fn)=>listeners[k]=fn},window:{addEventListener(){}},el:(t,cls)=>new E(t,cls),nodeText:(t,cls,text,parent)=>{const n=new E(t,cls);n.textContent=text;parent?.append(n);return n},productionTabs(){},focusProductionReview(){},reviewURL:x=>x,reviewVariantURL:x=>x,reviewRefreshMedia(){},reviewSurface(){},renderComments(){},requestAnimationFrame:fn=>{frames.push(fn);return frames.length},cancelAnimationFrame(){},localStorage:{setItem(){}},clearTimeout(){},setTimeout(){},toast(){},startDraft:a=>c.anchor=a};
 c.productionButton=(parent,text,fn)=>{const n=c.nodeText('button','',text,parent);n.onclick=fn;return n};vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/editing.js','utf8'),c);vm.runInContext('editChoices=()=>{}',c);c.renderEpisodeEditing(ctx);frames.shift()();
 const byText=t=>host.all().find(n=>n.textContent===t),input=t=>host.all().find(n=>n.tag==='input'&&n.attrs['aria-label']===t),click=n=>n.onclick({stopPropagation(){}});
 return {c,ctx,p,output,host,byText,input,click,listeners,frames};
}
test('selection mode gates actions, preserves data, clears completely, and keeps history separate',async()=>{
 const f=fixture(),{ctx,input,byText,click,c,host}=f,select=byText('选择'),track=byText('画面'),loop=byText('循环选段'),comment=byText('评论此范围');
 assert.equal(input('范围起帧').value,'');assert.equal(input('范围起帧').disabled,true);assert.equal(comment.disabled,true);click(track);assert.deepEqual([...ctx.views.revision.range.tracks],[]);
 click(select);assert.equal(input('范围起帧').disabled,false);assert.equal(loop.disabled,true);click(track);for(const [label,value] of [['范围起帧','492'],['范围止帧','714']]){const i=input(label);i.value=value;i.oninput()}
 assert.equal(input('起点时间').value,'0:20.500');assert.equal(input('终点时间').value,'0:29.750');assert.equal(comment.disabled,false);
 click(byText('字幕'));assert.deepEqual([...ctx.views.revision.range.tracks],['picture','text']);assert.equal(ctx.views.revision.range.start,492);
 await click(loop);assert.equal(ctx.loop,true);const before=JSON.stringify(ctx.views.revision.range);click(select);assert.equal(ctx.loop,false);assert.equal(comment.disabled,true);assert.equal(track.attrs.role,undefined);assert.equal(host.all().filter(n=>n.classList.contains('edit-range-shade')&&!n.hidden).length,0);
 click(select);assert.equal(JSON.stringify(ctx.views.revision.range),before);assert.equal(ctx.loop,false);assert.equal(track.attrs['aria-pressed'],'true');click(select);
 const player=host.all().find(n=>n.className.includes('edit-player'));assert.equal(player.reviewLocate({asset_file:'film.mp4',edit_selection:{start_frame:10,end_frame:20,tracks:['picture']}}),true);assert.equal(JSON.stringify(ctx.views.revision.range),before);assert.equal(ctx.selecting,false);assert.equal(ctx.views.revision.frame,10);
 click(select);click(comment);assert.equal(c.anchor.edit_selection.start_frame,492);click(byText('清除选择'));assert.equal(ctx.selecting,true);assert.equal(input('范围起帧').value,'');assert.deepEqual([...ctx.views.revision.range.tracks],[]);assert.equal(loop.disabled,true);
});
test('invalid input recovery and Escape respect editor priority; empty timelines disable entry',()=>{
 const f=fixture(),{input,click,byText,ctx,listeners}=f;click(byText('选择'));click(byText('画面'));for(const [label,value] of [['范围起帧','bad'],['范围止帧','714']]){const i=input(label);i.value=value;i.oninput()}assert.equal(byText('评论此范围').disabled,true);
 const i=input('范围起帧');i.value='492';i.oninput();assert.equal(byText('评论此范围').disabled,false);
 listeners.keydown({key:'Escape',target:{closest:()=>true}});assert.equal(ctx.selecting,true);
 listeners.keydown({key:'Escape',target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});assert.equal(ctx.selecting,false);assert.equal(i.value,'492');
 assert.equal(fixture({tracks:false}).byText('选择').disabled,true);
});
test('Escape cancels an unfinished drag before exiting; ruler rebuild retains the corner',()=>{
 const {host,byText,click,ctx,listeners,frames}=fixture();click(byText('选择'));const timeline=host.all().find(n=>n.className==='edit-timeline'),row=host.all().find(n=>n.className==='edit-track'),ruler=host.all().find(n=>n.className==='edit-ruler');
 const target={closest:s=>s==='.edit-track'?row:null};const before=JSON.stringify(ctx.views.revision.range);
 timeline.onpointerdown({button:0,clientX:200,clientY:10,pointerId:1,target,preventDefault(){}});timeline.onpointermove({clientX:600,clientY:50,pointerId:1,preventDefault(){}});frames.shift()();assert.notEqual(JSON.stringify(ctx.views.revision.range),before);
 listeners.keydown({key:'Escape',target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});assert.equal(JSON.stringify(ctx.views.revision.range),before);assert.equal(ctx.selecting,true);assert.equal(ruler.children[0].className,'edit-selection-corner');
 const name=byText('画面');timeline.onpointerdown({button:0,clientX:20,target:{closest:()=>name}});timeline.listeners.click({target:{closest:s=>s==='.edit-track'?row:s==='.edit-track-name'?name:null},preventDefault(){throw Error('track name must receive click')},stopPropagation(){}});
});
