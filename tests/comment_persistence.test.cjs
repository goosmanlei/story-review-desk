const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./comment-persistence-fixture.cjs');
const payloads=f=>f.requests.map(r=>JSON.parse(r.body));

test('same immutable plan has isolated draft and discussion choices in each material round',()=>{
  const f=fixture(),old=f.material(1),data=f.context.state.materialReview;
  f.storage.set(old,'old draft');f.storage.set(old+':discussion','true');
  f.context.switchMaterialRound(data,'need',2);f.context.state.anchor={type:'global'};
  const current=f.context.key();assert.notEqual(current,old);assert.equal(f.storage.get(current),undefined);
  f.storage.set(current,'new draft');f.context.switchMaterialRound(data,'need',1);
  assert.equal(f.context.key(),old);assert.equal(f.storage.get(old),'old draft');
  assert.equal(f.storage.get(old+':discussion'),'true');assert.equal(f.storage.get(current+':discussion'),undefined);
  f.context.switchMaterialRound(data,'need',2);f.context.abandonDraft('cancel');
  assert.equal(f.storage.get(current),undefined);assert.equal(f.storage.get(old),'old draft');
});

test('one original shared by two material cards uses the clicked card identity',()=>{
  const f=fixture();f.material();const data=f.context.state.materialReview;
  data.material_versions.other=data.material_versions.need;data.selectedMaterialRounds.other=1;
  f.context.focusMaterialCommentCard('need',1);f.context.state.anchor={type:'global'};const first=f.context.key();
  f.context.focusMaterialCommentCard('other',1);assert.equal(f.context.state.anchor,null);
  f.context.state.anchor={type:'global'};assert.notEqual(f.context.key(),first);
  assert.equal(f.context.materialCommentContext().material_id,'other');
});

test('existing comment edits and non-material drafts retain their original keys',()=>{
  const f=fixture();for(const workspace of ['story.sources','story.outline','story.script']){f.target(workspace);assert.equal(f.context.key(),f.context.legacyKey())}
  f.material(1);f.context.state.editing='comment-id';const first=f.context.key();
  f.context.state.materialReview.selectedMaterialRounds.need=2;
  assert.equal(f.context.key(),first);assert.equal(first,f.context.legacyKey());
});

test('legacy draft is shown only when present and moves only by explicit recovery without overwriting',()=>{
  const f=fixture(),key=f.material(1),legacy=f.context.legacyKey(),editor=new f.Element('section');
  f.context.appendLegacyMaterialDraft(editor,key);assert.equal(editor.children.length,0);
  f.storage.set(legacy,'unassigned old draft');f.storage.set(legacy+':discussion','true');
  f.context.appendLegacyMaterialDraft(editor,key);assert.equal(editor.children.length,1);
  assert.equal(f.storage.get(key),undefined);assert.equal(f.storage.get(legacy),'unassigned old draft');
  f.storage.set(key,'existing');assert.equal(f.context.recoverLegacyMaterialDraft(key,legacy),false);
  assert.equal(f.storage.get(key),'existing');assert.equal(f.storage.get(legacy),'unassigned old draft');
  f.storage.delete(key);assert.equal(f.context.recoverLegacyMaterialDraft(key,legacy),true);
  assert.equal(f.storage.get(key),'unassigned old draft');assert.equal(f.storage.get(key+':discussion'),'true');assert.equal(f.storage.has(legacy),false);
});

test('legacy recovery retains the original if destination storage fails',()=>{
  const f=fixture(),key=f.material(),legacy=f.context.legacyKey();f.storage.set(legacy,'only copy');f.storage.set(legacy+':discussion','true');
  const set=f.context.localStorage.setItem;f.context.localStorage.setItem=(k,v)=>{if(k.endsWith(':discussion'))throw Error('quota');set(k,v)};
  assert.throws(()=>f.context.recoverLegacyMaterialDraft(key,legacy),/quota/);assert.equal(f.storage.get(legacy),'only copy');
});

test('unchanged failed create reuses the full request ID after page refresh',async()=>{
  const first=fixture({fetch:async()=>{throw Error('lost response')}}),key=first.target();await first.context.saveComment();
  const pending=first.storage.get(key+':submission');assert.ok(pending);assert.equal(first.textarea.readOnly,false);
  const next=fixture({storage:first.storage});next.target();next.textarea.value=next.storage.get(key);await next.context.saveComment();
  assert.deepEqual(payloads(next)[0],payloads(first)[0]);assert.equal(next.storage.has(key+':submission'),false);assert.equal(next.storage.has(key),false);
});

test('changed body is a new operation while an unchanged retry keeps its ID',async()=>{
  const f=fixture({fetch:async()=>{throw Error('lost response')}});f.target();await f.context.saveComment();
  f.textarea.value='changed opinion';await f.context.saveComment();await f.context.saveComment();const rows=payloads(f);
  assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[1].body,'changed opinion');assert.equal(rows[1].id,rows[2].id);
});

test('changed anchor and material create distinct operations; comments add no revision intent',async()=>{
  const f=fixture({fetch:async()=>{throw Error('lost response')}});f.material(2);f.context.intent=f.intent;f.intent.checked=true;
  await f.context.saveComment();f.intent.checked=false;await f.context.saveComment();
  f.context.state.anchor={type:'text',quote:'other'};await f.context.saveComment();
  f.material(1,'other');await f.context.saveComment();const rows=payloads(f);
  assert.equal(new Set(rows.map(r=>r.id)).size,3);assert.equal(rows[0].id,rows[1].id);assert.equal(rows[0].material_revision,undefined);
});

test('old round reload retains the unconfirmed feedback intent after the server advanced',async()=>{
  const f=fixture({fetch:async()=>{throw Error('lost response')}});const key=f.material(1),data=f.context.state.materialReview;
  data.material_versions.need=data.material_versions.need.filter(r=>r.number===1);f.context.intent=f.intent;f.intent.checked=true;await f.context.saveComment();
  // This pending payload was written by an archived pre-plan client.
  const archived=JSON.parse(f.storage.get(key+':submission'));archived.payload.material_revision={material_id:'need',expected_round:1};f.storage.set(key+':submission',JSON.stringify(archived));f.requests[0].body=JSON.stringify({...JSON.parse(f.requests[0].body),material_revision:archived.payload.material_revision});
  const next=fixture({storage:f.storage});next.material(1);assert.equal(next.context.materialRevisionIntent(),null);
  assert.equal(next.context.commentRevisionIntent().expected_round,1);next.context.intent=next.intent;next.intent.checked=true;await next.context.saveComment();
  assert.deepEqual(payloads(next)[0],payloads(f)[0]);assert.equal(next.storage.has(key+':submission'),false);
});

test('in-flight button and shortcut calls share the lock, including intent changes',async()=>{
  let resolve;const f=fixture({fetch:()=>new Promise(r=>resolve=r)});f.material(2);f.context.intent=f.intent;f.intent.checked=true;
  const saving=f.context.saveComment();assert.equal(f.textarea.readOnly,true);assert.equal(f.intent.disabled,true);
  await f.context.saveComment();assert.equal(f.requests.length,1);resolve({ok:true,json:async()=>({})});await saving;
});

test('late success cannot clear another page draft or navigate its material context',async()=>{
  let resolve;const f=fixture({fetch:()=>new Promise(r=>resolve=r)}),old=f.material(2);f.context.intent=f.intent;f.intent.checked=true;
  const saving=f.context.saveComment();const other=f.target('story.outline','structure','outline-1');f.textarea.value='other draft';f.storage.set(other,'other draft');
  resolve({ok:true,json:async()=>({})});await saving;
  assert.equal(f.context.state.workspace,'story.outline');assert.equal(f.context.state.anchor.type,'global');assert.equal(f.storage.get(other),'other draft');assert.equal(f.context.reloads,0);assert.equal(f.storage.has(old),false);
});

test('late success cannot remove a newer draft saved by another tab',async()=>{
  let resolve;const f=fixture({fetch:()=>new Promise(r=>resolve=r)}),key=f.target();const saving=f.context.saveComment();
  f.storage.set(key,'newer tab text');f.storage.set(key+':submission',JSON.stringify({id:'newer',payload:{body:'newer tab text'}}));
  resolve({ok:true,json:async()=>({})});await saving;assert.equal(f.storage.get(key),'newer tab text');assert.equal(f.context.state.anchor.type,'global');
});
