import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {blankProfile} from '../host/instance-runtime/blank.mjs';

const site=fileURLToPath(new URL('../',import.meta.url));
const workflow=defaultConfiguration(blankProfile({instanceId:'four-stage-fixture',title:'四阶段回归',projectId:'four-stage-story'})).workflow;
function preparation(readOnly=false){
 const episodes=[{episodeUid:'episode-first',displayId:'E01',title:'门外',sceneIds:['scene-first']},{episodeUid:'episode-second',displayId:'E02',title:'门内',sceneIds:['scene-second']}];
 const scenes=episodes.map((ep,i)=>({episodeUid:ep.episodeUid,sceneId:ep.sceneIds[0],displayId:'S01',sceneContentHash:String(i+1).repeat(64),sourceSummary:{title:i?'开门相见':'门外等待'},preparation:{sceneRole:i?'第二集独有作用':'第一集独有作用',audienceTakeaway:'只知道此刻可见的信息',sourceDialogue:[{scriptBlockId:ep.sceneIds[0]+'-B01',text:'完整冻结对白',speaker:'访客'}],beats:[{visualIntent:'保持门扇方向',adoptedAssetBindings:[],mediaObserved:'UNKNOWN'}],entityStateRequirements:[{entityName:'访客',description:'站在门外',canonicalEntityId:null,stateId:null,bindingStatus:'UNBOUND_PROPOSAL'}],reviewFocus:['不得凭准备稿补造镜头'],nextPreparationAction:'核对动作与视线',generationAuthorized:false,formalShotIds:[]}}));
 return {releaseId:'four-release',revisionId:'four-prep-r1',readOnly,stale:false,comments:[{sceneId:'scene-first',text:'原修订的精确场意见',revisionId:'comment-history-1',preparationRevisionId:'four-prep-old'}],content:{basis:{candidateRevisionId:'four-candidate',candidateContentHash:'c'.repeat(64)},episodes,scenes},candidate:{revisionId:'four-candidate',contentHash:'c'.repeat(64),episodes,scenes:scenes.map(s=>({id:s.sceneId,displayId:s.displayId,title:s.sourceSummary.title}))}};
}
let bundle:{js:string;css:string}|undefined;
async function fixture(page:Page,{readonly=false,conflict=false,query=''}={}){
 if(!bundle){
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{ProductionPreparationWorkspace}from'./app/production-preparation-workspace';const workflow=${JSON.stringify(workflow)};function App(){return <main className="test-preparation-root"><ProductionPreparationWorkspace workflow={workflow} onStageChange={(phaseId,gateId,creatorStageId,context)=>{const url=new URL(location.href);url.searchParams.set('creatorStage',creatorStageId.toLowerCase().replaceAll('_','-'));url.searchParams.set('productionPhase',phaseId.toLowerCase().replaceAll('_','-'));url.searchParams.set('productionGate',gateId.toLowerCase().replaceAll('_','-'));if(context){url.searchParams.set('preparationEpisode',context.episodeUid);if(context.navigationScopeType==='SCENE'&&context.sceneId)url.searchParams.set('preparationScene',context.sceneId);else{url.searchParams.delete('preparationScene');url.searchParams.delete('scene');}}history.pushState(history.state,'',url);}} renderStage={context=><section aria-label="精确正式工作区接口"><output data-stage-context>{JSON.stringify(context)}</output><p>正式工作区仍须自行核对实际对象；此回归不创建正式对象。</p></section>}/></main>}createRoot(document.getElementById('root')).render(<App/>);`;
  const files=buildSync({stdin:{contents:entry,resolveDir:site,sourcefile:'preparation-four-stage-harness.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,outdir:'virtual-preparation-bundle',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles;
  bundle={js:files.find(f=>f.path.endsWith('.js'))!.text,css:files.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n')};
 }
 const prep=preparation(readonly),result={prep,errors:[] as string[],unexpected:[] as string[],writes:[] as Record<string,unknown>[]};
 page.on('pageerror',e=>result.errors.push(e.message));
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());if(url.pathname==='/api/v8/operations/snapshot'&&req.method()==='GET')return route.fulfill({json:{mutationEtag:'"four-stage-fixture"'}});if(url.pathname==='/api/instance/production-preparation'){if(req.method()==='GET')return route.fulfill({json:prep});result.writes.push(req.postDataJSON());return route.fulfill({status:readonly?405:conflict?409:200,json:readonly?{error:'READ_ONLY'}:conflict?{error:'CAS_CONFLICT: 保留原稿'}:{saved:true}});}result.unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});});
 const css=readFileSync(path.join(site,'app/globals.css'),'utf8')+'\n'+bundle.css+'\n.test-preparation-root{max-width:1500px;margin:auto;padding:24px;box-sizing:border-box}[data-stage-context]{display:block;overflow-wrap:anywhere}';
 await page.route('**/__preparation-four-stage*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><script>'+bundle!.js.replaceAll('</script','<\\/script')+'</script></body></html>'}));
 await page.goto('/__preparation-four-stage?view=pipeline'+(query?'&'+query:''));return result;
}
const stage=(page:Page,id:string)=>page.locator('[data-creator-stage="'+id+'"]');
const episode=(page:Page,id:string)=>page.locator('[data-preparation-episode="'+id+'"]');
async function context(page:Page){await expect(page.locator('[data-stage-context]')).toBeVisible();return JSON.parse(await page.locator('[data-stage-context]').innerText());}
function clean(f:Awaited<ReturnType<typeof fixture>>){expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);}

test('四阶段并列与永久集chips取代五阶段平铺，前三阶段共用左场右工作区',async({page})=>{
 const f=await fixture(page);await expect(page.getByRole('navigation',{name:'全剧制作四阶段'}).getByRole('button')).toHaveText(['01镜头拆解','02镜头生成','03场景剪辑','04分集成片']);
 await episode(page,'episode-second').click();await expect(page.locator('[data-preparation-scene="scene-second"]')).toHaveAttribute('aria-current','location');await expect(page.getByText('第二集独有作用',{exact:true})).toBeVisible();
 await stage(page,'SHOT_GENERATION').click();expect(await context(page)).toMatchObject({creatorStageId:'SHOT_GENERATION',navigationScopeType:'SCENE',scopeType:'SHOT',episodeUid:'episode-second',sceneId:'scene-second',gateId:'STORYBOARD_DIALOGUE'});
 await expect(page.locator('.production-flow-phases,.production-flow-gates,.production-context-bar,.production-context-readiness')).toHaveCount(0);
 const checks=page.locator('.preparation-stage-checks').first();await expect(checks).not.toHaveAttribute('open','');await checks.locator('summary').click();await expect(checks.locator('[data-production-check]')).toHaveCount(5);
 const [left,right]=await Promise.all([page.locator('.preparation-scene-directory').boundingBox(),page.locator('.preparation-stage-workspace').boundingBox()]);expect(right!.x).toBeGreaterThan(left!.x+left!.width);clean(f);
});

test('分集成片全宽不携带场，导出检查保持PROJECT而非所选EPISODE的通过',async({page})=>{
 const f=await fixture(page,{query:'preparationEpisode=episode-second&preparationScene=scene-second'});await stage(page,'EPISODE_EDIT').click();
 let c=await context(page);expect(c).toMatchObject({creatorStageId:'EPISODE_EDIT',navigationScopeType:'EPISODE',scopeType:'EPISODE',episodeUid:'episode-second',gateId:'EPISODE_ASSEMBLY'});expect(c).not.toHaveProperty('sceneId');
 await expect(page.getByRole('navigation',{name:'制作上下文场次'})).toHaveCount(0);expect(new URL(page.url()).searchParams.has('preparationScene')).toBe(false);expect(new URL(page.url()).searchParams.has('scene')).toBe(false);await expect(page.locator('.preparation-stage-layout')).toHaveClass(/is-episode/);
 await episode(page,'episode-first').click();expect(await context(page)).toMatchObject({episodeUid:'episode-first'});expect(await context(page)).not.toHaveProperty('sceneId');
 const exports=page.locator('.preparation-export-checks');await exports.locator('summary').click();await exports.locator('[data-production-check="SERIES_CONTINUITY"]').click();
 c=await context(page);expect(c).toMatchObject({navigationScopeType:'PROJECT',scopeType:'PROJECT',episodeUid:'episode-first',gateId:'SERIES_CONTINUITY',phaseId:'SERIES_DELIVERY'});expect(c).not.toHaveProperty('sceneId');await expect(exports).toContainText('不作为所选分集的通过或采用');
 await page.reload();expect(await context(page)).toMatchObject({scopeType:'PROJECT',gateId:'SERIES_CONTINUITY'});expect(await context(page)).not.toHaveProperty('sceneId');
 await page.goBack();expect(await context(page)).toMatchObject({scopeType:'EPISODE',gateId:'EPISODE_ASSEMBLY',episodeUid:'episode-first'});clean(f);
});

test('精确检查深链跨原phase保留真实SHOT与SCENE作用域',async({page})=>{
 const f=await fixture(page,{query:'productionGate=keyframes&preparationEpisode=episode-second&preparationScene=scene-second'});
 expect(await context(page)).toMatchObject({creatorStageId:'SHOT_GENERATION',scopeType:'SHOT',navigationScopeType:'SCENE',gateId:'KEYFRAMES',sceneId:'scene-second'});
 await page.locator('.preparation-stage-checks > summary').click();await page.locator('[data-production-check="ANIMATIC_LOCK"]').click();
 expect(await context(page)).toMatchObject({creatorStageId:'SHOT_GENERATION',scopeType:'SCENE',navigationScopeType:'SCENE',gateId:'ANIMATIC_LOCK',phaseId:'PREVIS'});clean(f);
});

test('错误stage与gate组合失败关闭，不借首检查或首场打开正式工作区',async({page})=>{
 const f=await fixture(page,{query:'creatorStage=shot-breakdown&productionGate=keyframes&preparationEpisode=episode-second&preparationScene=scene-second'});
 await expect(page.getByRole('alert')).toContainText('制作阶段与检查不匹配');await expect(page.locator('[data-stage-context]')).toHaveCount(0);await expect(page.getByRole('button',{name:'编辑本场准备内容',exact:true})).toHaveCount(0);expect(new URL(page.url()).searchParams.get('productionGate')).toBe('keyframes');clean(f);
});

test('切至整集可取消，未保存文字及原永久场URL保持一致；确认才清除场',async({page})=>{
 const f=await fixture(page,{query:'preparationEpisode=episode-second&preparationScene=scene-second'});
 await page.getByRole('button',{name:'编辑本场准备内容',exact:true}).click();const field=page.getByRole('textbox',{name:'本场作用',exact:true});await field.fill('第二集尚未提交');
 const original=page.url(),dialog=page.waitForEvent('dialog'),click=stage(page,'EPISODE_EDIT').click();await(await dialog).dismiss();await click;
 await expect(field).toHaveValue('第二集尚未提交');await expect(page).toHaveURL(original);expect(await context(page)).toMatchObject({sceneId:'scene-second'});
 const accepted=page.waitForEvent('dialog'),acceptedClick=stage(page,'EPISODE_EDIT').click();await(await accepted).accept();await acceptedClick;expect(await context(page)).not.toHaveProperty('sceneId');await expect(field).toHaveCount(0);clean(f);
});

test('作者保存继续精确CAS且冻结对白/绑定/授权保留，冲突不重试',async({page})=>{
 const f=await fixture(page,{conflict:true});await page.getByRole('button',{name:'编辑本场准备内容',exact:true}).click();const field=page.getByRole('textbox',{name:'本场作用',exact:true});await field.fill('新镜头表达意图');
 await page.getByRole('button',{name:'保存本场准备稿',exact:true}).click();await expect(page.getByRole('alert')).toContainText('CAS_CONFLICT');await expect(field).toHaveValue('新镜头表达意图');expect(f.writes).toHaveLength(1);
 expect(f.writes[0]).toMatchObject({action:'save',expectedReleaseId:'four-release',expectedRevisionId:'four-prep-r1'});const content=f.writes[0].content as ReturnType<typeof preparation>['content'];
 expect(content.basis).toEqual(f.prep.content.basis);expect(content.episodes).toEqual(f.prep.content.episodes);const changed=content.scenes[0];expect(changed.sceneContentHash).toBe(f.prep.content.scenes[0].sceneContentHash);
 expect(changed.preparation.sourceDialogue).toEqual(f.prep.content.scenes[0].preparation.sourceDialogue);expect(changed.preparation.entityStateRequirements).toEqual(f.prep.content.scenes[0].preparation.entityStateRequirements);expect(changed.preparation.generationAuthorized).toBe(false);expect(changed.preparation.formalShotIds).toEqual([]);expect(content.scenes[1]).toEqual(f.prep.content.scenes[1]);
 await page.waitForTimeout(250);expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('390px只读四阶段和两级目录可达无横向溢出，历史评论原scope不改',async({page})=>{
 await page.setViewportSize({width:390,height:844});const f=await fixture(page,{readonly:true});await expect(page.getByText('原修订的精确场意见',{exact:false})).toBeVisible();await expect(page.getByText('记录于原准备稿修订 · 保留历史依据',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'编辑本场准备内容',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'保存准备意见',exact:true})).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
 await stage(page,'EPISODE_EDIT').focus();await page.keyboard.press('Enter');expect(await context(page)).toMatchObject({navigationScopeType:'EPISODE'});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);clean(f);
});

test('阶段按钮不能把明确错误的永久场静默换成首场',async({page})=>{
 const f=await fixture(page,{query:'creatorStage=shot-breakdown&preparationEpisode=episode-second&preparationScene=scene-missing'});
 await expect(page.getByRole('alert')).toContainText('永久场身份不在当前准备稿中');await expect(stage(page,'SHOT_GENERATION')).toBeDisabled();await expect(page.locator('[data-stage-context]')).toHaveCount(0);expect(new URL(page.url()).searchParams.get('preparationScene')).toBe('scene-missing');
 await episode(page,'episode-second').click();await expect(page.getByRole('alert')).toHaveCount(0);await expect(stage(page,'SHOT_GENERATION')).toBeEnabled();expect(await context(page)).toMatchObject({episodeUid:'episode-second',sceneId:'scene-second'});clean(f);
});
