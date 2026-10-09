const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){const c={state:{comments:[]},productionLabels:{},URL,URLSearchParams,location:{href:"http://fixture/?workspace=settings.workspace&production_tab=breakdown"}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);return c}
test('historical shot reads its hydrated exact demand and inputs instead of the identity current plan',()=>{
 const c=fixture(),seen=[];
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),c);
 c.el=()=>({append(){},dataset:{}});c.preserveBreakdownDetailPosition=()=>{};c.nodeText=(_t,_c,text)=>seen.push(text);
 c.productionRef=r=>({object_id:r.object_id,revision_id:r.id});c.materialCandidateChoice=()=>null;c.materialDefaultCandidate=()=>null;
 c.renderProductionAcceptance=(_host,row)=>seen.push(row.id);c.materialRoundControl=()=>{};
 c.renderHistoricalProductionDefinition=(_host,row)=>seen.push(row.id);c.renderMaterialRequirements=(_host,row)=>seen.push(row.payload.generation.prompt);
 c.materialTextSurface=(_host,row)=>{seen.push(row.id);return {}};c.materialExecution=c.materialParameters=()=>{};
 c.renderMaterialInputs=(_host,_inputs,rows)=>seen.push(rows[0].id);c.renderMaterialRouteChoices=()=>assert.fail('old reading must not expose route writes');
 c.renderLinkedPrompt=(_host,row,_inputs,_rows,_field,context)=>{assert.equal(context,null);seen.push(row.payload.generation.prompt)};
 const exact={id:'old',object_id:'video',kind:'REQUIREMENT',current_revision:'now',payload:{media_type:'video',generation:{prompt:'old start to old end',inputs:[]}},review_input_records:[{id:'old-frame'}]},now={...exact,id:'now',payload:{...exact.payload,generation:{prompt:'wrong current start'}}};
 const metadata={...exact,payload:{media_type:'video'}},round={number:1,plan:now,definition_records:{requirement:now},results:[]};
 c.breakdownPrompt({append(){}},metadata,{video_details:{video:{record:exact,history:[now,exact],material_versions:{video:[round]}}}});
 assert.ok(seen.includes('old start to old end'));assert.ok(seen.includes('old-frame'));assert.ok(!seen.includes('wrong current start'));assert.ok(!seen.includes('now'));
});
test('shared shot renderer retains exact background and material trace while changes and selected inputs stay visible',()=>{
  const c=fixture();
  class E {constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.classList={add(){}}}append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=nodes}}
  c.el=tag=>new E(tag);c.nodeText=(tag,_class,text,parent)=>{const n=new E(tag);n.text=text;parent.append(n);return n};
  c.breakdownShotTitle=()=> 'shot';c.businessTitle=row=>row.object_id;
  c.renderAudiovisualSources=c.renderProductionAcceptance=()=>{};
  c.breakdownShotText=host=>c.nodeText('p',null,'米尚未交付，袋子仍在画外',host);
  c.renderShotDemands=host=>c.nodeText('p',null,'本方案直接输入',host);
  c.materialReferenceLink=(host,ref)=>{const n=new E('a');n.reference=ref;host.append(n)};
  c.materialSmallCard=(host,item)=>{const n=new E('card');n.id=item.object_id;host.append(n);return n};
  const ref=(id,version)=>({object_id:id,revision_id:version}),from=ref('prop','before'),to=ref('prop','after'),background=ref('bag','historical');
  const parent=new E('main');
  c.renderBreakdownShot(parent,{record:{object_id:'shot',id:'exact-shot',payload:{fps:24,duration_frames:120,states:[from,to],continuity_context:[background],state_transitions:[{from,to,action:'接过后才掰角'}]}},context:{materials:[{object_id:'material',media_type:'image'}]}});
  const copy=parent.children[0].children[0],trace=copy.children.find(n=>n.tag==='details');
  assert.ok(trace);assert.equal(trace.open,undefined,'trace is closed by default');
  assert.ok(copy.children.some(n=>n.children.some(v=>v.text==='米尚未交付，袋子仍在画外')));
  assert.ok(copy.children.some(n=>n.text==='本方案直接输入'));
  const changes=copy.children.find(n=>n.children.some(v=>v.text==='本镜状态变化'));
  assert.ok(changes.children.some(n=>n.children.some(v=>v.text==='接过后才掰角')));
  assert.deepEqual(trace.children.filter(n=>n.reference).map(n=>n.reference),[from,to,background]);
  const materials=trace.children.find(n=>n.tag==='aside');assert.ok(materials);
  assert.ok(materials.children.some(n=>n.children.some(v=>v.id==='material')));
  assert.equal(parent.children[0].children.length,1,'same material cards are not repeated beside the shot');
});
test('project handoff exposes the selected original and its exact requirements without borrowing another version',()=>{
  for(const historical of [false,true]){
    const c=fixture(),seen=[];c.el=()=>({append(){},dataset:{}});c.preserveBreakdownDetailPosition=()=>{};c.nodeText=(_t,_c,text)=>seen.push(text);
    for(const name of ['renderProductionAcceptance','materialRoundControl','reviewChoiceButtons'])c[name]=()=>{};
    c.productionRef=r=>({object_id:r.object_id,revision_id:r.id});c.materialDefaultCandidate=()=>null;c.materialCandidateChoice=items=>items[0];
    c.materialMedia=(_host,item)=>seen.push(item.component.file);c.renderActualGeneration=(_host,context)=>seen.push(context.call.id);
    c.renderMaterialRequirements=(_host,need)=>seen.push(need.id);
    const need={id:'current-demand',object_id:'project',payload:{media_type:'project'}},asset={id:'exact-asset',payload:{components:[{role:'original',file:'exact.zip'}]}},exact={...need,id:'bound-demand'};
    const round={number:1,results:[asset],definition_records:{requirement:historical?null:exact}};
    c.breakdownPrompt({append(){}},need,{video_details:{project:{material_versions:{project:[round]},review_contexts:{'exact-asset':{call:{id:'actual-edit'}}}}}});
    assert.ok(seen.includes('exact.zip'));assert.ok(seen.includes('actual-edit'));assert.ok(!seen.includes('current-demand'));
    assert.equal(seen.includes('bound-demand'),!historical);assert.equal(seen.includes('此版本未保留完整素材要求。'),historical);
  }
});
test('episode count deduplicates comment ids, includes closed and uses exact view revisions only',()=>{const c=fixture(),ep={comment_targets:[{object_id:'scene',revision_id:'old'},{object_id:'shot',revision_id:'same'},{object_id:'shot',revision_id:'same'}]};c.state.comments=[{id:'1',status:'OPEN',target_object_id:'scene',target_revision_id:'old'},{id:'1',status:'OPEN',target_object_id:'scene',target_revision_id:'old'},{id:'2',status:'CLOSED',target_object_id:'shot',target_revision_id:'same'},{id:'3',status:'DELETED',target_object_id:'shot',target_revision_id:'same'},{id:'4',status:'OPEN',target_object_id:'scene',target_revision_id:'new'},{id:'5',status:'OPEN',target_object_id:'episode',target_revision_id:'old'}];assert.equal(c.breakdownEpisodeCount(ep),2);c.state.comments[0].body='edited';assert.equal(c.breakdownEpisodeCount(ep),2);c.state.comments[2].status='OPEN';assert.equal(c.breakdownEpisodeCount(ep),2)});
test('grouping partitions exactly the explicitly related canonical identities regardless of obsolete owner filter',()=>{const c=fixture();c.state.breakdownLevels=['shot'];const items=[{object_id:'a',canonical_material_id:'one',classification:{key:'image:character',label:'图像—角色'}},{object_id:'alias',canonical_material_id:'one',classification:{key:'image:character',label:'图像—角色'}},{object_id:'shared',classification:{key:'audio:shared',label:'音频—共有'}},{object_id:'missing',media_type:'video'}];const groups=c.groupedShotMaterials(items);assert.equal(groups.length,3);assert.deepEqual(Array.from(groups.flatMap(g=>g.items),i=>i.canonical_material_id||i.object_id).sort(),['missing','one','shared']);assert.equal(c.groupedShotMaterials([]).length,0)});
test('late scene response cannot repaint after a later selection or workspace switch',async()=>{
  for(const change of ["++breakdownSelectionEpoch","state.workspace='story.script'"]){
    const c=fixture();c.state.workspace='settings.workspace';c.state.breakdownData={shots:[]};let finish;
    c.api=()=>new Promise(resolve=>{finish=resolve});let writes=0;
    const pending=c.showBreakdownScene({object_id:'scene-old',id:'old'},{replaceChildren(){writes++}},null,0);
    vm.runInContext(change,c);finish({scene:{},shots:[]});await pending;assert.equal(writes,0);
  }
});
test('same-scene navigation only reuses the reader for the same accurate material route',()=>{
  const c=fixture(),base=new URLSearchParams('breakdown_object=shot-a&shot_material_id=video&shot_plan=2&shot_candidate=c2');
  const anotherShot=new URLSearchParams(base);anotherShot.set('breakdown_object','shot-b');
  assert.equal(c.breakdownSelectionKey(base),c.breakdownSelectionKey(anotherShot));
  for(const [key,value] of [['shot_plan','1'],['shot_candidate','c1'],['production_revision','old'],['material_target','exact']]){
    const other=new URLSearchParams(base);other.set(key,value);assert.notEqual(c.breakdownSelectionKey(base),c.breakdownSelectionKey(other));
  }
});
test('returning to a shot restores only a draft on a displayed exact Prompt revision',()=>{
  const c=fixture();c.productionTab=()=> 'shots';let focused=0;
  const surface={dataset:{productionBlocks:'plan-v2'},reviewFocus(){focused++}};
  const row={querySelectorAll:()=>[surface]};
  c.localStorage={getItem:key=>key==='kept-body'?'unsent text':null};
  c.state.productionDraftContexts={
    '["plan-v2",null,null,null]':{anchor:{quote:'exact'},draftKey:'kept-body'},
    '["other-shot",null,null,null]':{anchor:{quote:'other'},draftKey:'kept-body'},
    '["plan-v1",null,null,null]':{anchor:{quote:'old'},draftKey:'kept-body'}
  };
  c.restoreBreakdownPromptDraft(row);assert.equal(focused,1);
  surface.dataset.productionBlocks='plan-v3';c.restoreBreakdownPromptDraft(row);assert.equal(focused,1);
  surface.dataset.productionBlocks='plan-v2';c.localStorage.getItem=()=>null;c.restoreBreakdownPromptDraft(row);assert.equal(focused,1);
  c.productionTab=()=> 'breakdown';c.localStorage.getItem=()=> 'text';c.restoreBreakdownPromptDraft(row);assert.equal(focused,2);
});
test('clicking the mounted episode again supersedes an in-flight episode switch',async()=>{
  const c=fixture(),requests=[],pending=[];
  class E {
    constructor(){this.children=[];this.dataset={};this.scrollTop=0;this.scrollLeft=0}
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    querySelector(){return null}
    setAttribute(){}
    remove(){}
  }
  const host=new E();c.state.workspace='settings.workspace';
  c.document={querySelector:()=>null};c.$=()=>host;c.el=()=>new E();
  c.nodeText=(_tag,_class,text,parent)=>{const n=new E();n.textContent=text;parent.append(n);return n};
  c.history={state:null,pushState(_state,_title,url){c.location.href=String(url)},replaceState(_state,_title,url){c.location.href=String(url)}};
  c.rememberProductionDraft=()=>{};c.toast=error=>assert.fail(error);
  c.renderEpisodeCard=(parent,ep,_active,_count,onclick)=>parent.append({id:ep.object_id,onclick});
  const data=episode=>({episode,episodes:[{object_id:'e1'},{object_id:'e2'}],scenes:[],shots:[]});
  c.api=url=>{const episode=new URL(url,'http://fixture').searchParams.get('episode')||'e1';requests.push(episode);return requests.length===1?Promise.resolve(data(episode)):new Promise(resolve=>pending.push({episode,resolve}))};
  vm.runInContext('let productionLoadEpoch=0,productionReadEpoch=0',c);
  c.location.href+='&breakdown_episode=e1';await c.loadProductionBreakdown();
  const mounted=host.children[0].children;
  mounted.find(ep=>ep.id==='e1').onclick();assert.equal(requests.length,1,'settled active episode remains a no-op');
  mounted.find(ep=>ep.id==='e2').onclick();
  mounted.find(ep=>ep.id==='e1').onclick();
  assert.deepEqual(requests,['e1','e2','e1'],'last click is an explicit navigation even while the old episode stays mounted');
  pending[1].resolve(data('e1'));await new Promise(resolve=>setImmediate(resolve));
  pending[0].resolve(data('e2'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.state.breakdownData.episode,'e1','late response cannot replace the last selected episode');
  assert.equal(new URL(c.location.href).searchParams.get('breakdown_episode'),'e1');
});
