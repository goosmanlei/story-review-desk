const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Exercise the real chapter intent across delayed layout changes; browser
// acceptance separately verifies actual image loading and scroll containers.
function fixture(){
 const frames=[],events={},images=[{complete:false},{complete:false}],scrolls=[];
 const header={getBoundingClientRect:()=>({height:100})},sections=[];
 const reader={scrollTop:0,clientHeight:700,scrollHeight:9000,dataset:{readingRevision:'r1'},contains:n=>sections.includes(n),querySelector:()=>header,querySelectorAll:s=>s==='img'?images:sections,getBoundingClientRect:()=>({top:180}),scrollTo(value){this.scrollTop=value.top;scrolls.push(value)}};
 const section=offset=>{const s={offset,getBoundingClientRect:()=>({top:180+s.offset-reader.scrollTop})};sections.push(s);return s};
 const ctx={state:{workspace:'story.outline',structureRevision:'r1',anchor:null,selected:null},isStructure:()=>ctx.state.workspace==='story.outline',$:s=>s==='#structure-reader'?reader:null,requestAnimationFrame:fn=>{frames.push(fn);return frames.length},document:{addEventListener:(type,fn)=>(events[type]??=[]).push(fn)},window:{addEventListener(){}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8'),ctx);ctx.syncStructureIndex=()=>{};
 const flush=()=>{const pending=frames.splice(0);for(const fn of pending)fn()},emit=(type,event={})=>{for(const fn of events[type]||[])fn({target:{closest:()=>null},...event})};
 return {ctx,reader,section,images,scrolls,flush,emit};
}
test('a chapter remains at its exact heading as delayed images expand the manuscript',()=>{
 const f=fixture(),chapter=f.section(3000);f.ctx.scrollStructureSection(chapter);assert.equal(f.reader.scrollTop,2880);f.flush();
 chapter.offset=4800;f.images[0].complete=true;f.ctx.scheduleStructureIndex();f.flush();assert.equal(f.reader.scrollTop,4680);
 chapter.offset=6200;f.images[1].complete=true;f.ctx.scheduleStructureIndex();f.flush();assert.equal(f.reader.scrollTop,6080);
 f.reader.scrollTop=400;f.ctx.scheduleStructureIndex();f.flush();assert.equal(f.reader.scrollTop,400);
 assert.ok(f.scrolls.every(s=>s.behavior==='instant'));
});
test('manual reading input cancels a pending image correction',()=>{
 for(const [type,event] of [['wheel',{}],['pointerdown',{}],['touchstart',{}],['keydown',{key:'PageDown'}]]){
  const f=fixture(),chapter=f.section(3000);f.ctx.scrollStructureSection(chapter);f.flush();f.emit(type,event);f.reader.scrollTop=1500;chapter.offset=6000;f.ctx.scheduleStructureIndex();f.flush();assert.equal(f.reader.scrollTop,1500,type);
 }
});
test('new chapter selection wins and old revision or comment focus cancels pending correction',()=>{
 const f=fixture(),a=f.section(3000),b=f.section(6000);f.ctx.scrollStructureSection(a);f.ctx.scrollStructureSection(b);f.flush();assert.equal(f.reader.scrollTop,5880);
 for(const change of [()=>{f.ctx.state.structureRevision='r2'},()=>{f.ctx.state.anchor={type:'global'}},()=>{f.ctx.state.selected='comment'},()=>{f.ctx.state.workspace='story.sources'}]){
  Object.assign(f.ctx.state,{workspace:'story.outline',structureRevision:'r1',anchor:null,selected:null});f.ctx.scrollStructureSection(b);f.flush();change();f.reader.scrollTop=700;b.offset+=1000;f.ctx.scheduleStructureIndex();f.flush();assert.equal(f.reader.scrollTop,700);
 }
});
test('current version is revealed horizontally without moving the reader or its page',()=>{
 const f=fixture();f.reader.scrollTop=735;
 const button={left:950,right:1040},versions={clientWidth:350,scrollLeft:0,scrollTop:11,querySelector:()=>({getBoundingClientRect:()=>button}),getBoundingClientRect:()=>({left:20})};
 f.ctx.revealStructureVersion(versions);assert.equal(versions.scrollLeft,678);assert.equal(versions.scrollTop,11);assert.equal(f.reader.scrollTop,735);assert.equal(f.scrolls.length,0);
 button.left=28;button.right=118;f.ctx.revealStructureVersion(versions);assert.equal(versions.scrollLeft,678,'already visible version retains horizontal reading position');
 button.left=-82;button.right=8;f.ctx.revealStructureVersion(versions);assert.equal(versions.scrollLeft,568,'older version outside the left edge is revealed');
});
test('a hidden or empty version strip does not change any reading position',()=>{
 const f=fixture();f.ctx.revealStructureVersion(null);
 const hidden={clientWidth:0,scrollLeft:27};f.ctx.revealStructureVersion(hidden);assert.equal(hidden.scrollLeft,27);
 const empty={clientWidth:350,scrollLeft:27,querySelector:()=>null};f.ctx.revealStructureVersion(empty);assert.equal(empty.scrollLeft,27);
});
