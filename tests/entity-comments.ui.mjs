import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916';
const get=async path=>{const r=await fetch(base+'/api/v1/'+path);assert.equal(r.status,200,await r.clone().text());return r.json()};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const post=async(path,body,id=randomUUID())=>{const r=await fetch(base+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':id},body:JSON.stringify({...body,operationId:id})});return {status:r.status,data:await r.json()}};
const ok=async result=>{const r=await result;assert.equal(r.status,200,JSON.stringify(r.data));assert.notEqual(r.data.status,'FAILED',JSON.stringify(r.data));return r.data};
const save=async(id,name,type,description)=>ok(post('transactions',{commands:[{type:'save',id,kind:'ENTITY',expectedVersion:0,title:name,content:{name,type,description,authority:'A',aliases:[],evidence:[]}}]}));
const prefix='entity-check-'+randomUUID(),ids={adopted:prefix+'-adopted',current:prefix+'-current',location:prefix+'-location',candidate:prefix+'-candidate',candidateLocation:prefix+'-candidate-location'};
await save(ids.adopted,'验收同名主体','CHARACTER','已采用说明');await save(ids.current,'验收同名主体','CHARACTER','当前说明');await save(ids.location,'验收登记地点','LOCATION','地点说明');
for(const id of [ids.adopted,ids.current]){const row=await get('objects/'+id);await ok(post('transactions',{commands:[{type:'submit',id,expectedVersion:row.version},{type:'review',id,expectedVersion:row.version+1,revisionId:row.revision.id,decision:'ADOPT',explicit:true,findings:[],note:'仅隔离验收'}]}));}
let row=await get('objects/'+ids.current);await ok(post('transactions',{commands:[{type:'save',id:row.id,expectedVersion:row.version,content:{...row.revision.content,description:'当前未采用候选说明'}}]}));
let workspace=await get('workspaces/domain-workspaces?owner=SETTINGS');
const candidate=(id,name,type)=>({id,name,type,description:'已保存的候选说明',authority:'A',aliases:[],evidence:[{sourceId:'missing-fixture-source',revisionId:'missing-fixture-revision',quote:'仅有草稿摘录，原文未取得'}]});
await ok(post('workspaces/domain-workspaces',{action:'save',owner:'SETTINGS',expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,
 changes:[{collection:'entities',id:ids.candidate,beforeHash:null,value:candidate(ids.candidate,'验收保存草稿主体','CHARACTER')},{collection:'entities',id:ids.candidateLocation,beforeHash:null,value:candidate(ids.candidateLocation,'验收保存草稿地点','LOCATION')}]}));
workspace=await get('workspaces/domain-workspaces?owner=SETTINGS');
const comments=id=>get('workspaces/entity-comments?entityId='+encodeURIComponent(id));
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=settings',{waitUntil:'networkidle'});await page.locator('[data-canvas-node-id="'+ids.candidate+'"]').waitFor({state:'attached'});
 const expected=workspace.graph.entities.filter(e=>e.type!=='LOCATION').map(e=>e.id).concat(ids.candidate).sort();
 const all=()=>page.locator('.is-subject-relations [data-canvas-node-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.canvasNodeId).sort());
 assert.deepEqual(await all(),expected);
 const search=page.getByRole('textbox',{name:'搜索设定与关系'});await search.fill('验收保存草稿主体');assert.deepEqual(await all(),[ids.candidate]);await search.fill('');assert.deepEqual(await all(),expected);
 const pending=page.getByRole('checkbox',{name:'仅看待核'});await pending.check();assert(!(await all()).includes(ids.adopted));assert((await all()).includes(ids.candidate));await pending.uncheck();assert.deepEqual(await all(),expected);
 await page.getByRole('tab',{name:'空间设定',exact:true}).click();await page.getByRole('region',{name:'位置待核地点'}).getByRole('button',{name:/验收保存草稿地点/}).waitFor();
 const targetUrl=base+'/?view=settings&settingsEntity='+encodeURIComponent(ids.candidate);
 await page.goto(targetUrl,{waitUntil:'networkidle'});const widget=page.getByRole('region',{name:'实体评论'}),input=widget.getByRole('textbox',{name:'实体修改意见'});await input.waitFor();await input.fill('请把这条意见写得更明确');
 await page.getByRole('button',{name:'关闭对象详情',exact:true}).click();await page.goto(targetUrl,{waitUntil:'networkidle'});await input.waitFor();assert.equal(await input.inputValue(),'请把这条意见写得更明确');
 let polishPosts=0,dropped=false;
 await page.route('**/api/v1/workspaces/script-comments/polish',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}polishPosts++;if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');}else await route.continue();});
 await widget.getByRole('button',{name:'AI 润色修改意见',exact:true}).click();await widget.getByRole('button',{name:'查询原润色请求',exact:true}).waitFor();await page.getByRole('button',{name:'关闭对象详情',exact:true}).click();await page.goto(targetUrl,{waitUntil:'networkidle'});await widget.getByRole('button',{name:'查询原润色请求',exact:true}).click();await widget.getByRole('heading',{name:'润色建议预览',exact:true}).waitFor();assert.equal(polishPosts,1);await widget.getByText(/润色依据说明：.*UNKNOWN/).waitFor();
assert.equal(await input.inputValue(),'请把这条意见写得更明确');
 await widget.getByRole('button',{name:'应用到评论草稿',exact:true}).click();assert.match(await input.inputValue(),/controlled entity polish/);
 const beforeCandidate=await comments(ids.candidate);assert.equal(beforeCandidate.target.candidate,true);assert.equal(beforeCandidate.target.objectId,'workspace-draft:domain:SETTINGS');assert.equal(beforeCandidate.threads.length,0);
 await widget.getByRole('button',{name:'提交实体评论',exact:true}).click();await widget.getByText('评论已保存。',{exact:true}).waitFor();let saved=await comments(ids.candidate);assert.equal(saved.threads.length,1);assert.equal(saved.threads[0].target.entityId,ids.candidate);assert.equal((await comments(ids.current)).threads.length,0);
 await widget.getByRole('button',{name:'编辑评论',exact:true}).click();await input.fill('已修改的实体意见');await widget.getByRole('button',{name:'保存评论修改',exact:true}).click();await widget.getByRole('button',{name:'关闭评论',exact:true}).waitFor();
 await widget.getByRole('button',{name:'关闭评论',exact:true}).click();await widget.getByText('评论已关闭，可在下方历史查看。',{exact:true}).waitFor();await widget.getByText('已关闭评论 · 1',{exact:true}).click();await widget.getByText('已修改的实体意见',{exact:true}).waitFor();
 saved=await comments(ids.candidate);const originalTarget=saved.threads[0].target;
 workspace=await get('workspaces/domain-workspaces?owner=SETTINGS');const preview=await ok(post('workspaces/domain-workspaces',{action:'preview',owner:'SETTINGS',draftRevisionId:workspace.draft.revisionId}));await ok(post('workspaces/domain-workspaces',{action:'publish',owner:'SETTINGS',draftRevisionId:workspace.draft.revisionId,previewHash:preview.previewHash}));
 saved=await comments(ids.candidate);assert.equal(saved.target.candidate,false);assert.equal(saved.threads[0].status,'CLOSED');assert.equal(saved.threads[0].applicability,'HISTORICAL');assert.deepEqual(saved.threads[0].target,originalTarget);
 await page.reload({waitUntil:'networkidle'});await widget.getByText('已关闭评论 · 1',{exact:true}).click();await widget.getByText('已修改的实体意见',{exact:true}).waitFor();
 // Current candidate and adopted content must both reach the controlled worker.
 const current=await comments(ids.current),before=await get('objects/'+ids.current),op=randomUUID();assert(current.target.adopted);await post('workspaces/script-comments/polish',{snapshotId:current.target.snapshotId,target:current.target,commentDraft:'请润色当前候选意见'},op).then(r=>assert.equal(r.status,202,JSON.stringify(r.data)));
 for(let attempt=0;;attempt++){const operation=await get('operations/'+op);if(operation.status==='SUCCEEDED')break;assert(['QUEUED','RUNNING'].includes(operation.status),JSON.stringify(operation));assert(attempt<30);await new Promise(r=>setTimeout(r,250));}
 const polished=await get('workspaces/script-comments/polish?operationId='+op);assert.match(polished.polishedComment,/controlled entity polish/);assert.equal((await get('objects/'+ids.current)).revision.id,before.revision.id);
 const commentId=prefix+'-comment',body={action:'CREATE',entityId:ids.current,commentId,target:current.target,text:'保留原修订意见'},operationId=randomUUID();await ok(post('workspaces/entity-comments',body,operationId));await ok(post('workspaces/entity-comments',body,operationId));assert.equal((await comments(ids.current)).threads.length,1);
 await ok(post('transactions',{commands:[{type:'save',id:before.id,expectedVersion:before.version,content:{...before.revision.content,description:'另一份新草稿'}}]}));
 assert.equal((await post('workspaces/entity-comments',{...body,commentId:prefix+'-stale'})).status,409);assert.equal((await comments(ids.current)).threads[0].applicability,'HISTORICAL');
 const location=await comments(ids.location);await ok(post('workspaces/entity-comments',{action:'CREATE',entityId:ids.location,commentId:prefix+'-location-comment',target:location.target,text:'地点意见'}));assert.equal((await comments(ids.location)).threads.length,1);
 workspace=await get('workspaces/domain-workspaces?owner=SETTINGS');const originalEntity=workspace.graph.entities.find(e=>e.id===ids.current);
 await ok(post('workspaces/domain-workspaces',{action:'save',owner:'SETTINGS',expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,changes:[{collection:'entities',id:ids.current,beforeHash:workspace.ownership['entities:'+ids.current].recordHash,value:{...originalEntity,description:'基于当前主体的保存草稿'}}]}));
 const draftTarget=(await comments(ids.current)).target;assert.equal(draftTarget.candidateBasisCurrent,true);
 const changedBase=await get('objects/'+ids.current);await ok(post('transactions',{commands:[{type:'save',id:changedBase.id,expectedVersion:changedBase.version,content:{...changedBase.revision.content,description:'并发变更的实体依据'}}]}));
 assert.equal((await post('workspaces/entity-comments',{action:'CREATE',entityId:ids.current,commentId:prefix+'-stale-base',target:draftTarget,text:'不能按过期的草稿依据提交'})).status,409);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASSED',checks:['all registered and saved draft entities visible','search and pending filter reset','unplaced saved location visible','comment draft retained on close/reopen','polish preview does not change text until application','entity comments create/edit/close and history','draft confirmation preserves original comment target','controlled worker sees candidate and adopted context','idempotent comment creation and stale CAS rejection','location comments'],realModelCalls:0}));
}finally{await browser.close()}
