import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),scene='scene:letter',shot=scene+'-SH01',gate='SHOT_PLAN_INPUT_LOCK';
const sha='a'.repeat(64),previewHash='b'.repeat(64),manifestHash='c'.repeat(64);
function content(sceneId:string){return{schemaVersion:'1.0',sceneId,shotPlanRevisionId:'SHOT-DESIGN-1',shotPlanHash:sha,shots:[{shotId:sceneId+'-SH01',keyframeStrategy:{mode:'START_ONLY',reason:'固定机位',intermediateFrameCount:0},dialogueLines:[],inputs:[],space:{loc:'UNKNOWN',state:'UNKNOWN',zone:'UNKNOWN',camera:'UNKNOWN',freeze:'UNKNOWN'},handles:{headFrames:0,tailFrames:0},videoBranch:'UNKNOWN'}]};}
type Draft={revisionId:string;content:ReturnType<typeof content>};
type Failure='network'|'5xx'|'html'|'missing'|'4xx';
async function fixture(page:Page,options:{failure?:Failure;failAction?:string;commitBeforeFailure?:boolean;readOnly?:boolean}={}){
 const writes:Array<Record<string,unknown>>=[],headers:string[]=[],errors:string[]=[],unexpected:string[]=[],reads:string[]=[];
 const drafts=new Map<string,Draft>(),jobs:Array<{jobId:string;status:string}>=[],manifestJobs:Array<{jobId:string;status:string;workItemId:string}>=[];let failed=false,invalidNextRead=false;
 const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ShotProductionWorkspace}from'./app/shot-production-workspace';function App(){const [context,setContext]=useState({sceneId:${JSON.stringify(scene)},gateId:${JSON.stringify(gate)},shotId:${JSON.stringify(shot)}});return <main><nav><button onClick={()=>setContext(c=>({...c,sceneId:'scene:room',shotId:'scene:room-SH01'}))}>切换场</button><button onClick={()=>setContext(c=>({...c,gateId:'KEYFRAME'}))}>切换步骤</button><button onClick={()=>setContext(c=>({...c,shotId:c.sceneId+'-SH02'}))}>切换镜头</button></nav><ShotProductionWorkspace {...context}/></main>}createRoot(document.getElementById('root')).render(<App/>);`;
 const files=buildSync({stdin:{contents:entry,resolveDir:root,sourcefile:'production-workspace-harness.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,outdir:'virtual-workspace',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'}).outputFiles,js=files.find(f=>f.path.endsWith('.js'))!.text,css=files.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/api/v8/operations/snapshot'&&request.method()==='GET')return route.fulfill({json:{mutationEtag:'"production-cas"'}});
  if(url.pathname==='/api/instance/shot-production'){
   if(request.method()==='GET'){
    const sceneId=url.searchParams.get('sceneId')!;reads.push(sceneId);if(invalidNextRead){invalidNextRead=false;return route.fulfill({json:{message:'incomplete'}});}
    const draft=drafts.get(sceneId)||null,initial=content(sceneId);
    return route.fulfill({json:{sceneId,releaseId:'RELEASE',readOnly:options.readOnly||false,basis:{shots:[{id:sceneId+'-SH01',title:'迟疑后拿起信封',materialRequirementRefs:[]}]},blockers:[],defaultContent:initial,currentPlan:{content:initial},draft,draftHeadRevisionId:draft?.revisionId||null,availableInputs:[],jobs,manifestJobs,manifestTargets:[{workItemId:'WORK:'+sceneId,shotId:sceneId+'-SH01',gateId:gate,label:'输入锁定'}],readiness:{ready:false,readyCount:0,shotCount:1,shots:[{shotId:sceneId+'-SH01',title:'迟疑后拿起信封',ready:false,blockers:['INPUT_LOCK_REQUIRED']}]}}});
   }
   const body=request.postDataJSON();writes.push(body);expect(request.headers()['if-match']).toBe('"production-cas"');headers.push(request.headers()['idempotency-key']);
   const fails=options.failure&&!failed&&body.action===(options.failAction||'save');
   const apply=()=>{if(body.action==='save')drafts.set(body.sceneId,{revisionId:'DRAFT-'+writes.length,content:body.content});if(body.action==='publish')jobs.push({jobId:'PRODUCTION-JOB',status:'QUEUED'});if(body.action==='manifest-render')manifestJobs.push({jobId:'MANIFEST-JOB',workItemId:body.workItemId,status:'QUEUED'});};
   if(fails){failed=true;if(options.commitBeforeFailure)apply();if(options.failure==='network')return route.abort('failed');if(options.failure==='5xx')return route.fulfill({status:503,json:{error:'服务提交回执中断'}});if(options.failure==='html')return route.fulfill({status:200,contentType:'text/html',body:'<p>proxy response</p>'});if(options.failure==='missing')return route.fulfill({json:{message:'ok'}});return route.fulfill({status:412,json:{error:'制作状态已经变化，请重新核对'}});}
   apply();if(body.action==='save')return route.fulfill({json:{revisionId:drafts.get(body.sceneId)!.revisionId,contentHash:sha,formalAdoptionPerformed:false}});
   if(body.action==='preview')return route.fulfill({json:{sceneId:body.sceneId,expectedReleaseId:'RELEASE',draftRevisionId:body.draftRevisionId,previewHash,workItemCount:6,outputCount:6,previousWorkItemIds:[]}});
   if(body.action==='publish')return route.fulfill({json:{jobId:'PRODUCTION-JOB',status:'QUEUED'}});
   if(body.action==='manifest-preview')return route.fulfill({json:{workItemId:body.workItemId,expectedReleaseId:'RELEASE',manifestHash,content:{scope:body.sceneId,workItemId:body.workItemId,version:'精确清单内容'}}});
   if(body.action==='manifest-render')return route.fulfill({json:{jobId:'MANIFEST-JOB',status:'QUEUED',formalReviewCreated:false}});
  }
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'unexpected'}});
 });
 await page.route('**/__production-workspace',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script></body></html>`}));await page.goto('/__production-workspace');await expect(page.getByRole('heading',{name:'本场制作输入'})).toBeVisible();
 return{writes,headers,errors,unexpected,reads,invalidRead:()=>{invalidNextRead=true;},remoteDraft:(reason:string)=>{const value=content(scene);value.shots[0].keyframeStrategy.reason=reason;drafts.set(scene,{revisionId:'REMOTE-DRAFT',content:value});}};
}
const workspace=(page:Page)=>page.getByRole('region',{name:'镜头制作设置',exact:true});
async function author(page:Page){await workspace(page).getByRole('textbox',{name:'策略依据',exact:true}).fill('手停在信封上方，尾帧展开信纸');await workspace(page).getByRole('combobox',{name:'关键帧策略',exact:true}).selectOption('START_END');}
async function savedPreview(page:Page){await author(page);await page.getByRole('button',{name:'保存制作设置'}).click();await expect(page.getByRole('button',{name:'预览制作需求'})).toBeEnabled();await page.getByRole('button',{name:'预览制作需求'}).click();await expect(page.getByRole('button',{name:'确认并建立制作需求'})).toBeVisible();}

test('production settings save, preview and queue the exact revision; manifest queues its own exact preview',async({page})=>{
 const f=await fixture(page);await savedPreview(page);expect(f.writes[0]).toMatchObject({action:'save',sceneId:scene,expectedReleaseId:'RELEASE',expectedDraftRevisionId:null,content:{shots:[{shotId:shot,keyframeStrategy:{mode:'START_END',reason:'手停在信封上方，尾帧展开信纸'}}]}});expect(f.writes[1]).toMatchObject({action:'preview',draftRevisionId:'DRAFT-1'});
 await page.getByRole('button',{name:'确认并建立制作需求'}).click();await expect(page.getByText('制作任务：等待工作器处理')).toBeVisible();expect(f.writes[2]).toMatchObject({action:'publish',draftRevisionId:'DRAFT-1',previewHash});
 await page.getByRole('button',{name:'准备输入锁定清单'}).click();await expect(page.getByRole('region',{name:'制作清单预览'})).toContainText('精确清单内容');await page.getByRole('button',{name:'生成清单文件'}).click();await expect(page.getByText('清单任务 MANIFEST-JOB · 等待工作器处理')).toBeVisible();expect(f.writes[4]).toEqual({action:'manifest-render',sceneId:scene,workItemId:'WORK:'+scene,expectedReleaseId:'RELEASE',manifestHash});expect(f.writes.map(w=>w.action)).toEqual(['save','preview','publish','manifest-preview','manifest-render']);expect(new Set(f.headers).size).toBe(5);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

for(const failure of ['network','5xx','html','missing'] as const)test(`production ${failure} receipt freezes retries and rereads current revision while preserving local edits`,async({page})=>{
 const f=await fixture(page,{failure});await author(page);await page.getByRole('button',{name:'保存制作设置'}).click();await expect(workspace(page).getByRole('alert')).toContainText('提交结果尚未确认');await expect(page.getByRole('button',{name:'保存制作设置'})).toBeDisabled();await expect(page.getByRole('button',{name:'预览制作需求'})).toBeDisabled();await expect(workspace(page).getByRole('textbox',{name:'策略依据'})).toBeDisabled();expect(f.reads).toHaveLength(1);
 f.remoteDraft('服务器另一份草稿');await page.getByRole('button',{name:'重读制作计划与任务'}).click();await expect(workspace(page).getByRole('alert')).toContainText('本次编辑仍保留');await expect(workspace(page).getByRole('textbox',{name:'策略依据'})).toHaveValue('手停在信封上方，尾帧展开信纸');await expect(page.getByRole('button',{name:'保存制作设置'})).toBeEnabled();expect(f.writes).toHaveLength(1);
 await page.getByRole('button',{name:'保存制作设置'}).click();await expect(page.getByRole('button',{name:'预览制作需求'})).toBeEnabled();expect(f.writes[1]).toMatchObject({action:'save',expectedDraftRevisionId:'REMOTE-DRAFT'});expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('a malformed reread does not clear unknown state or discard the local draft',async({page})=>{
 const f=await fixture(page,{failure:'network'});await author(page);await page.getByRole('button',{name:'保存制作设置'}).click();await expect(workspace(page).getByRole('alert')).toContainText('提交结果尚未确认');f.invalidRead();await page.getByRole('button',{name:'重读制作计划与任务'}).click();await expect(workspace(page).getByRole('alert')).toContainText('回执无效');await expect(page.getByRole('button',{name:'保存制作设置'})).toBeDisabled();await expect(workspace(page).getByRole('textbox',{name:'策略依据'})).toHaveValue('手停在信封上方，尾帧展开信纸');await page.getByRole('button',{name:'重读制作计划与任务'}).click();await expect(page.getByRole('button',{name:'保存制作设置'})).toBeEnabled();expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);
});

test('an explicit 4xx rejection leaves edits available and performs no automatic retry',async({page})=>{
 const f=await fixture(page,{failure:'4xx'});await author(page);await page.getByRole('button',{name:'保存制作设置'}).click();await expect(workspace(page).getByRole('alert')).toContainText('制作状态已经变化');await expect(page.getByRole('button',{name:'保存制作设置'})).toBeEnabled();await expect(workspace(page).getByRole('textbox',{name:'策略依据'})).toBeEditable();await expect(page.getByRole('button',{name:'重读制作计划与任务'})).toHaveCount(0);expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);
});

test('unknown publish cannot be requeued before rereading the committed job and previewing again',async({page})=>{
 const f=await fixture(page,{failure:'5xx',failAction:'publish',commitBeforeFailure:true});await savedPreview(page);await page.getByRole('button',{name:'确认并建立制作需求'}).click();await expect(workspace(page).getByRole('alert')).toContainText('提交结果尚未确认');await expect(page.getByRole('button',{name:'确认并建立制作需求'})).toBeDisabled();await page.getByRole('button',{name:'重读制作计划与任务'}).click();await expect(page.getByText('制作任务：等待工作器处理')).toBeVisible();await expect(page.getByRole('button',{name:'确认并建立制作需求'})).toHaveCount(0);await expect(workspace(page).getByRole('textbox',{name:'策略依据'})).toHaveValue('手停在信封上方，尾帧展开信纸');expect(f.writes).toHaveLength(3);expect(f.errors).toEqual([]);
});

test('unknown manifest render rereads its queued job before permitting another preview',async({page})=>{
 const f=await fixture(page,{failure:'missing',failAction:'manifest-render',commitBeforeFailure:true});await page.getByRole('button',{name:'准备输入锁定清单'}).click();await page.getByRole('button',{name:'生成清单文件'}).click();await expect(workspace(page).getByRole('alert')).toContainText('提交结果尚未确认');await expect(page.getByRole('button',{name:'生成清单文件'})).toBeDisabled();await expect(page.getByRole('button',{name:'准备输入锁定清单'})).toBeDisabled();await page.getByRole('button',{name:'重读制作计划与任务'}).click();await expect(page.getByText('清单任务 MANIFEST-JOB · 等待工作器处理')).toBeVisible();await expect(page.getByRole('region',{name:'制作清单预览'})).toHaveCount(0);expect(f.writes).toHaveLength(2);expect(f.errors).toEqual([]);
});

for(const button of ['切换场','切换步骤','切换镜头'])test(`${button} cannot display the previous context's manifest`,async({page})=>{
 const f=await fixture(page);await page.getByRole('button',{name:'准备输入锁定清单'}).click();await expect(page.getByRole('region',{name:'制作清单预览'})).toBeVisible();await page.getByRole('button',{name:button,exact:true}).click();await expect(page.getByRole('region',{name:'制作清单预览'})).toHaveCount(0);await expect(page.getByRole('heading',{name:'本场制作输入'})).toBeVisible();expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('read-only workspace reads the plan and jobs without exposing mutation actions',async({page})=>{
 const f=await fixture(page,{readOnly:true});await expect(workspace(page).getByRole('button')).toHaveText(['刷新状态']);await expect(workspace(page).getByRole('textbox')).toHaveCount(0);await page.getByRole('button',{name:'刷新状态'}).click();await expect(page.getByRole('heading',{name:'本场制作输入'})).toBeVisible();expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
