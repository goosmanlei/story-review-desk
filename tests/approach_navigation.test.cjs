const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../review_desk/static/approach.js'),'utf8');
function fixture({narrow=false,focused=false}={}){
  const frames=[],listeners={},values=new Map();let moves=0,top=0;
  const target={id:'approach-story-route',classList:{contains:()=>true},getBoundingClientRect:()=>({top}),scrollIntoView(){moves++;top=narrow?200:90}};
  const link={hash:'#approach-story-route',classList:{contains:()=>false,toggle(){}},setAttribute(){},removeAttribute(){},getBoundingClientRect:()=>({top:0,bottom:40,left:500,right:600})};
  const index={scrollLeft:0,scrollTop:0,contains:x=>x===index||(focused&&x==='focus'),querySelectorAll:()=>[link],getBoundingClientRect:()=>({top:0,bottom:60,left:0,right:200})};
  const host={querySelectorAll:()=>[target],contains:x=>x===target,style:{setProperty:(k,v)=>values.set(k,v),getPropertyValue:k=>values.get(k)}};
  const nodes={'#approach-view':{hidden:false},'#approach-body':host,'#approach-index':index,'#approach-sidebar':{getBoundingClientRect:()=>({height:58})},'.workspace-topbar':{getBoundingClientRect:()=>({bottom:narrow?122:70})}};
  const context={$:s=>nodes[s],location:{href:'http://isolated/?workspace=production.approach&tab=story#approach-story-route',hash:'#approach-story-route'},getComputedStyle:x=>x===index?{display:narrow?'flex':'block'}:{top:'122'},requestAnimationFrame:fn=>{frames.push(fn);return frames.length},document:{activeElement:focused?'focus':null,scrollingElement:{scrollTop:0,scrollHeight:10000},getElementById:()=>target,addEventListener:(e,fn)=>listeners[e]=fn},window:{innerHeight:844,addEventListener(){}},parseFloat};
  vm.createContext(context);vm.runInContext(script,context);
  const flush=()=>{let count=0;while(frames.length){assert.ok(++count<10);const f=frames.splice(0);f.forEach(fn=>fn())}};
  return {context,index,listeners,frames,flush,setTop:v=>top=v,moves:()=>moves};
}
test('horizontal directory is never pulled back while finding a link',()=>{const f=fixture({narrow:true});f.context.syncApproachIndex();assert.equal(f.index.scrollLeft,0)});
test('focused desktop directory is not moved by active reading updates',()=>{const f=fixture({focused:true});f.context.syncApproachIndex();assert.equal(f.index.scrollLeft,0)});
test('directory scrolling does not trigger reading progress calculation',()=>{const f=fixture();f.listeners.scroll({target:f.index});assert.equal(f.frames.length,0);f.listeners.scroll({target:{}});assert.equal(f.frames.length,1)});
test('partially covered anchor is rescued after scroll restoration',()=>{const f=fixture();f.context.restoreApproachAnchor();assert.equal(f.moves(),1);f.setTop(55);f.flush();assert.equal(f.moves(),2)});
test('deep saved reading position and a different route are preserved',()=>{const f=fixture();f.context.restoreApproachAnchor();f.setTop(-500);f.flush();assert.equal(f.moves(),1);f.context.restoreApproachAnchor();f.setTop(55);f.context.location.href='http://isolated/?workspace=story.sources';f.flush();assert.equal(f.moves(),2)});
