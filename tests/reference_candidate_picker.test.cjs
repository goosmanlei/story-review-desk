const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const calls=[],c={state:{},URLSearchParams,crypto:require('node:crypto').webcrypto,api:async(_,options)=>{const r=JSON.parse(options.body);calls.push(r);if(c.respond)return c.respond(r);const s=session.slots.map(v=>v.index===r.index?{...v,input_key:'key-'+calls.length,candidate:r.candidate,candidate_number:r.candidate?(r.candidate.revision_id==='a'?1:2):null,value:r.candidate?{reference:r.candidate,component_id:r.component_id}:{reference:{object_id:'same-material',revision_id:'m'},selection_state:'unselected'}}:v);return {requirement_id:'consumer',revision_id:'stable',edit_token:calls.length+1,content_sha256:'hash-'+calls.length,slots:s}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../review_desk/static/reference-candidate-picker.js','utf8'),c);
 const need={object_id:'consumer',id:'stable',edit_token:1,content_sha256:'initial',payload:{generation:{inputs:[]}},review_shot_slots:[0,1].map(index=>({index,material_id:'same-material',input_key:'initial-'+index,value:{reference:{object_id:'same-material',revision_id:'m'}}}))};
 const session=c.referencePickerConsumer(need),candidate=n=>({candidate:{object_id:n,revision_id:n}}),component={id:'original'};return {c,calls,need,session,candidate,component};
}
test('same consumer queues slots against each new marker and original positions',async()=>{
 const f=fixture();await Promise.all([f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component),f.c.referencePickerSave(f.session,1,f.candidate('b'),f.component),f.c.referencePickerSave(f.session,0,f.candidate('b'),f.component)]);
 assert.deepEqual(f.calls.map(r=>r.index),[0,1,0]);assert.equal(f.calls[1].expected_content.edit_token,2);assert.equal(f.calls[2].input_key,'key-1');assert.equal(f.session.slots[0].candidate.revision_id,'b');assert.equal(f.session.slots[1].candidate.revision_id,'b');
});
test('saving the same original clears old bounds; an already whole original stays a no-op',async()=>{
 const f=fixture();f.session.slots[0]={...f.session.slots[0],candidate:{revision_id:'a'},value:{component_id:'original',range:{start_seconds:0,end_seconds:5.6}}};await f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component);assert.equal(f.calls.length,1);assert.equal(f.calls[0].preserve_bounds,undefined);assert.equal(f.session.slots[0].value.range,undefined);await f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component);assert.equal(f.calls.length,1);
});
test('failed/unknown request retains selection and operation identity on retry',async()=>{
 const f=fixture();f.c.respond=()=>{throw Error('lost response')};await assert.rejects(f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component));assert.equal(f.session.slots[0].candidate,undefined);delete f.c.respond;await f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component);assert.equal(f.calls[0].id,f.calls[1].id);
});
test('unknown response blocks a different choice until exact retry',async()=>{
 const f=fixture();f.c.respond=()=>{throw Error('offline')};await assert.rejects(f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component));await assert.rejects(f.c.referencePickerSave(f.session,1,f.candidate('b'),f.component),/原选择/);assert.equal(f.calls.length,1);
});
test('closed view still records the receipt; another consumer is untouched',async()=>{
 const f=fixture();let resolve;f.c.respond=()=>new Promise(r=>resolve=r);const other=f.c.referencePickerConsumer({...f.need,object_id:'other'});const saving=f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component);await Promise.resolve();resolve({requirement_id:'consumer',revision_id:'stable',edit_token:2,content_sha256:'new',slots:[{...f.session.slots[0],candidate:{revision_id:'a'},value:{component_id:'original'}}]});await saving;assert.equal(f.session.need.edit_token,2);assert.equal(other.need.edit_token,1);assert.equal(f.c.referencePickerConsumer(f.need),f.session);
});
test('conflict is explicit and cannot borrow another slot or consumer receipt',async()=>{
 const f=fixture();f.c.respond=()=>{const e=Error('concurrent');e.status=409;throw e};await assert.rejects(f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component));assert.equal(f.session.conflict,true);assert.equal(f.session.pending,null);
 f.session.conflict=false;f.c.respond=()=>({requirement_id:'another',slots:[{index:0}]});await assert.rejects(f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component),/不匹配/);assert.equal(f.session.need.edit_token,1);
});

test('receipt advances only matching open workspace source markers',async()=>{
 const f=fixture(),owner={object_id:'owner',id:'o',version:1},data={entity:owner,states:[],requirements:[f.need],source_signature:'old'},conflicting={...data,entity:{...owner,version:2},source_signature:'protect'};
 f.session.listeners.add({connected:()=>true,refresh(){},workspaces:[data,conflicting]});
 f.session.receipt({requirement_id:'consumer',revision_id:'stable',edit_token:2,content_sha256:'new',slots:f.session.slots,workspace_marker:{owner_id:'owner',records:[['owner','o',1],['consumer','stable',2]],source_signature:'saved'}});
 assert.equal(data.source_signature,'saved');assert.equal(conflicting.source_signature,'protect');assert.equal(f.need.version,2);
});
test('candidate summary requests are reused while failures remain retryable',async()=>{
 const f=fixture();let requests=0;f.c.api=async()=>{requests++;return {candidates:[]}};await Promise.all([f.c.referencePickerLoad('m','image'),f.c.referencePickerLoad('m','image')]);assert.equal(requests,1);await f.c.referencePickerLoad('m','image',true);assert.equal(requests,2);
});
test('receipt updates the separate deferred workspace consumer before history loads',()=>{
 const f=fixture(),own={...f.need,payload:{title:'deferred'}},data={entity:{object_id:'owner',id:'o',version:1},states:[],requirements:[own],source_signature:'old'};
 f.session.receipt({requirement_id:'consumer',revision_id:'stable',edit_token:3,content_sha256:'new',slots:f.session.slots,workspace_marker:{owner_id:'owner',records:[['owner','o',1],['consumer','stable',3]],source_signature:'fresh'}},[data]);
 assert.equal(own.version,3);assert.equal(own.edit_token,3);assert.equal(data.source_signature,'fresh');assert.equal(own.payload.title,'deferred');
});

test('a deliberate second click sends explicit clear with a new operation, then can select again',async()=>{
 const f=fixture();await f.c.referencePickerToggle(f.session,0,f.candidate('a'),f.component);
 f.session.slots[0].value.range={start_seconds:0,end_seconds:5.6};
 await f.c.referencePickerToggle(f.session,0,f.candidate('a'),f.component);
 assert.equal(f.calls[1].candidate,null);assert.notEqual(f.calls[0].id,f.calls[1].id);assert.equal(f.calls[1].component_id,undefined);assert.equal(f.session.slots[0].value.range,undefined);
 await f.c.referencePickerToggle(f.session,0,f.candidate('a'),f.component);assert.equal(f.calls[2].candidate.revision_id,'a');assert.equal(f.session.slots[0].value.range,undefined);assert.equal(f.session.slots[1].candidate,undefined);
});
test('unknown clear is retried as the same explicit clear, never as a new toggle',async()=>{
 const f=fixture();await f.c.referencePickerToggle(f.session,0,f.candidate('a'),f.component);
 f.c.respond=()=>{throw Error('lost clear response')};await assert.rejects(f.c.referencePickerToggle(f.session,0,f.candidate('a'),f.component));
 assert.equal(f.session.slots[0].candidate.revision_id,'a');delete f.c.respond;
 await f.c.referencePickerSave(f.session,0,null,null);assert.equal(f.calls[1].id,f.calls[2].id);assert.equal(f.calls[2].candidate,null);assert.equal(f.session.slots[0].candidate,null);
});
test('selected multi-original candidate clears the whole input independent of original choice',async()=>{
 const f=fixture();await f.c.referencePickerSave(f.session,0,f.candidate('a'),{id:'second'});
 await f.c.referencePickerToggle(f.session,0,f.candidate('a'),null);assert.equal(f.calls[1].candidate,null);
});

test('only the changed input receives save notifications while other input saves queue normally',async()=>{
 const f=fixture(),seen=[0,0];for(const index of [0,1])f.session.listeners.add({index,connected:()=>true,refresh:()=>seen[index]++});
 let resolve;f.c.respond=()=>new Promise(r=>resolve=r);const first=f.c.referencePickerSave(f.session,0,f.candidate('a'),f.component);await Promise.resolve();
 assert.equal(f.c.referencePickerBlocked(f.session,0),true);assert.equal(f.c.referencePickerBlocked(f.session,1),false);assert.equal(seen[1],0);
 resolve({requirement_id:'consumer',revision_id:'stable',edit_token:2,content_sha256:'two',slots:f.session.slots.map(s=>s.index?s:{...s,candidate:{revision_id:'a'},value:{component_id:'original'}})});await first;
 assert.equal(seen[1],0);assert.ok(seen[0]>1);delete f.c.respond;
 await f.c.referencePickerSave(f.session,1,f.candidate('b'),f.component);assert.ok(seen[1]>0);assert.equal(f.session.busySlots.size,0);
});
