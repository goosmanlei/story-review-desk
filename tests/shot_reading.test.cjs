const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
class Node{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.open=false;this.ownText=''}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
  get childElementCount(){return this.children.length}
  get textContent(){return this.ownText+this.children.map(n=>n.textContent).join('')}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  querySelectorAll(){return this.all().filter(n=>n.dataset.blockId)}
}
function fixture(){
 const ctx={state:{},URL,URLSearchParams,location:{href:'http://fixture/'},el:tag=>new Node(tag),reviewSurface:n=>n,nodeText:(tag,cls,text,parent)=>{const n=new Node(tag);n.ownText=text;parent.append(n);return n},document:{querySelectorAll:()=>[]}};
 vm.createContext(ctx);for(const file of ['production.js','production-breakdown.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',file),'utf8'),ctx);return ctx;
}
const shot=(id,payload)=>({id,object_id:id,kind:'AV_SHOT',payload:{format:'production-av-shot-v1',purpose:'看清交接',performance:'看清交接',framing:'同框近景',movement:'同框近景',spatial:'桌旁',axis:'南侧',lighting:'暖光',color:'灰蓝',continuity:'本子在右手',editing:'收尾留气口',sound:['环境底声','收尾留气口','阿蘅说完才停'],...payload}});
const render=(ctx,row,common)=>{const host=new Node('main');ctx.breakdownShotText(host,row,common);return host.children[0]};
const mainText=surface=>surface.children.filter(n=>n.tagName!=='DETAILS').map(n=>n.textContent).join('\n');
const plain=v=>JSON.parse(JSON.stringify(v));
test('same choices read once, but distinct original anchors remain on their own fields',()=>{
 const ctx=fixture(),row=shot('old',{blocks:[{id:'old-purpose',field:'purpose',text:'看清交接'},{id:'old-performance',field:'performance',text:'看清交接'},{id:'old-framing',field:'framing',text:'同框近景'},{id:'old-movement',field:'movement',text:'同框近景'}]});
 const before=JSON.stringify(row),surface=render(ctx,row);
 assert.equal(mainText(surface).split('看清交接').length-1,1);assert.equal(mainText(surface).split('同框近景').length-1,1);
 const original=surface.children.find(n=>n.tagName==='DETAILS');assert.equal(original.open,false);
 assert.deepEqual(original.querySelectorAll().map(n=>n.dataset.blockId),['old-movement','old-performance','@review/sound/1/text']);assert.equal(JSON.stringify(row),before);
});
test('independent purpose, performance, framing and movement stay complete, including substrings',()=>{
 const ctx=fixture(),surface=render(ctx,shot('independent',{purpose:'观众先看清她收回手',performance:'收回手',framing:'两人同框',movement:'固定',blocks:[{id:'purpose',text:'观众先看清她收回手'}]}));
 const text=mainText(surface);for(const value of ['叙事目的　观众先看清她收回手','表演　收回手','构图　两人同框','机位运动　固定'])assert.ok(text.includes(value));
 assert.ok(!text.includes('叙事目的与表演'));assert.ok(!surface.querySelectorAll().some(n=>n.dataset.blockId==='purpose'&&n.textContent==='收回手'));
});
test('near or whitespace-different expressions are not declared identical',()=>{
 const ctx=fixture(),surface=render(ctx,shot('near',{performance:'看清交接。',movement:'同框近景 '}));assert.ok(mainText(surface).includes('表演　看清交接。'));assert.ok(mainText(surface).includes('机位运动　同框近景 '));
});
test('common conditions use only all exact displayed children; changed coverage never folds',()=>{
 const ctx=fixture(),old=shot('old',{spatial:'旧桌旁'}),other=shot('old-other',{spatial:'旧桌旁'}),latest=shot('latest',{spatial:'新门口',lighting:'日光'});
 const common=ctx.breakdownCommonConditions([{record:old},{record:other}]);assert.equal(common.fields.spatial,'旧桌旁');
 const mixed=ctx.breakdownCommonConditions([{record:old},{record:latest}]);assert.ok(!('spatial' in mixed.fields));assert.ok(!('lighting' in mixed.fields));
 assert.ok(mainText(render(ctx,latest,mixed)).includes('光线　日光'));assert.deepEqual(plain(ctx.breakdownCommonConditions([{record:old}])),{fields:{},sounds:[]});
});
test('common and original scene values are separately accessible without changing shot values',()=>{
 const ctx=fixture(),rows=[shot('a'),shot('b')],common=ctx.breakdownCommonConditions(rows.map(record=>({record}))),host=new Node('main');
 ctx.renderBreakdownConditions(host,{scene:{payload:{spatial:'父场原空间',axis:'父场原轴线',continuity:'父场原承接',sound:['父场原声音']}}},common);
 assert.ok(host.children[0].textContent.includes('父场原空间'));assert.ok(host.children[1].textContent.includes('空间　桌旁'));assert.equal(host.children[1].open,true);
 const surface=render(ctx,rows[0],common);assert.ok(!mainText(surface).includes('空间　桌旁'));assert.ok(surface.children.find(n=>n.tagName==='DETAILS').textContent.includes('空间　桌旁'));
 assert.ok(!mainText(surface).includes('收尾留气口；收尾留气口'));assert.ok(mainText(surface).includes('声音　阿蘅说完才停')); // Repeated events must remain in each shot.
});
test('locating a folded old field reveals its exact ancestor without moving the anchor',()=>{
 const ctx=fixture(),row=shot('old',{blocks:[{id:'purpose-old',field:'purpose',text:'看清交接'},{id:'performance-old',field:'performance',text:'看清交接'}]}),surface=render(ctx,row),details=surface.children.find(n=>n.tagName==='DETAILS');
 ctx.state.productionSelected=row;ctx.document.querySelector=selector=>selector.includes('data-production-blocks="old"')?surface:null;ctx.CSS={escape:s=>s};ctx.$=()=>null;ctx.paintProductionReview=()=>{};ctx.renderComments=()=>{};
 const comment={id:'comment',target_object_id:row.object_id,target_revision_id:'old',anchor:{type:'text',block_id:'performance-old',start:0,end:4,quote:'看清交接'}};const before=JSON.stringify(comment);ctx.locateProductionComment(comment,true);
 assert.equal(details.open,true);assert.equal(ctx.state.selected,'comment');assert.equal(JSON.stringify(comment),before);
});

test('same spoken words remain repeated events, while explicit ambience can be shared',()=>{
 const ctx=fixture(),rows=[shot('a',{sound:[{type:'dialogue',text:'我再来一遍。'},{type:'ambience',text:'河声'}]}),shot('b',{sound:[{type:'dialogue',text:'我再来一遍。'},{type:'ambience',text:'河声'}]})],common=ctx.breakdownCommonConditions(rows.map(record=>({record})));
 assert.deepEqual(plain(common.sounds),['河声']);for(const row of rows)assert.ok(mainText(render(ctx,row,common)).includes('声音　我再来一遍。'));
});

test('spoken content matching a background or editing line is never hidden by those roles',()=>{
 const ctx=fixture(),rows=[shot('a',{editing:'同句',sound:[{type:'dialogue',text:'同句'},{type:'dialogue',text:'河声'},{type:'ambience',text:'河声'}]}),shot('b',{editing:'同句',sound:[{type:'dialogue',text:'同句'},{type:'dialogue',text:'河声'},{type:'ambience',text:'河声'}]})],common=ctx.breakdownCommonConditions(rows.map(record=>({record})));
 const text=mainText(render(ctx,rows[0],common));assert.ok(text.includes('声音　同句'));assert.ok(text.includes('声音　河声'));
});
