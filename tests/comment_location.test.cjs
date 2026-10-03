const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const files=['app.js','production.js','material-review.js','entity-review.js'];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
// Actual navigation and edit callbacks with controlled HTTP responses. Rendering
// and scrolling are substitutes here; real gestures remain browser acceptance.
class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.classList={add(){},remove(){},toggle(){}}}append(...nodes){this.children.push(...nodes)}setAttribute(){}addEventListener(){}all(){return this.children.flatMap(node=>[node,...node.all()])}}
const row=(object,kind,id=object+'-v1',payload={})=>({object_id:object,id,kind,current_revision:id,version:1,payload:{title:object,...payload}});
function setup(){
 const plan=row('need','REQUIREMENT','shared-plan',{scope:{object_id:'form'}}),oldCall=row('call','CALL','call-old'),newCall=row('call','CALL','call-new');
 const asset=(id,call)=>row('asset','ASSET',id,{production:{object_id:'call',revision_id:call.id},components:[{id:'original',mime:'audio/wav'}]});
 const oldAsset=asset('asset-old',oldCall),newAsset=asset('asset-new',newCall),rounds=[{number:2,plan,members:[plan,newAsset,newCall],results:[newAsset]},{number:1,plan,members:[plan,oldAsset,oldCall],results:[oldAsset]}];
 const detail=record=>({record,history:[newAsset,oldAsset],review_context:{call:record.id===oldAsset.id?oldCall:newCall,requirements:[plan]},review_contexts:{[oldAsset.id]:{call:oldCall,requirements:[plan]},[newAsset.id]:{call:newCall,requirements:[plan]}},material_versions:{need:rounds},selectedMaterialRounds:{need:2}});
 const requests=[],messages=[],nodes={'#toast':{classList:{add(){},remove(){}},set textContent(message){messages.push(message)}}};
 const ctx={URL,URLSearchParams,console,CSS:{escape:value=>value},setTimeout:()=>1,clearTimeout(){},getSelection:()=>null,location:{href:'http://local/?workspace=materials.workspace'},history:{replaceState(_a,_b,u){ctx.location.href=String(u)}},localStorage:{getItem:()=>null},document:{addEventListener(){},querySelector:s=>nodes[s]||null,querySelectorAll:()=>[],createElement:t=>new Element(t)},fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,reject,resolve:data=>resolve({ok:true,json:async()=>data})}))};
 vm.createContext(ctx);for(const name of files)vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),ctx);
 vm.runInContext('globalThis.state=state;globalThis.key=draftKey;openPanel=()=>{};hideSelectionAction=()=>{};',ctx);
 ctx.state.workspace='materials.workspace';ctx.state.productionRecords=[plan,newAsset];ctx.state.materialReview=detail(newAsset);ctx.state.productionSelected=newAsset;
 for(const name of ['renderComments','renderProductionReader','paintProductionReview','renderDocument','renderStructureReader','renderScriptReader'])ctx[name]=()=>{};
 const comment=(target,id='old-comment')=>({id,body:'original opinion',status:'OPEN',version:1,updated_at:'2026-10-04T00:00:00Z',target_object_id:target.object_id,target_revision_id:target.id,anchor:{type:'global'},material_scopes:[{material_id:'need',number:1}]});
 const click=(c,label='编辑')=>{ctx.state.comments=[c];const card=ctx.commentCard(c),button=card.all().find(n=>n.tag==='button'&&n.textContent===label);assert.ok(button);return button.onclick()};
 const entity=()=>{const owner=row('person','ENTITY'),form=row('form','STATE',undefined,{entity:{object_id:'person'}});ctx.state.workspace='settings.workspace';ctx.state.entityReview={entity:owner,states:[form],media:[],requirements:[plan],comment_records:[oldCall,newCall,oldAsset,newAsset],material_versions:{need:rounds},selectedMaterialRounds:{need:2}};ctx.state.productionChildDetail={record:form};return ctx.state.entityReview};
 return {ctx,requests,messages,plan,oldCall,newCall,oldAsset,newAsset,rounds,detail,comment,click,entity};
}
for(const workspace of ['materials','settings'])for(const number of [1,2])test(`${workspace}: editing a shared plan keeps its exact recorded round ${number}`,async()=>{
 const f=setup(),data=workspace==='settings'?f.entity():f.ctx.state.materialReview,c=f.comment(f.plan);c.material_scopes[0].number=number;const before=JSON.stringify(c);
 await f.click(c);assert.equal(data.selectedMaterialRounds.need,number);assert.equal(f.ctx.state.editing,c.id);assert.equal(f.ctx.state.productionSelected.id,f.plan.id);assert.equal(f.ctx.state.materialCommentCard.number,number);assert.equal(f.ctx.state.reviewCommentScope,null);assert.equal(JSON.stringify(c),before);
});
test('legacy comments without scopes remain locatable without inventing a round attribution',async()=>{
 const f=setup(),c=f.comment(f.plan);delete c.material_scopes;f.ctx.state.materialReview.selectedMaterialRounds.need=1;
 await f.click(c);assert.equal(f.ctx.state.materialReview.selectedMaterialRounds.need,1);assert.equal(f.ctx.state.editing,c.id);assert.equal(c.material_scopes,undefined);
 delete f.ctx.state.materialReview.selectedMaterialRounds.need;await f.click(c);assert.equal(f.ctx.state.materialReview.selectedMaterialRounds.need,2);
});
test('an unavailable explicit round cannot silently use the latest revision match',async()=>{
 const f=setup(),c=f.comment(f.plan);c.material_scopes[0].number=9;await f.click(c);assert.equal(f.ctx.state.editing,null);assert.equal(f.ctx.state.materialReview.selectedMaterialRounds.need,2);assert.match(f.messages.at(-1),/无法准确定位/);
});
test('an explicit round must contain the exact commented revision',async()=>{
 const f=setup(),c=f.comment(f.oldAsset);c.material_scopes[0].number=2;const editing=f.click(c);f.requests[0].resolve(f.detail(f.oldAsset));await editing;assert.equal(f.ctx.state.editing,null);assert.match(f.messages.at(-1),/无法准确定位/);
});
for(const workspace of ['materials','settings'])test(`${workspace}: locating the original selection also follows the recorded round without editing`,async()=>{
 const f=setup(),data=workspace==='settings'?f.entity():f.ctx.state.materialReview,c=f.comment(f.plan);await f.click(c,'定位原圈选');assert.equal(data.selectedMaterialRounds.need,1);assert.equal(f.ctx.state.selected,c.id);assert.equal(f.ctx.state.editing,null);
});
test('multiple material scopes require an existing exact card context, not an arbitrary first match',async()=>{
 const f=setup(),data=f.entity(),c=f.comment(f.oldAsset);data.material_versions.other=f.rounds;data.selectedMaterialRounds.other=2;c.material_scopes.push({material_id:'other',number:1});
 await f.click(c);assert.equal(f.ctx.state.editing,null);assert.match(f.messages.at(-1),/多个素材/);assert.equal(data.selectedMaterialRounds.need,2);assert.equal(data.selectedMaterialRounds.other,2);
 f.ctx.state.materialCommentCard={data,material_id:'other',number:2};await f.click(c);assert.equal(f.ctx.state.editing,c.id);assert.equal(data.selectedMaterialRounds.other,1);assert.equal(data.selectedMaterialRounds.need,2);
});
test('an invalid preferred scope does not fall through to another valid material',async()=>{
 const f=setup(),data=f.entity(),c=f.comment(f.oldAsset);data.material_versions.other=f.rounds;c.material_scopes=[{material_id:'need',number:9},{material_id:'other',number:1}];f.ctx.state.materialCommentCard={data,material_id:'need',number:2};
 await f.click(c);assert.equal(f.ctx.state.editing,null);assert.match(f.messages.at(-1),/无法准确定位/);assert.equal(data.selectedMaterialRounds.need,2);
});
for(const kind of ['ASSET','CALL'])test(`${kind}: edit waits for the exact historical reader and does not cancel its own completion`,async()=>{
 const f=setup(),target=kind==='ASSET'?f.oldAsset:f.oldCall,c=f.comment(target);if(kind==='ASSET')c.anchor={type:'time',component_id:'original',start_seconds:1.25,end_seconds:3.5};
 const editing=f.click(c);assert.equal(f.ctx.state.editing,null);assert.equal(f.ctx.state.anchor,null);assert.equal(f.requests.length,1);
 f.requests[0].resolve(f.detail(f.oldAsset));await editing;assert.equal(f.ctx.state.productionSelected.id,target.id);assert.equal(f.ctx.state.editing,c.id);assert.equal(f.ctx.state.anchor,c.anchor);assert.equal(f.ctx.state.materialReview.selectedMaterialRounds.need,1);assert.match(f.ctx.key(),new RegExp(target.id));assert.equal(f.requests.length,1);if(kind==='ASSET')assert.equal(f.ctx.state.materialReview.componentId,'original');
});
test('failed historical loading never starts an editor on the wrong content',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset));f.requests[0].reject(Error('offline'));await editing;assert.equal(f.ctx.state.editing,null);assert.equal(f.ctx.state.productionSelected.id,f.newAsset.id);assert.match(f.messages.at(-1),/offline/);
});
test('an old response cannot reissue its lookup after a newer navigation',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset)),newer=f.ctx.openProductionRecord(f.newAsset.object_id,f.newAsset.id);
 f.requests[1].resolve(f.detail(f.newAsset));await newer;f.ctx.startDraft({type:'global'},{id:'new-editor'});f.requests[0].resolve(f.detail(f.oldAsset));await editing;await flush();
 assert.equal(f.requests.length,2);assert.equal(f.ctx.state.productionSelected.id,f.newAsset.id);assert.equal(f.ctx.state.editing,'new-editor');
});
test('cancelling an old location never invalidates a newer request that already owns the read epoch',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset)),newer=f.ctx.openProductionRecord(f.newAsset.object_id,f.newAsset.id);const epoch=vm.runInContext('productionReadEpoch',f.ctx);
 f.ctx.cancelMaterialCommentLocation();assert.equal(vm.runInContext('productionReadEpoch',f.ctx),epoch);f.requests[0].resolve(f.detail(f.oldAsset));await editing;f.requests[1].resolve(f.detail(f.newAsset));await newer;assert.equal(f.ctx.state.materialReview.record.id,f.newAsset.id);assert.equal(f.requests.length,2);
});
test('a fresh selection draft invalidates the old read before it can clear that new draft',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset)),anchor={type:'global'};f.ctx.startDraft(anchor);f.requests[0].resolve(f.detail(f.oldAsset));await editing;await flush();
 assert.equal(f.ctx.state.productionSelected.id,f.newAsset.id);assert.equal(f.ctx.state.anchor,anchor);assert.equal(f.ctx.state.editing,null);assert.equal(f.requests.length,1);
});
test('a newer comment edit remains active when the old asset request arrives',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset)),newComment=f.comment(f.plan,'new-comment');newComment.material_scopes[0].number=2;await f.click(newComment);f.requests[0].resolve(f.detail(f.oldAsset));await editing;await flush();
 assert.equal(f.ctx.state.productionSelected.id,f.plan.id);assert.equal(f.ctx.state.editing,newComment.id);assert.equal(f.requests.length,1);
});
for(const action of ['round','card'])test(`${action} selection cancels an old material lookup`,async()=>{
 const f=setup(),data=f.ctx.state.materialReview,editing=f.click(f.comment(f.oldAsset));
 if(action==='round')f.ctx.switchMaterialRound(data,'need',2);else f.ctx.focusMaterialCommentCard('need',2);
 f.requests[0].resolve(f.detail(f.oldAsset));await editing;assert.equal(f.ctx.state.materialReview,data);assert.equal(data.selectedMaterialRounds.need,2);assert.equal(f.ctx.state.editing,null);assert.equal(f.requests.length,1);
});
test('leaving the workspace ignores the old response and does not open an editor',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset));f.ctx.state.workspace='story.sources';f.requests[0].resolve(f.detail(f.oldAsset));await editing;assert.equal(f.ctx.state.workspace,'story.sources');assert.equal(f.ctx.state.editing,null);assert.equal(f.requests.length,1);
});
for(const workspace of ['story.sources','story.outline'])test(`${workspace}: ordinary comment editing still starts immediately`,async()=>{
 const f=setup(),c=f.comment(f.plan);f.ctx.state.workspace=workspace;await f.click(c);assert.equal(f.ctx.state.editing,c.id);assert.equal(f.ctx.state.anchor,c.anchor);assert.equal(f.requests.length,0);
});

for(const kind of ['ASSET','CALL'])test(`${kind}: a recorded material card identity survives the same historical load`,async()=>{
 const f=setup(),data=f.ctx.state.materialReview;data.material_versions.other=f.rounds;data.selectedMaterialRounds.other=2;f.ctx.state.materialCommentCard={data,material_id:'other',number:2};
 const c=f.comment(kind==='ASSET'?f.oldAsset:f.oldCall);c.material_scopes.push({material_id:'other',number:1});
 const editing=f.click(c),loaded=f.detail(f.oldAsset);loaded.material_versions.other=f.rounds;loaded.selectedMaterialRounds.other=2;f.requests[0].resolve(loaded);await editing;
 assert.equal(f.ctx.state.editing,c.id);assert.equal(f.ctx.state.materialCommentCard.data,loaded);assert.equal(f.ctx.state.materialCommentCard.material_id,'other');assert.equal(loaded.selectedMaterialRounds.other,1);assert.equal(loaded.selectedMaterialRounds.need,2);assert.equal(f.requests.length,1);assert.deepEqual(f.messages,[]);
});
test('a captured material absent after loading cannot fall through to another valid scope',async()=>{
 const f=setup(),data=f.ctx.state.materialReview;data.material_versions.other=f.rounds;f.ctx.state.materialCommentCard={data,material_id:'other',number:2};
 const c=f.comment(f.oldAsset);c.material_scopes.push({material_id:'other',number:1});const editing=f.click(c);f.requests[0].resolve(f.detail(f.oldAsset));await editing;
 assert.equal(f.ctx.state.editing,null);assert.equal(f.ctx.state.materialReview.selectedMaterialRounds.need,2);assert.match(f.messages.at(-1),/无法准确定位/);
});
test('a new card choice invalidates the captured identity of an old asynchronous location',async()=>{
 const f=setup(),data=f.ctx.state.materialReview;data.material_versions.other=f.rounds;f.ctx.state.materialCommentCard={data,material_id:'other',number:2};
 const c=f.comment(f.oldAsset);c.material_scopes.push({material_id:'other',number:1});const editing=f.click(c);f.ctx.focusMaterialCommentCard('need',2);const anchor={type:'global'};f.ctx.startDraft(anchor);
 const loaded=f.detail(f.oldAsset);loaded.material_versions.other=f.rounds;f.requests[0].resolve(loaded);await editing;await flush();
 assert.equal(f.ctx.state.materialReview,data);assert.equal(f.ctx.state.materialCommentCard.data,data);assert.equal(f.ctx.state.materialCommentCard.material_id,'need');assert.equal(f.ctx.state.anchor,anchor);assert.equal(f.ctx.state.editing,null);assert.equal(f.requests.length,1);
});

test('an older failed lookup stays silent after newer navigation owns the reader',async()=>{
 const f=setup(),editing=f.click(f.comment(f.oldAsset)),newer=f.ctx.openProductionRecord(f.newAsset.object_id,f.newAsset.id);
 f.requests[1].resolve(f.detail(f.newAsset));await newer;f.requests[0].reject(Error('old lookup offline'));await editing;await flush();
 assert.equal(f.ctx.state.materialReview.record.id,f.newAsset.id);assert.equal(f.ctx.state.editing,null);assert.equal(f.requests.length,2);assert.deepEqual(f.messages,[]);
});
test('the actual material workspace and card renderer retain the explicitly located nonfirst card',async()=>{
 const f=setup(),data=f.ctx.state.materialReview;data.material_versions.other=f.rounds;f.ctx.state.materialCommentCard={data,material_id:'other',number:2};
 const c=f.comment(f.oldAsset);c.material_scopes.push({material_id:'other',number:1});const editing=f.click(c),loaded=f.detail(f.oldAsset);
 const otherPlan={...f.plan,object_id:'other',id:'other-plan',payload:{...f.plan.payload,title:'Explicit other material'}};
 loaded.material_versions.other=f.rounds.map(round=>({...round,plan:otherPlan}));f.requests[0].resolve(loaded);await editing;
 // Paint the actual workspace and card, substituting only embedded media and
 // generation details which do not decide the card or round to display.
 f.ctx.Option=function(text,value){const node=new Element('option');node.textContent=text;node.value=value;return node};
 f.ctx.materialMedia=()=>{};f.ctx.renderActualGeneration=()=>{};const root=new Element('main');f.ctx.renderMaterialWorkspace(root,loaded);
 const card=root.all().find(node=>node.className==='material-card');assert.ok(card);assert.equal(card.dataset.materialKey,'other');
 const selectedRound=card.all().find(node=>node.tag==='select');assert.equal(selectedRound.value,1);assert.ok(card.all().some(node=>node.textContent==='Explicit other material'));
 assert.equal(f.ctx.state.materialCommentCard.material_id,'other');assert.equal(f.ctx.state.editing,c.id);assert.equal(loaded.selectedMaterialRounds.need,2);
});
