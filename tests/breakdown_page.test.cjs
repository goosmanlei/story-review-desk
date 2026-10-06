const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){const c={state:{comments:[]},productionLabels:{},URL,URLSearchParams};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);return c}
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
  c.productionTab=()=> 'breakdown';c.restoreBreakdownPromptDraft(row);assert.equal(focused,1);
});
