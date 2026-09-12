import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
import {workOnce} from '../server/jobs.mjs';
import {originalReady} from './original-readiness.mjs';
assert(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913',get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert(r.ok);return r.json();};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
const id='assistant-ui:'+crypto.randomUUID();
const created=await fetch(base+'/api/v1/transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify({operationId:crypto.randomUUID(),commands:[{type:'save',id,kind:'ENTITY',expectedVersion:0,title:'助手修改预览验收主体',content:{name:'助手修改预览验收主体',type:'CHARACTER',description:'修改前的隔离主体说明',aliases:[]}}]})});assert.equal((await created.json()).status,'SUCCEEDED');
const heartbeat=()=>pool.query("INSERT INTO runtime_status(name,value,updated_at) VALUES('worker',$1,now()) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[{workerId:'controlled-assistant-browser',capabilities:['AI_SUGGEST']}]);
await heartbeat();const timer=setInterval(()=>void heartbeat(),5000),browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=settings&settingsEntity='+encodeURIComponent(id));await originalReady(page,'settings');
 await page.getByRole('button',{name:'项目 Codex',exact:true}).click();const dock=page.getByRole('complementary',{name:'项目 Codex 工作助手'});
 await dock.getByRole('button',{name:'执行',exact:true}).click();await dock.getByRole('textbox').fill('请完善当前主体说明，先展示修改预览');
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/assistant/conversations'));
 await dock.getByRole('button',{name:'发送',exact:true}).click();const queued=await(await response).json();assert.equal(queued.status,'QUEUED',JSON.stringify(queued));
 let called=0;await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'controlled-assistant-browser',providers:{suggest:async({object})=>{called++;assert.equal(object.id,id);return {summary:'隔离模拟：请核对本次档案修改。',patch:{description:'通过原版助手预览后保存的隔离说明'},sourceVersions:[]};}}});assert.equal(called,1);
 await dock.getByText('修改预览 · 助手修改预览验收主体',{exact:true}).click();await dock.getByText('修改前的隔离主体说明',{exact:true}).waitFor();await dock.getByText('通过原版助手预览后保存的隔离说明',{exact:true}).waitFor();
 assert.equal((await get('objects/'+encodeURIComponent(id))).version,1);
 await dock.getByRole('button',{name:'确认保存为草稿',exact:true}).click();await dock.getByRole('button',{name:'已保存草稿',exact:true}).waitFor();
 const object=await get('objects/'+encodeURIComponent(id));assert.equal(object.version,2);assert.equal(object.state,'DRAFT');assert.equal(object.adoptedRevisionId,null);assert.equal(object.revision.content.description,'通过原版助手预览后保存的隔离说明');assert.deepEqual(errors,[]);
 console.log('PASS original assistant mode selection, context, queued mock, readable change preview and explicit draft application through the browser');
}finally{clearInterval(timer);await browser.close();await pool.query("DELETE FROM runtime_status WHERE name='worker' AND value->>'workerId'='controlled-assistant-browser'");await closeDatabase();}
