import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';

assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916';
const response=await fetch(base+'/api/v1/workspaces/domain-workspaces?owner=SETTINGS');
assert.equal(response.status,200,await response.clone().text());
const original=await response.json(),controlled=structuredClone(original);
const first=controlled.graph.entities.find(entity=>entity.type!=='LOCATION');
const location=controlled.graph.entities.find(entity=>entity.type==='LOCATION');
assert.ok(first&&location,'controlled fixture requires one subject and one location');

const second={...first,id:'entity-reference-missing',name:'信息待补主体',aliases:[],description:'用于验证缺失参考信息的受控主体',authority:'U',evidence:[]};
const sourceRevision='source-revision-controlled',sourceSha='a'.repeat(64),draftRevision='settings-draft-controlled',adoptedRevision='entity-adopted-controlled',scopeRevision='scope-revision-controlled';
const draftFirst={...first,aliases:['受控别名'],authority:'F',dimensions:{subjectDimension:'主体维度值'},scope:[{scopeType:'SCENE',scopeId:'scene-reference-controlled',revisionId:scopeRevision}],evidence:[{sourceId:'source-controlled',revisionId:sourceRevision,sha256:sourceSha,quote:'受控来源引文可直接审阅。',locator:'受控资料第 3 段'}]};
const locationWithDimensions={...location,dimensions:{locationDimension:'空间维度值'}};
controlled.graph.entities=[...controlled.graph.entities.filter(entity=>entity.id!==first.id&&entity.id!==second.id&&entity.id!==location.id),first,second,locationWithDimensions];
controlled.graph.relations=[...controlled.graph.relations.filter(relation=>relation.id!=='relation-reference-controlled'),{id:'relation-reference-controlled',type:controlled.configuration.relationTypes[0]?.id||'REFERENCE',from:{kind:'ENTITY',id:first.id},to:{kind:'ENTITY',id:second.id},label:'受控相邻关系',purpose:'验证主体卡切换',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'CONFIRMED'}];
controlled.ownership['entities:'+first.id]={...(controlled.ownership['entities:'+first.id]||{}),owner:'SETTINGS',reason:'受控登记说明',recordHash:'record-first-controlled',revisionId:'entity-current-controlled',state:'ADOPTED',adoptedRevisionId:adoptedRevision};
controlled.ownership['entities:'+second.id]={owner:'SETTINGS',reason:'',recordHash:'record-second-controlled',state:'DRAFT',adoptedRevisionId:null};
controlled.draft={revisionId:draftRevision,baseReleaseId:controlled.releaseId,changes:[{collection:'entities',id:first.id,beforeHash:controlled.ownership['entities:'+first.id].recordHash,value:draftFirst}]};
controlled.draftHeadRevisionId=draftRevision;
controlled.readOnly=false;

const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],writes=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/'))writes.push(request.url());});
 await page.route(url=>url.pathname==='/api/v1/workspaces/domain-workspaces'&&url.searchParams.get('owner')==='SETTINGS',route=>route.fulfill({json:controlled}));
 await page.route(url=>url.pathname==='/api/v1/workspaces/entity-comments',route=>{
  const entityId=new URL(route.request().url()).searchParams.get('entityId'),isFirst=entityId===first.id;
  return route.fulfill({json:{target:{kind:'ENTITY_SETTING',entityId,objectId:entityId,revisionId:isFirst?draftRevision:'comments-basis-unknown',expectedVersion:1,contentHash:'controlled-content-hash',snapshotId:controlled.snapshotId,label:isFirst?draftFirst.name:second.name,includeDraft:true,candidate:isFirst,state:isFirst?'DRAFT':'UNKNOWN',basisLabel:isFirst?'已保存草稿':'当前依据待核',adopted:isFirst?{revisionId:adoptedRevision,content:{name:first.name,description:first.description}}:null},threads:[]}});
 });

 await page.goto(base+'/?view=settings&settingsEntity='+encodeURIComponent(first.id),{waitUntil:'networkidle'});
 const dialog=page.getByRole('dialog'),local=dialog.getByRole('region',{name:'主体与素材局部关系',exact:true});
 await local.waitFor();
 let readable=local.locator('details.board-readable-list');
 assert.equal(await readable.evaluate(element=>element.open),true,'subject relationship list opens initially');
 assert.ok((await readable.innerText()).includes('受控相邻关系'));
 await readable.locator('summary').click();
 assert.equal(await readable.evaluate(element=>element.open),false,'subject relationship list can collapse');
 await readable.locator('summary').click();
 assert.equal(await readable.evaluate(element=>element.open),true,'subject relationship list can reopen');

 let reference=dialog.getByRole('region',{name:'当前审阅参考',exact:true});
 const referenceText=await reference.innerText();
 for(const text of ['来源事实','受控别名','范围类型：场次（SCENE）','范围身份：scene-reference-controlled','适用修订：'+scopeRevision,'subjectDimension','主体维度值',draftRevision,'已保存草稿 · 尚未确认',adoptedRevision,'当前正式采用','受控来源引文可直接审阅。','来源定位：受控资料第 3 段'])assert.ok(referenceText.includes(text),`direct reference includes ${text}`);
 assert.equal(referenceText.includes(sourceRevision),false,'raw source revision stays out of direct review reference');
 assert.equal(referenceText.includes(sourceSha),false,'SHA stays out of direct review reference');
 const technical=reference.locator('details[aria-label="技术追溯详情"]');
 assert.equal(await technical.evaluate(element=>element.open),false,'technical trace stays collapsed');
 await technical.locator('summary').click();
 const technicalText=await technical.innerText();
 for(const text of [first.id,'entity-current-controlled',draftRevision,'source-controlled',sourceRevision,sourceSha])assert.ok(technicalText.includes(text),`technical trace retains ${text}`);

 const comment=dialog.getByRole('textbox',{name:'实体修改意见',exact:true});
 await comment.fill('尚未提交的受控主体意见');
 await readable.locator('summary').click();
 assert.equal(await readable.evaluate(element=>element.open),false);
 await local.locator(`[data-canvas-node-id="${second.id}"]`).click();
 await page.waitForFunction(id=>new URL(location.href).searchParams.get('settingsEntity')===id,second.id);
 const secondLocal=dialog.getByRole('region',{name:'主体与素材局部关系',exact:true}),secondReadable=secondLocal.locator('details.board-readable-list');
 await secondReadable.waitFor();
 assert.equal(await secondReadable.evaluate(element=>element.open),true,'switching subject resets the list to open');
 reference=dialog.getByRole('region',{name:'当前审阅参考',exact:true});
 const missingText=await reference.innerText();
 for(const text of ['待核依据','未登记别名','项目设定 · 场次适用性未确认','UNKNOWN','修订 UNKNOWN','尚未采用','来源依据尚未登记。'])assert.ok(missingText.includes(text),`missing reference states ${text}`);
 assert.equal(new URL(page.url()).searchParams.get('settingsEntity'),second.id);

 await secondLocal.locator(`[data-canvas-node-id="${first.id}"]`).click();
 await page.waitForFunction(id=>new URL(location.href).searchParams.get('settingsEntity')===id,first.id);
 readable=dialog.getByRole('region',{name:'主体与素材局部关系',exact:true}).locator('details.board-readable-list');
 assert.equal(await readable.evaluate(element=>element.open),true,'returning to a subject starts from the default open state');
 assert.equal(await dialog.getByRole('textbox',{name:'实体修改意见',exact:true}).inputValue(),'尚未提交的受控主体意见','entity switch retains unsaved comment');

 await dialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 assert.equal(new URL(page.url()).searchParams.has('settingsEntity'),false,'close clears the entity deep link');
 assert.equal(await dialog.count(),0);
 await page.goBack();
 await dialog.waitFor();
 assert.equal(new URL(page.url()).searchParams.get('settingsEntity'),first.id,'browser history restores the exact entity deep link');
 assert.equal(await dialog.getByRole('textbox',{name:'实体修改意见',exact:true}).inputValue(),'尚未提交的受控主体意见');
 await dialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();

 await page.getByRole('tab',{name:'空间设定',exact:true}).click();
 await page.getByRole('region',{name:'位置待核地点'}).getByRole('button',{name:new RegExp(location.name)}).click();
 const locationDialog=page.getByRole('dialog'),locationReadable=locationDialog.getByRole('region',{name:'主体与素材局部关系',exact:true}).locator('details.board-readable-list');
 await locationReadable.waitFor();
 assert.equal(await locationReadable.evaluate(element=>element.open),false,'space card keeps its previous collapsed list behavior');
 assert.equal(await locationDialog.getByRole('region',{name:'当前审阅参考',exact:true}).count(),0,'subject reference layout does not alter space cards');
 await locationDialog.locator('details.settings-evidence').locator('summary').click();
 assert.ok((await locationDialog.locator('details.settings-evidence').innerText()).includes('空间维度值'),'space card retains its original dimensions');
 await locationDialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();

 await page.goto(base+'/?view=settings&settingsRelation=relation-reference-controlled');
 const relationDialog=page.getByRole('dialog');
 await relationDialog.getByRole('heading',{name:'受控相邻关系',exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('settingsRelation'),'relation-reference-controlled','registered relationship deep link opens exactly');
 await relationDialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 assert.equal(new URL(page.url()).searchParams.has('settingsRelation'),false,'closing relationship detail clears its deep link');
 await page.goBack();
 await relationDialog.getByRole('heading',{name:'受控相邻关系',exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('settingsRelation'),'relation-reference-controlled','history restores relationship deep link');

 assert.deepEqual(writes,[]);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'PASS',checks:['subject list default open through explicit property','manual collapse and reopen','entity switch resets list','direct aliases authority precise scope revisions dimensions and evidence','missing fields explicit','technical trace collapsed with raw IDs and SHA','entity and relationship deep link close and history','unsaved comment retained','space card dimensions and collapsed list unchanged','zero business POST']}));
}finally{await browser.close();}
