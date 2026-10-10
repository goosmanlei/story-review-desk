const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
class Node{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.open=false;this.ownText=''}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  get childElementCount(){return this.children.length}
  get textContent(){return this.ownText+this.children.map(n=>n.textContent).join('')}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  querySelectorAll(){return this.all().filter(n=>n.dataset.blockId)}
  hasAttribute(){return false}
  scrollIntoView(){this.scrolled=true}
}
function fixture(){
 const ctx={state:{},URL,URLSearchParams,location:{href:'http://fixture/'},el:tag=>new Node(tag),reviewSurface:n=>n,nodeText:(tag,cls,text,parent)=>{const n=new Node(tag);n.ownText=text;parent.append(n);return n},document:{querySelectorAll:()=>[]}};
 vm.createContext(ctx);for(const file of ['production.js','material-review.js','production-breakdown.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',file),'utf8'),ctx);return ctx;
}
const shot=(id,payload)=>({id,object_id:id,kind:'AV_SHOT',payload:{format:'production-av-shot-v1',purpose:'看清交接',performance:'看清交接',framing:'同框近景',movement:'同框近景',spatial:'桌旁',axis:'南侧',lighting:'暖光',color:'灰蓝',continuity:'本子在右手',editing:'收尾留气口',sound:['环境底声','收尾留气口','阿蘅说完才停'],...payload}});
const render=(ctx,row,common)=>{const host=new Node('main');ctx.breakdownShotText(host,row,common);return host.children[0]};
const mainText=surface=>surface.children.filter(n=>n.tagName!=='DETAILS').map(n=>n.textContent).join('\n');
const plain=v=>JSON.parse(JSON.stringify(v));
test('authored reading requires exact companions and keeps original Unicode offsets',()=>{
 const ctx=fixture(),row=shot('exact'),host=new Node('main');
 row.review_composition={requires:['scene-old','prompt-old'],sections:[{label:'动作',parts:[{block_id:'body',start:7,end:12,text:'她看见🐍。'}]}]};
 assert.equal(ctx.renderRecordComposition(host,row,['scene-old','prompt-new']),false);
 assert.equal(host.children.length,0);
 assert.equal(ctx.renderRecordComposition(host,row,['scene-old','prompt-old']),true);
 const excerpt=host.all().find(n=>n.dataset.blockId==='body');
 assert.equal(excerpt.textContent,'她看见🐍。');assert.equal(excerpt.dataset.anchorOffset,7);
});
test('an omitted or cross-block draft restores the original reading instead of rebinding it',()=>{
 const ctx=fixture(),row=shot('exact');row.review_composition={sections:[{label:'',parts:[{block_id:'body',start:7,end:12,text:'她看见🐍。'}]}]};ctx.state.productionSelected=row;
 for(const anchor of [{type:'text',block_id:'body',start:0,end:3},{type:'text',block_id:'body',end_block_id:'second',start:7,end:9}]){
  const host=new Node('main');ctx.state.anchor=anchor;assert.equal(ctx.renderRecordComposition(host,row),false);assert.equal(host.children.length,0);
 }
});
test('Prompt comments prefer a containing exact excerpt and reveal full text for older technical ranges',()=>{
 const ctx=fixture(),prompt='技术前言。看她一眼🐍，接回歌本。技术后文。',row={id:'exact-plan',object_id:'need',kind:'REQUIREMENT',payload:{generation:{prompt}}};
 const block=ctx.productionTextBlocks(row).find(b=>b.field==='generation.prompt'),full=new Node('pre'),excerpt=new Node('span'),details=new Node('details');
 full.dataset.blockId=excerpt.dataset.blockId=block.id;full.ownText=prompt;details.append(full);
 excerpt.ownText='看她一眼🐍，接回歌本。';excerpt.dataset.anchorOffset=5;excerpt.hasAttribute=key=>key==='data-anchor-offset';
 const excerptHost=new Node('div'),fullHost=new Node('div');excerptHost.dataset.productionBlocks=fullHost.dataset.productionBlocks=row.id;excerptHost.append(excerpt);fullHost.append(details);excerptHost.querySelector=fullHost.querySelector=()=>null;ctx.document.querySelector=()=>({querySelectorAll:()=>[excerptHost,fullHost]});ctx.document.querySelectorAll=()=>[excerpt,full];ctx.state.productionSelected=row;ctx.CSS={escape:s=>s};ctx.$=()=>null;ctx.paintProductionReview=ctx.renderComments=()=>{};
 const action={type:'text',block_id:block.id,start:5,end:10,quote:'看她一眼🐍'};
 assert.equal(ctx.productionCommentTextNode(action),excerpt);
 const old={id:'old-comment',target_revision_id:row.id,target_object_id:row.object_id,anchor:{type:'text',block_id:block.id,start:16,end:21,quote:'技术后文。'}};
 const before=JSON.stringify(old);assert.equal(ctx.locateProductionComment(old,true),true);assert.equal(details.open,true);assert.equal(full.scrolled,true);assert.equal(JSON.stringify(old),before);
});

test('restoring a technical Prompt draft opens its full exact surface instead of an unrelated excerpt',()=>{
 const ctx=fixture(),excerpt=new Node('div'),full=new Node('div'),details=new Node('details'),a=new Node('span'),b=new Node('pre');
 excerpt.dataset.productionBlocks=full.dataset.productionBlocks='exact';a.dataset.blockId=b.dataset.blockId='prompt';a.dataset.anchorOffset=8;a.ownText='动作';a.hasAttribute=()=>true;b.ownText='技术前言以及动作';excerpt.append(a);full.append(b);details.append(full);
 let focused=null;excerpt.reviewFocus=()=>focused='excerpt';full.reviewFocus=()=>focused='full';ctx.productionTab=()=> 'breakdown';ctx.localStorage={getItem:()=> '未保存'};
 ctx.state.breakdownVideoSelections={current:{}};ctx.state.productionDraftContexts={'["exact",null,null,null]':{anchor:{block_id:'prompt',start:0,end:4},draftKey:'draft'}};
 ctx.restoreBreakdownPromptDraft({querySelectorAll:()=>[excerpt,full]});assert.equal(focused,'full');assert.equal(details.open,true);
});
