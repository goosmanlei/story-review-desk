const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.connected=true;this.parent=null;this.textContent=''}
  get isConnected(){return this.connected&&(!this.parent||this.parent.isConnected)}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n)}}
  replaceChildren(){for(const n of this.children)n.parent=null;this.children=[]}
  setAttribute(){}
  querySelectorAll(){return []}
  addEventListener(){}
}
const text=node=>[node.textContent,...node.children.map(text)].join('\n');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const asset=(id='exact')=>({id,object_id:'asset',version:1,kind:'ASSET',created_at:'2026-10-03T03:22:31Z',payload:{title:'original',components:[{id:'original',role:'original',mime:'image/png',file:'exact.png'}],blocks:[{id:'self-check',text:'生成时尚待确认'}]}});
const opinion=(id,target,verdict='accepted')=>({id,object_id:id,current_revision:id,created_at:'2026-10-03T04:59:57Z',payload:{target:{object_id:'asset',revision_id:target},review_type:'generation_master',actor:'user',verdict,reason:'准确理由',evidence:{reply:'真实原话'}}});
function setup(api){
  const views=[],links=[],writes=[];
  const ctx={Option:function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n},state:{productionRecords:[],productionJudgmentDrafts:{exact:{open:true}}},URLSearchParams,api,
    el:tag=>new Element(tag),nodeText:(tag,cls,value,parent)=>{const n=new Element(tag);n.textContent=value;parent.append(n);return n},
    businessTitle:r=>r.payload.title,reviewPositionText:x=>x,reviewURL:x=>x,
    productionButton:(parent,label,action)=>{const n=new Element('button');n.textContent=label;n.action=action;parent.append(n);return n},
    showProductionJudgment:()=>writes.push('draft-editor'),paintReviewCommentCounts:()=>{},link:(label,url,parent)=>{const n=new Element('a');n.textContent=label;parent.append(n)},
    openReviewDialog:()=>{const dialog=new Element('dialog'),body=new Element('div'),title=new Element('h2');dialog.append(title,body);const v={dialog,body,title};views.push(v);return v}
  };
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../review_desk/static/material-review.js'),'utf8'),ctx);
  ctx.materialReferenceLink=(_parent,ref)=>links.push(ref);
  return {ctx,views,links,writes};
}
test('reference reads exact judgments without preparation prose without opening an editor or duplicating the same-original link',async()=>{
  const row=asset(),data={current:[opinion('master',row.id)],history:[opinion('older','old')],conflicting:false};
  const {ctx,views,links,writes}=setup(async()=>({record:row,review_context:{judgments:data}}));
  await ctx.openMaterialReference({object_id:row.object_id,revision_id:row.id,component_id:'original'});
  assert.match(text(views[0].body),/母版认可/);assert.match(text(views[0].body),/准确理由/);assert.match(text(views[0].body),/真实原话/);
  assert.doesNotMatch(text(views[0].body),/生成时自检|生成时尚待确认/);
  assert.doesNotMatch(text(views[0].body),/记录本版本审阅结论/);assert.deepEqual(writes,[]);
  assert.equal(links.length,0);const history=views[0].body.children.find(n=>n.dataset.judgmentTarget).children.find(n=>n.children.some(c=>c.tag==='select'));const select=history.children.find(n=>n.tag==='select');select.value='older';select.onchange();assert.equal(links[0].revision_id,'old');
  assert.equal(views[0].body.dataset.referenceRevision,'exact');
});
test('closing and opening another reference cannot receive the first late object or judgment',async()=>{
  let resolveFirst,resolveJudgment;const first=new Promise(r=>resolveFirst=r),judgment=new Promise(r=>resolveJudgment=r);
  const {ctx,views}=setup(url=>url.includes('/judgments?')?judgment:views.length===1?first:Promise.resolve({record:asset('second'),review_context:{judgments:{current:[],history:[],conflicting:false}}}));
  const opening=ctx.openMaterialReference({object_id:'asset',revision_id:'exact'});views[0].dialog.connected=false;
  await ctx.openMaterialReference({object_id:'asset',revision_id:'second'});resolveFirst({record:asset()});await opening;
  assert.equal(views[0].body.dataset.referenceRevision,undefined);assert.equal(views[1].body.dataset.referenceRevision,'second');
  assert.match(text(views[1].body),/尚无人工判断/);
  const root=new Element('main');ctx.renderMaterialResultReview(root,asset(),{},{readOnly:true});root.connected=false;
  resolveJudgment({current:[opinion('late','exact')],history:[],conflicting:false});await tick();
  assert.doesNotMatch(text(root),/母版认可/);assert.doesNotMatch(text(views[1].body),/母版认可/);
});
test('missing exact component and failed judgment read stay explicit without fallback or false no-judgment result',async()=>{
  const {ctx,views}=setup(async url=>{if(url.includes('/judgments?'))throw Error('准确判断读取失败');return {record:asset()}});
  await ctx.openMaterialReference({object_id:'asset',revision_id:'exact',component_id:'missing'});
  assert.match(text(views[0].body),/引用的文件组成不存在/);assert.doesNotMatch(text(views[0].body),/下载原文件/);
  await ctx.openMaterialReference({object_id:'asset',revision_id:'exact',component_id:'original'});await tick();
  assert.match(text(views[1].body),/准确判断读取失败/);assert.doesNotMatch(text(views[1].body),/尚无人工判断/);
});
test('read-only conflicts and revocations use the shared projection; normal full cards retain editing',()=>{
  const {ctx,writes}=setup(()=>{}),root=new Element('main'),row=asset();
  ctx.renderMaterialResultReview(root,row,{judgments:{current:[opinion('yes','exact'),opinion('no','exact','rejected'),opinion('revoked','exact','revoked')],history:[],conflicting:true}},{readOnly:true});
  assert.match(text(root),/相反意见，尚无统一结论/);assert.match(text(root),/已取消/);assert.match(text(root),/不通过/);assert.deepEqual(writes,[]);
  const full=new Element('main');ctx.renderMaterialResultReview(full,row,{judgments:{current:[],history:[],conflicting:false}});
  assert.match(text(full),/记录本版本审阅结论/);assert.deepEqual(writes,['draft-editor']);
});
