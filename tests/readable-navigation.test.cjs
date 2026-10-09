const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function context(extra={}){const c=vm.createContext({URL,URLSearchParams,state:{businessCodes:new Map([['shot','ASH001'],['scene:e17:s040','S040']])},...extra});require('./load_review_helpers.cjs')(c);vm.runInContext(fs.readFileSync('review_desk/static/management-cards.js','utf8'),c);return c}
const plain=value=>JSON.parse(JSON.stringify(value));
test('names keep allocated identity, remove only legacy shot prefixes and retain content',()=>{
 const c=context();assert.equal(c.businessTitle({kind:'AV_SHOT',object_id:'shot',payload:{title:'01 · A01 · 01 李寄回头'}}),'ASH001 · 李寄回头');
 assert.equal(c.readableProductionTitle({kind:'REQUIREMENT',scope:{object_id:'shot'},title:'镜头视频 · 01 · A01 · 01 李寄回头'}),'镜头视频 · ASH001 · 李寄回头');
 assert.equal(c.businessTitle({kind:'ENTITY',payload:{title:'编号 01 是戏文'}}),'编号 01 是戏文');
 assert.equal(c.managementSceneLabel('s040','e17',{episodes:[{object_id:'e17',scenes:[{id:'s040',heading:'17-01 这一页我来'}]}]}),'S040 · 这一页我来');
});
test('displayed code search is exact and normalized, Chinese aliases remain searchable',()=>{
 const c=context();for(const query of ['m2624','Ｍ２６２４','旧渡头'])assert.equal(c.readableSearchMatches(query,['M2624','渡口 · 旧渡头']),true);
 assert.equal(c.readableSearchMatches('M262',['M2624']),false);
});
test('identity lookup shows one material with every real use; location browsing preserves groups',()=>{
 const c=context(),result={items:[{object_id:'material',canonical_material_id:'material'}],groups:[1,2,3].map(i=>({key:'g'+i,level:'scene',episode:'e17',scene:'s'+i,material_ids:['material']}))};
 const catalog={episodes:[{object_id:'e17',number:17}]};
 const lookup=plain(c.managementMaterialGroups(result,{search:'voice'},catalog));assert.equal(lookup.length,1);assert.equal(lookup[0].items.length,1);assert.equal(lookup[0].items[0].usageGroups.length,3);
 assert.equal(c.managementMaterialGroups(result,{search:'voice',episode:'e17'},catalog).length,3);
 assert.equal(c.managementMaterialGroups(result,{search:''},catalog).length,3);
});
function positionFixture(read){
 let renders=0;const root={isConnected:true,closest:()=>null},original={record:{id:'old'}};
 const c=context({state:{positionReview:original,unifiedCardRoot:root},rememberProductionDraft(){},readUnifiedCard:read,
  activateUnifiedCard(result){c.state.positionReview=result.position_review},renderProductionReader(){renders++},renderComments(){},toast(){}});
 vm.runInContext(fs.readFileSync('review_desk/static/unified-cards.js','utf8'),c);
 c.readUnifiedCard=read;c.activateUnifiedCard=result=>{c.state.positionReview=result.position_review};
 return {c,original,root,renders:()=>renders};
}
test('failed exact history read restores the selector to the still-current design',async()=>{
 const f=positionFixture(async()=>{throw Error('missing exact version')});await f.c.switchUnifiedPosition('shot','missing');
 assert.equal(f.c.state.positionReview,f.original);assert.equal(f.renders(),1);
});
test('explicit unknown screenplay version, episode and scene refuse defaults; ordinary entry selects a valid scene',()=>{
 const reader={dataset:{},scrollTop:0},state={screenplays:[{object_id:'v4',episodes:[{object_id:'ep17',id:'ep17-old',payload:{scenes:[{id:'s040'}]}}]}]};
 const c=context({state,$:()=>reader,isScript:()=>false,location:{href:'http://isolated/'}});
 vm.runInContext(fs.readFileSync('review_desk/static/screenplay.js','utf8'),c);c.renderScriptIndex=()=>{};c.renderScriptReader=()=>{};
 c.chooseScript(null,null,null,false);assert.equal(state.screenplayScene,'s040');assert.equal(state.screenplayRouteError,null);
 c.chooseScript('v4','ep17','missing',false);assert.equal(state.screenplayScene,null);assert.match(state.screenplayRouteError,/场次/);
 c.chooseScript('v4','missing',null,false);assert.equal(state.screenplayEpisode,null);assert.match(state.screenplayRouteError,/集/);
 c.chooseScript('missing','ep17','s040',false);assert.equal(state.screenplayVersion,null);assert.match(state.screenplayRouteError,/版本/);
 c.chooseScript('v4','ep17','s040',false);assert.equal(state.screenplayRouteError,null);assert.equal(state.screenplayScene,'s040');
});
test('late version response cannot replace a newer choice or a closed nested reader',async()=>{
 const pending=new Map(),f=positionFixture((_id,revision)=>new Promise(resolve=>pending.set(revision,resolve)));
 const old=f.c.switchUnifiedPosition('shot','v1'),latest=f.c.switchUnifiedPosition('shot','v2');
 pending.get('v2')({position_review:{record:{id:'v2'}},detail:{record:{id:'v2'}}});await latest;
 pending.get('v1')({position_review:{record:{id:'v1'}},detail:{record:{id:'v1'}}});await old;
 assert.equal(f.c.state.positionReview.record.id,'v2');assert.equal(f.renders(),1);
 const closing=f.c.switchUnifiedPosition('shot','v3');f.root.isConnected=false;
 pending.get('v3')({position_review:{record:{id:'v3'}},detail:{record:{id:'v3'}}});await closing;assert.equal(f.c.state.positionReview.record.id,'v2');
});
