import {test,expect,type Page} from '@playwright/test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {parseProductionMaterialQuery,queryProductionMaterialPage} from '../host/instance-runtime/production-material-query.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const basis={snapshotId:'catalog-fixture',operationRevision:4};
function sourceModel(){
 const model:Record<string,Array<Record<string,unknown>>>={workItems:[],workPackages:[],assetFamilies:[],assetVersions:[],expectedOutputs:[],shots:[{id:'shot-one',title:'发现信件',sceneId:'scene-one',episodeUid:'episode-one',shotPlanSetRevisionId:'plan-r1'}],scenes:[{id:'scene-one',title:'室内'}],episodes:[{id:'episode-one',episodeUid:'episode-one',displayId:'E01'}],reviewContexts:[],materialRequirements:[]};
 for(const [id,kind] of [['a-dialogue','DIALOGUE_DRY'],['b-image','START_FRAME'],['c-image','END_FRAME'],['d-image','INTERMEDIATE_FRAME']]){
  const work={id:'SP-WI-'+id,label:id,deliverableKey:kind,scopeType:'SHOT',scopeId:'shot-one',episodeUid:'episode-one',sceneId:'scene-one',shotId:'shot-one',activeInCurrentProduction:true,scopeRole:'CURRENT',gateId:kind==='DIALOGUE_DRY'?'STORYBOARD_DIALOGUE':'KEYFRAMES',outputAssetRef:id,inputAssetRefs:[],additionalOutputAssetRefs:[]};
  model.workItems.push(work);model.workPackages.push({id:'package-'+id,scopeType:'SHOT',scopeId:'shot-one',workItemRefs:[work.id],shotIds:['shot-one'],activeInCurrentProduction:true,scopeRole:'CURRENT'});model.assetFamilies.push({id,label:id,kind:kind==='DIALOGUE_DRY'?'AUDIO':'IMAGE',ownerRef:work.id,versionRefs:[],currentVersionId:null,expectedOutputRefs:['eo-'+id],currentExpectedOutputId:'eo-'+id,scopeRole:'CURRENT'});model.expectedOutputs.push({id:'eo-'+id,familyId:id});
 }
 return model;
}
let bundle:Promise<{js:string;css:string}>|undefined;
async function browserBundle(){
 if(!bundle)bundle=(async()=>{
  // The card's large review surface is outside this navigation regression.
  // Keep its real recipe editor and pass the exact existing card callbacks.
  const files=(await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{ProductionMaterialCatalog}from'./app/production-material-catalog';createRoot(document.getElementById('root')).render(<ProductionMaterialCatalog model={${JSON.stringify(sourceModel())}} snapshotId="catalog-fixture"/>);`,resolveDir:root,sourcefile:'production-material-catalog-harness.tsx',loader:'tsx'},plugins:[{name:'card-boundary',setup(builder){builder.onResolve({filter:/^\.\/production-workbench$/},args=>args.importer.endsWith('production-material-catalog.tsx')?{path:'information-card',namespace:'catalog-harness'}:undefined);builder.onLoad({filter:/.*/,namespace:'catalog-harness'},()=>({loader:'tsx',resolveDir:root,contents:`import React from'react';import{ShotProductionRecipeEditor}from'./app/shot-production-recipe-editor';export function ProductionWorkItemInformationCard({workItemId,familyId,onNavigate,onOpenMaterial}){return <article data-card-family={familyId}><ShotProductionRecipeEditor key={workItemId} workItemId={workItemId}/><button onClick={()=>onNavigate({workItemId:'SP-WI-c-image',familyId:'c-image'})}>转到关联尾帧</button><button onClick={()=>onOpenMaterial('base-master')}>打开基础母版</button></article>}` }));}}],bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,outdir:'virtual-catalog',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'})).outputFiles;
  return{js:files.find(f=>f.path.endsWith('.js'))!.text,css:files.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n')};
 })();return bundle;
}
async function fixture(page:Page,{wrongFilter=false}={}){
 const model=sourceModel(),bundle=await browserBundle(),errors:string[]=[],unexpected:string[]=[],queries:{mediaType:string|null;cursor:string|null;familyId:string|null}[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'No mutation in navigation tests'}});}
  if(url.pathname==='/api/v8/ui/production-materials'){
   queries.push({mediaType:url.searchParams.get('mediaType'),cursor:url.searchParams.get('cursor'),familyId:url.searchParams.get('familyId')});url.searchParams.set('limit','1');
   try{const result=queryProductionMaterialPage(model,{},parseProductionMaterialQuery(url,basis));if(wrongFilter&&url.searchParams.get('cursor'))result.appliedFilters={...result.appliedFilters,mediaType:'VIDEO'};return route.fulfill({json:{...result,...basis}});}catch(error){const failure=error as {status?:number;message?:string};return route.fulfill({status:failure.status||500,json:{error:failure.message||'Unknown fixture error'}});}
  }
  if(url.pathname==='/api/instance/shot-production/recipes')return route.fulfill({json:{workItemId:url.searchParams.get('workItemId'),releaseId:'release-one',draftHeadRevisionId:null,draft:null,current:null,defaults:{model:'model-one',prompt:'服务器原稿',negativePrompt:'',parameters:{}},inputs:[],output:null,readOnly:false,blockers:[],jobs:[]}});
  unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'Unexpected fixture API'}});
 });
 const css=readFileSync(root+'app/globals.css','utf8')+'\n'+bundle.css;
 await page.route('**/__production-material-catalog*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.js.replaceAll('</script','<\\/script')}</script></body></html>`}));
 await page.goto('/__production-material-catalog?view=materials&materialCatalog=production');await expect(page.locator('[data-production-material-id="a-dialogue"]')).toBeVisible();return{errors,unexpected,queries};
}
async function edit(page:Page){await page.getByRole('combobox',{name:'媒介',exact:true}).selectOption('IMAGE');await page.locator('[data-production-material-id="b-image"]').click();await page.getByRole('button',{name:'编写本工作项调用包'}).click();await page.getByRole('textbox',{name:'完整主提示词',exact:true}).fill('本地未保存的精确调用包');}
async function decide(page:Page,action:()=>Promise<unknown>,accept=false){const dialog=page.waitForEvent('dialog'),pending=action();const prompt=await dialog;expect(prompt.message()).toContain('未保存的镜头调用包');if(accept)await prompt.accept();else await prompt.dismiss();await pending;}
function clean(f:Awaited<ReturnType<typeof fixture>>){expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);}

for(const kind of ['Escape','close'])test(`process drawer ${kind} cancellation preserves URL and unsaved recipe until explicit discard`,async({page})=>{
 const f=await fixture(page);await edit(page);const before=page.url(),action=()=>kind==='Escape'?page.keyboard.press('Escape'):page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await decide(page,action);await expect(page).toHaveURL(before);await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('本地未保存的精确调用包');await expect(page.locator('dialog[open]')).toBeVisible();
 await decide(page,action,true);await expect(page.locator('dialog[open]')).toHaveCount(0);expect(new URL(page.url()).searchParams.has('productionMaterial')).toBe(false);await page.locator('[data-production-material-id="b-image"]').click();await page.getByRole('button',{name:'编写本工作项调用包'}).click();await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('服务器原稿');clean(f);
});
test('associated process-card navigation may be cancelled without losing the current recipe',async({page})=>{
 const f=await fixture(page);await edit(page);const before=page.url(),action=()=>page.getByRole('button',{name:'转到关联尾帧'}).click();await decide(page,action);await expect(page).toHaveURL(before);await expect(page.locator('[data-card-family="b-image"]')).toBeVisible();await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('本地未保存的精确调用包');await decide(page,action,true);await expect(page.locator('[data-card-family="c-image"]')).toBeVisible();expect(new URL(page.url()).searchParams.get('productionMaterial')).toBe('c-image');clean(f);
});
test('basic material navigation and browser card-back protect the same dirty recipe',async({page})=>{
 const f=await fixture(page);await edit(page);const before=page.url();await decide(page,()=>page.getByRole('button',{name:'打开基础母版'}).click());await expect(page).toHaveURL(before);await decide(page,()=>page.goBack());await expect(page).toHaveURL(before);await expect(page.getByRole('textbox',{name:'完整主提示词',exact:true})).toHaveValue('本地未保存的精确调用包');clean(f);
});
test('history back and forward reset a different filter second page to its exact first page',async({page})=>{
 const f=await fixture(page);await page.locator('[data-production-material-id="a-dialogue"]').click();await expect(page.locator('[data-card-family="a-dialogue"]')).toBeVisible();await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByRole('combobox',{name:'媒介',exact:true}).selectOption('IMAGE');await expect(page.locator('[data-production-material-id="b-image"]')).toBeVisible();await page.getByRole('button',{name:'继续读取',exact:true}).click();await expect(page.locator('[data-production-material-id="c-image"]')).toBeVisible();
 const beforeBack=f.queries.length;await page.goBack();await expect(page.getByRole('combobox',{name:'媒介',exact:true})).toHaveValue('');await expect(page.locator('[data-production-material-id="a-dialogue"]')).toBeVisible();await expect(page.locator('[data-production-material-id]')).toHaveCount(1);expect(f.queries.slice(beforeBack).filter(q=>!q.familyId)).toEqual([{mediaType:null,cursor:null,familyId:null}]);
 const beforeForward=f.queries.length;await page.goForward();await expect(page.getByRole('combobox',{name:'媒介',exact:true})).toHaveValue('IMAGE');await expect(page.locator('[data-production-material-id="b-image"]')).toBeVisible();await expect(page.locator('[data-production-material-id]')).toHaveCount(1);expect(f.queries.slice(beforeForward).filter(q=>!q.familyId)).toEqual([{mediaType:'IMAGE',cursor:null,familyId:null}]);await expect(page.getByRole('alert')).toHaveCount(0);clean(f);
});
test('pagination rejects a response from a different applied filter without merging rows',async({page})=>{
 const f=await fixture(page,{wrongFilter:true});await page.getByRole('combobox',{name:'媒介',exact:true}).selectOption('IMAGE');await expect(page.locator('[data-production-material-id="b-image"]')).toBeVisible();await page.getByRole('button',{name:'继续读取',exact:true}).click();await expect(page.getByRole('alert')).toContainText('筛选条件不匹配');await expect(page.locator('[data-production-material-id]')).toHaveCount(1);await expect(page.locator('[data-production-material-id="c-image"]')).toHaveCount(0);clean(f);
});
