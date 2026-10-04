const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(){
 const visuals=[],ctx={URLSearchParams,state:{productionRecords:[]},ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame(){},link(){}};
 const img={addEventListener(){}},stage={style:{},dataset:{},querySelector:()=>img},viewport={classList:{add(){}}};
 ctx.el=()=>({dataset:{},append(){},addEventListener(){},querySelector:s=>s==='.structure-visual-stage'?stage:viewport});ctx.renderStructureVisual=v=>{visuals.push(v);return stage};vm.createContext(ctx);require('./load_review_helpers.cjs')(ctx);
 for(const name of ['production.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
 const row=(object,id,title)=>({object_id:object,id,kind:'ASSET',current_revision:id,payload:{title,media_type:'image',production:{object_id:'call-'+id,revision_id:'call-'+id+'-r1'},components:[{id:'original',role:'original',mime:'image/png',sha256:id,file:id+'.png',width:160,height:90}]}});
 const a=row('a','a-r1','Candidate A'),b=row('b','b-r1','Candidate B'),range={start_seconds:1,end_seconds:2},crop={x:0,y:0,width:.5,height:.5};
 const original={record:a,component:a.payload.components[0],label:'Placement label A',range,crop},round={number:1,members:[a,b],results:[a,b]},data={material_versions:{a:[round]}};
 const render=items=>{for(const item of items)ctx.materialMedia({append(){}},item);return visuals};
 return {ctx,a,b,original,round,data,row,visuals,render};
}
test('extra material round candidates use their own image title and alt without copying the first placement',()=>{
 const f=fixture(),before=JSON.stringify(f.data),models=f.ctx.materialRoundModels([],[f.original],f.data),items=models[0].candidates;
 assert.equal(items.length,2);const v=f.render(items);assert.deepEqual(v.map(x=>[x.title,x.alt,x.file]),[['Placement label A','Placement label A','a-r1.png'],['Candidate B','Candidate B','b-r1.png']]);
 assert.equal(items[0].range,f.original.range);assert.equal(items[0].crop,f.original.crop);assert.equal(items[1].range,null);assert.equal(items[1].crop,null);assert.equal(items[1].record,f.b);assert.equal(JSON.stringify(f.round),JSON.stringify(JSON.parse(before).material_versions.a[0]));
});
test('an explicit label belonging to the exact second placement is retained',()=>{
 const f=fixture(),second={record:f.b,component:f.b.payload.components[0],label:'明确展示用途 B'},items=f.ctx.materialRoundModels([],[f.original,second],f.data)[0].candidates;
 assert.deepEqual(f.render(items).map(v=>v.title),['Placement label A','明确展示用途 B']);assert.equal(items[1].record.id,'b-r1');
});
test('old revisions in extra and planned rounds cannot inherit a current revision placement label',()=>{
 for(const planned of [false,true]){
  const f=fixture(),old=f.row('a','a-old','Historical A'),plan={object_id:'need',id:'need-r1',kind:'REQUIREMENT',payload:{title:'Plan A',media_type:'image'}};
  f.round.members=[old,plan];f.round.results=[old];if(planned){f.round.plan=plan;f.data.material_versions={need:[f.round]}}
  const items=f.ctx.materialRoundModels(planned?[plan]:[],[f.original],f.data)[0].candidates;
  assert.equal(items[0].record,old);assert.deepEqual(f.render(items).map(v=>[v.title,v.alt,v.file]),[['Historical A','Historical A','a-old.png']]);assert.equal(items[0].range,null);assert.equal(items[0].crop,null);
 }
});
