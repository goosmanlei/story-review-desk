import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function fixture(page:Page,{wrongMode=false,unknownSave=false,saveWasPersisted=false,unknownPublish=false}={}){
 const writes:Array<Record<string,unknown>>=[],reads:string[]=[],errors:string[]=[];let draft:null|{revisionId:string;content:unknown;mode?:string;baseReleaseId?:string;basisHash?:string;acknowledgement?:unknown}=null,complete=false,changed=false;
 const hash='b'.repeat(64),before='a'.repeat(64),after='c'.repeat(64),content={model:'codex:gpt-image-2',prompt:'原始静态母版',negativePrompt:'保持永久身份',parameters:{},inputBindings:[]};
 const entry="import React from'react';import{createRoot}from'react-dom/client';import{RuntimeModeProvider}from'./app/runtime-mode';import{MaterialProductionSetupEditor}from'./app/material-production-setup-editor';createRoot(document.getElementById('root')).render(<RuntimeModeProvider hostedReadOnly={false}><MaterialProductionSetupEditor requirementId='REQ' revision={true}/></RuntimeModeProvider>);";
 const files=buildSync({stdin:{contents:entry,resolveDir:root,sourcefile:'material-rebase-fixture.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,outdir:'virtual-material-rebase',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'}).outputFiles;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/api/v8/operations/snapshot')return route.fulfill({json:{mutationEtag:'"current"'}});
  if(url.pathname!=='/api/instance/material-production')throw Error('Unexpected API '+url.pathname);
  if(request.method()==='GET'){
   reads.push(url.search);
   if(url.searchParams.has('jobId'))return route.fulfill({json:{schemaVersion:'MATERIAL_PRODUCTION_JOB_STATUS_V1',requirementId:'REQ',jobId:'JOB',mode:'REQUIREMENT_REBASE',status:'SUCCEEDED',result:{releaseId:'NEW',mode:'REQUIREMENT_REBASE'}}});
   const rebase=url.searchParams.get('mode')==='REQUIREMENT_REBASE';if(!rebase&&!complete)return route.fulfill({status:409,json:{message:'当前需求已偏离首次制作建档闭包，不能借返修迁移归属'}});
   return route.fulfill({json:{releaseId:complete?'NEW':'OLD',mode:rebase&&!wrongMode?'REQUIREMENT_REBASE':'REVISION',basisHash:changed?'d'.repeat(64):hash,currentRegistration:{familyId:'FAMILY'},parentVersionId:'FAMILY@V001',parentVersionSha256:'1'.repeat(64),plannedVersionLabel:'V002',currentDefinitionId:'DEF',readOnly:false,draftHeadRevisionId:draft?.revisionId||null,draft,defaults:content,availableInputs:[],blockers:[],jobs:[],...(rebase?{rebase:{beforeHash:before,afterHash:changed?'e'.repeat(64):after,changes:[{path:'representation.label',before:'全程动作',after:'独立静态基准'}]}}:{})}});
  }
  const body=request.postDataJSON();writes.push(body);
  if(body.action==='save'){if(!unknownSave||saveWasPersisted)draft={revisionId:'DRAFT',content:body.content,mode:body.mode,baseReleaseId:body.expectedReleaseId,basisHash:body.expectedBasisHash,acknowledgement:body.acknowledgement};if(unknownSave)return route.fulfill({status:503,json:{error:'unknown save'}});return route.fulfill({json:{revisionId:'DRAFT'}});}
  if(body.action==='preview')return route.fulfill({json:{previewHash:'f'.repeat(64),plan:{schemaVersion:'MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1',mode:'REQUIREMENT_REBASE',requirementId:'REQ',basisHash:hash}}});
  if(unknownPublish)return route.fulfill({status:503,json:{error:'unknown publish'}});complete=true;return route.fulfill({json:{jobId:'JOB',status:'QUEUED'}});
 });
 await page.route('**/__rebase-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><script>'+files.find(f=>f.path.endsWith('.js'))!.text+'</script>'}));await page.goto('/__rebase-fixture');
 return {writes,reads,errors,change:()=>{changed=true;},hash,before,after};
}
async function open(page:Page){await page.getByRole('button',{name:'修订素材制作资料',exact:true}).click();await page.getByRole('button',{name:'查看已发布需求差异，明确建立新制作基线'}).click();}
test('explicit semantic acknowledgement binds save preview publish and stable job success returns to normal current workspace',async({page})=>{
 const f=await fixture(page);await open(page);await expect(page.getByRole('heading',{name:'新旧需求差异'})).toBeVisible();await expect(page.getByRole('button',{name:'保存制作资料草稿'})).toBeDisabled();await expect(page.getByRole('checkbox')).not.toBeChecked();
 await page.getByRole('checkbox').check();await page.getByRole('textbox',{name:'新基线制作说明'}).fill('按当前已发布要求制作静态基准');await page.getByRole('button',{name:'保存制作资料草稿'}).click();await expect(page.getByRole('status')).toContainText('草稿已保存');expect(f.writes[0]).toMatchObject({mode:'REQUIREMENT_REBASE',expectedBasisHash:f.hash,acknowledgement:{confirmed:true,beforeHash:f.before,afterHash:f.after,note:'按当前已发布要求制作静态基准'}});
 await page.getByRole('button',{name:'预览素材制作资料'}).click();await page.getByRole('button',{name:'确认建立下一候选版本'}).click();await expect(page.getByRole('status')).toContainText('任务已排队');expect(f.writes.map(w=>w.mode)).toEqual(['REQUIREMENT_REBASE','REQUIREMENT_REBASE','REQUIREMENT_REBASE']);
 await page.getByRole('textbox',{name:'完整主提示词',exact:true}).fill('发布后尚未提交的下一次作者草稿');await page.getByRole('button',{name:'重读制作资料与任务'}).click();await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('发布后尚未提交的下一次作者草稿');await expect(page.getByRole('heading',{name:'新旧需求差异'})).toHaveCount(0);expect(f.reads.some(s=>s.includes('jobId=JOB'))).toBe(true);expect(f.reads.at(-1)).toBe('?requirementId=REQ');expect(f.writes).toHaveLength(3);expect(f.errors).toEqual([]);
});
test('explicit mode cannot silently accept an ordinary revision response',async({page})=>{const f=await fixture(page,{wrongMode:true});await open(page);await expect(page.getByRole('status')).toContainText('协议与当前明确选择不一致');await expect(page.getByRole('button',{name:'保存制作资料草稿'})).toHaveCount(0);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);});
test('source change during uncertain save keeps observations but resets semantic confirmation and never retries',async({page})=>{const f=await fixture(page,{unknownSave:true});await open(page);await page.getByRole('checkbox').check();await page.getByRole('textbox',{name:'新基线制作说明'}).fill('保留未确认结果的作者说明');await page.getByRole('textbox',{name:'完整主提示词',exact:true}).fill('保留完整未提交作者稿');await page.getByRole('button',{name:'保存制作资料草稿'}).click();await expect(page.getByRole('status')).toContainText('提交结果尚未确认');f.change();await page.getByRole('button',{name:'重读制作资料与任务'}).click();await expect(page.getByRole('checkbox')).not.toBeChecked();await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('保留完整未提交作者稿');await expect(page.getByRole('textbox',{name:'新基线制作说明'})).toHaveValue('保留未确认结果的作者说明');await expect(page.getByRole('button',{name:'保存制作资料草稿'})).toBeDisabled();expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);});

async function acknowledge(page:Page){await page.getByRole('checkbox').check();await page.getByRole('textbox',{name:'新基线制作说明'}).fill('明确按当前新基线制作，保留原历史。');}
test('same-basis empty readback cannot resolve unknown save or permit a second write',async({page})=>{
 const f=await fixture(page,{unknownSave:true});await open(page);await acknowledge(page);await page.getByRole('button',{name:'保存制作资料草稿'}).click();await expect(page.getByRole('status')).toContainText('提交结果尚未确认');await page.getByRole('button',{name:'重读制作资料与任务'}).click();await expect(page.getByRole('status')).toContainText('禁止重发');await expect(page.getByRole('button',{name:'保存制作资料草稿'})).toBeDisabled();await expect(page.getByRole('button',{name:'预览素材制作资料'})).toBeDisabled();expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);
});
test('exact distinct saved head proves current content after a lost save response',async({page})=>{
 const f=await fixture(page,{unknownSave:true,saveWasPersisted:true});await open(page);await acknowledge(page);await page.getByRole('button',{name:'保存制作资料草稿'}).click();await expect(page.getByRole('status')).toContainText('提交结果尚未确认');await page.getByRole('button',{name:'重读制作资料与任务'}).click();await expect(page.getByRole('status')).toContainText('当前内容已核实保存');await expect(page.getByRole('button',{name:'预览素材制作资料'})).toBeEnabled();expect(f.writes).toHaveLength(1);expect(f.errors).toEqual([]);
});
test('lost publish response remains uncertain without an exact job receipt despite current draft readback',async({page})=>{
 const f=await fixture(page,{unknownPublish:true});await open(page);await acknowledge(page);await page.getByRole('button',{name:'保存制作资料草稿'}).click();await page.getByRole('button',{name:'预览素材制作资料'}).click();await page.getByRole('button',{name:'确认建立下一候选版本'}).click();await expect(page.getByRole('status')).toContainText('提交结果尚未确认');await page.getByRole('button',{name:'重读制作资料与任务'}).click();await expect(page.getByRole('status')).toContainText('禁止重发');await expect(page.getByRole('button',{name:'保存制作资料草稿'})).toBeDisabled();await expect(page.getByRole('button',{name:'预览素材制作资料'})).toBeDisabled();expect(f.writes).toHaveLength(3);expect(f.reads.some(s=>s.includes('jobId='))).toBe(false);expect(f.errors).toEqual([]);
});
