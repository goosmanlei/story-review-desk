const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){const c={state:{comments:[]},AbortController,Map,Set,URL,URLSearchParams,DOMException};vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/production-breakdown.js','utf8'),c);return c}
test('same pending read is shared and superseded requests receive cancellation',async()=>{
 const c=fixture(),calls=[];c.api=(path,options)=>new Promise((resolve,reject)=>{calls.push({path,resolve,signal:options.signal});options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))) });
 const first=c.readBreakdownAPI('/one'),shared=c.readBreakdownAPI('/one');assert.equal(first,shared);assert.equal(calls.length,1);
 const rejected=assert.rejects(first,{name:'AbortError'});c.cancelBreakdownReads('/two');await rejected;assert.equal(calls[0].signal.aborted,true);
 const last=c.readBreakdownAPI('/two');calls[1].resolve({exact:'last'});assert.deepEqual(await last,{exact:'last'});
});
test('fresh counting index wins over stale comments; local later edits and new exact comments still update counts',()=>{
 const c=fixture(),ep={comment_targets:[{object_id:'camera',revision_id:'r1'},{object_id:'camera',revision_id:'r1'}]};
 c.state.breakdownCommentIndex=[{id:'closed',target_object_id:'camera',target_revision_id:'r1',status:'CLOSED',version:2},{id:'deleted',target_object_id:'camera',target_revision_id:'r1',status:'DELETED',version:3}];
 c.state.comments=[{id:'deleted',target_object_id:'camera',target_revision_id:'r1',status:'OPEN',version:1},{id:'other-version',target_object_id:'camera',target_revision_id:'r2',status:'OPEN',version:1}];assert.equal(c.breakdownEpisodeCount(ep),1);
 c.state.comments.push({id:'new',target_object_id:'camera',target_revision_id:'r1',status:'OPEN',version:1});assert.equal(c.breakdownEpisodeCount(ep),2);
 c.state.comments.push({id:'closed',target_object_id:'camera',target_revision_id:'r1',status:'DELETED',version:4});assert.equal(c.breakdownEpisodeCount(ep),1);
});
function details(){const c=fixture();vm.runInContext(fs.readFileSync('review_desk/static/unified-cards.js','utf8'),c);const data=()=>({entity:{object_id:'shot',id:'shot-r1',edit_token:1},requirements:[{object_id:'need',version:1}],material_versions:{need:[]},materialContexts:{},deferred_materials:['need'],deferred_candidates:[],comment_records:[],comment_targets:[]});const result=()=>({entity:{id:'shot-r1',edit_token:1},requirements:[{object_id:'need',version:1,payload:{generation:{prompt:'exact'}}}],material_versions:{need:[{exact:true}]},materialContexts:{},comment_records:[],comment_targets:[]});return {c,data,result}}
test('same mounted scene navigation retains its in-flight detail; departing reader rejects it without mutation',async()=>{
 const {c,data,result}=details(),d=data(),card={isConnected:true};let resolve;c.api=()=>new Promise(r=>resolve=r);
 const read=c.queueShotDetail(d,'need',null,card,true);vm.runInContext('++breakdownEpoch',c);resolve([result()]);await read;assert.equal(d.requirements[0].payload.generation.prompt,'exact');
 const departed=data(),late=c.queueShotDetail(departed,'need',null,card,true),rejected=assert.rejects(late,{name:'AbortError'});c.invalidateBreakdownReads();resolve([result()]);await rejected;assert.deepEqual(departed.deferred_materials,['need']);
});
test('visible detail queue uses one request then a batch, and a failed current read can retry',async()=>{
 const {c,data,result}=details(),calls=[];c.api=(path)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}));
 const reads=[0,1,2,3].map(()=>c.queueShotDetail(data(),'need',null,{isConnected:true}));assert.equal(calls.length,1);calls[0].resolve([result()]);await reads[0];await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);assert.equal(JSON.parse(new URL(calls[1].path,'http://fixture').searchParams.get('items')).length,3);calls[1].resolve([result(),result(),result()]);await Promise.all(reads);
 const d=data(),failed=c.queueShotDetail(d,'need',null,{isConnected:true}),rejected=assert.rejects(failed,/current failure/);calls[2].reject(Error('current failure'));await rejected;assert.deepEqual(d.deferred_materials,['need']);const retry=c.queueShotDetail(d,'need',null,{isConnected:true});calls[3].resolve([result()]);await retry;assert.equal(d.deferred_materials.length,0);
});
