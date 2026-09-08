import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {workspaceProjection} from '../host/instance-runtime/domain-workspaces.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));

async function fixture(page:Page,{sparse=false,invalid=false}={}){
  const capture=JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json',import.meta.url),'utf8')),snapshot=capture.responses.bootstrap.data,profile=snapshot.instance,configuration=defaultConfiguration(profile),f=replacementFixture();
  let projected=projectDomainGraph({...snapshot,productionModel:{...snapshot.productionModel,materialRequirements:[]}},f.before,{revisionId:'before',sha256:domainHash(f.before)});
  projected=projectDomainGraph(projected,f.after,{revisionId:'after',sha256:domainHash(f.after)});
  const requirements=projected.productionModel.materialRequirements,original=requirements.find((r:{id:string})=>r.id==='old-broad');
  Object.assign(original,{materialProductionPlanId:'MP-FIXTURE',coverageSatisfied:true});
  if(invalid)Object.assign(original,{currentDisposition:'INVALID_REPLACEMENT',requirementReplacement:{...original.requirementReplacement,status:'INVALID',reasons:['REPLACEMENT_SUCCESSOR_MISSING']}});
  const image='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"%3E%3Crect width="16" height="9" fill="%23897"/%3E%3C/svg%3E';
  const family={id:'original-family',label:'原图片族',kind:'IMAGE',reviewOwner:'MATERIAL',materialProductionPlanId:'MP-FIXTURE',versionRefs:['original-family@V001'],currentVersionId:'original-family@V001',expectedOutputRefs:[],episodeIds:[],sceneIds:[],shotIds:[]};
  const version={id:'original-family@V001',familyId:family.id,label:'原已采用 V001',path:'fixture/original.png',sha256:'a'.repeat(64),outputState:'PRESENT',historyRole:'CURRENT',lifecycleState:'RELEASED',canFlowDownstream:true,mediaUrl:image,preview:image};
  const model={...projected.productionModel,systemConfiguration:{config:configuration},episodes:[],scenes:[],shots:[],materialRequirements:sparse?[]:requirements,materialWorkItems:[],assetFamilies:[family],assetVersions:[version],expectedOutputs:[],workItems:[],workPackages:[]};
  const operations={...capture.responses.operations,snapshotId:snapshot.snapshotId,mutationEtag:'"replacement-fixture"'};
  const directory={graph:f.after,bindings:requirements.map((r:{id:string;requirementHash:string;representationRef:string;stateRef:string})=>({requirementId:r.id,requirementHash:r.requirementHash,entityId:'prop',stateId:r.stateRef,representationId:r.representationRef})),trialBindings:[],staleIds:[],revisionId:'directory-replacement',releaseId:'release-replacement',readOnly:true};
  const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{RuntimeModeProvider}from'./app/runtime-mode';import{AssistantContextProvider}from'./app/assistant/context-provider';import{MaterialProductionCenter,defaultMaterialCenterState}from'./app/material-production-center';import './app/globals.css';const model=${JSON.stringify(model)};function Harness(){const u=new URL(location.href);const[state,setState]=useState({...defaultMaterialCenterState,requirementId:u.searchParams.get('material'),familyId:u.searchParams.get('family'),versionId:u.searchParams.get('version')});return <RuntimeModeProvider hostedReadOnly={false}><AssistantContextProvider><MaterialProductionCenter model={model} snapshotId=${JSON.stringify(snapshot.snapshotId)} stateProjection={null} viewState={state} onViewStateChange={next=>{setState(next);const u=new URL(location.href);for(const[k,v]of Object.entries({material:next.requirementId,family:next.familyId,version:next.versionId}))v?u.searchParams.set(k,v):u.searchParams.delete(k);history.replaceState({},'',u);}} onOpenStoryScene={()=>{}} onOpenConsumer={()=>{}}/></AssistantContextProvider></RuntimeModeProvider>};createRoot(document.getElementById('root')).render(<Harness/>);`;
  const built=buildSync({stdin:{contents:entry,resolveDir:root,sourcefile:'replacement-harness.tsx',loader:'tsx'},bundle:true,platform:'browser',conditions:['style','browser'],format:'iife',jsx:'automatic',write:false,outdir:'virtual-replacement',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'}).outputFiles,js=built.find(f=>f.path.endsWith('.js'))!.text,css=built.filter(f=>f.path.endsWith('.css')).map(f=>f.text).join('\n');
  const errors:string[]=[],unexpected:string[]=[],writes:string[]=[],detailIds:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url()),json=(v:unknown)=>route.fulfill({json:v});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`});
    if(!['GET','HEAD'].includes(r.method())){writes.push(r.method()+' '+url.pathname);return route.fulfill({status:418,body:'No writes allowed'});}
    if(url.pathname==='/api/v8/ui/materials'){const id=url.searchParams.get('requirementId');if(id)detailIds.push(id);const rows=id?requirements.filter((r:{id:string})=>r.id===id):requirements.filter((r:{currentDisposition:string})=>r.currentDisposition.startsWith('CURRENT_'));return json({schemaVersion:'1.0',snapshotId:snapshot.snapshotId,detailState:'COMPLETE',page:{materialRequirements:rows,materialWorkItems:[],assetFamilies:[family],assetVersions:[version],expectedOutputs:[]},count:rows.length,total:rows.length,nextCursor:null,hasMore:false});}
    if(url.pathname==='/api/instance/domain-workspaces')return json({...workspaceProjection({...snapshot,productionModel:model},f.after,'MATERIAL'),releaseId:'release-replacement',revisionId:'after',draft:null,draftHeadRevisionId:null,legacyDrafts:[],readOnly:true});
    if(url.pathname==='/api/instance/material-directory')return json(directory);
    if(url.pathname==='/api/instance/production-preparation')return json({candidate:{revisionId:'prep',contentHash:'b'.repeat(64),episodes:[],scenes:[]},materialLinks:{scenes:[]}});
    if(url.pathname==='/api/v8/operations/snapshot')return json(operations);
    if(url.pathname==='/api/v8/reviews')return json({events:[]});
    if(url.pathname==='/api/v8/asset-versions')return json({events:[]});
    if(url.pathname==='/api/trial/scopes')return json({scopes:[]});
    unexpected.push(r.method()+' '+url.pathname);return route.fulfill({status:418,body:'Unexpected fixture request'});
  });
  return {errors,unexpected,writes,detailIds};
}
const url='http://127.0.0.1:4309/';
test('current directory shows ALL but counts only two atomic leaves, excluding adopted old root',async({page})=>{
  const f=await fixture(page);await page.goto(url);
  await expect(page.locator('[data-entity-total-count="2"]')).toBeVisible();
  await expect(page.locator('[data-canvas-node-id="material:complete-new"]')).toBeAttached();
  await expect(page.locator('[data-canvas-node-id="material:old-broad"]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'媒介：全部媒介，2项需求',exact:true})).toBeVisible();
  expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);
});
test('old exact deep link retains original version and ASSET review; no setup or usage editor',async({page})=>{
  const f=await fixture(page,{sparse:true});await page.goto(url+'?view=materials&material=old-broad&family=original-family&version=original-family%40V001');
  const card=page.locator('[data-material-info-id="old-broad"]');await expect(card.getByRole('heading',{name:'原综合需求，已拆分',exact:true})).toBeVisible();
  await expect(card).toHaveAttribute('data-family-id','original-family');await expect(card.locator('[data-production-version-id]')).toHaveAttribute('data-production-version-id','original-family@V001');
  await expect(card.getByRole('link',{name:'查看新的整套需求'})).toHaveAttribute('href',/material=complete-new/);
  await expect(card.getByRole('button',{name:/建立素材制作资料|修订素材制作资料|复用已通过图片/})).toHaveCount(0);
  await expect(card.locator('.material-review-form')).toBeVisible();expect(new URL(page.url()).searchParams.get('material')).toBe('old-broad');expect(new URL(page.url()).searchParams.get('version')).toBe('original-family@V001');
  expect(new Set(f.detailIds)).toEqual(new Set(['old-broad']));expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);
});
test('sparse ALL detail links exact unloaded children without inventing a default requirement',async({page})=>{
  const f=await fixture(page,{sparse:true});await page.goto(url+'?view=materials&material=complete-new');
  const parts=page.getByRole('region',{name:'素材组成与就绪情况'});await expect(parts).toContainText('0 / 2 项已就绪');
  await expect(parts.getByRole('link',{name:'查看这项素材'})).toHaveCount(2);
  await expect(parts.getByRole('link',{name:'查看这项素材'}).first()).toHaveAttribute('href',/material=leaf-a/);
  await parts.getByRole('link',{name:'查看这项素材'}).first().click();await expect(page.locator('[data-material-info-id="leaf-a"]')).toBeVisible();
  expect(f.detailIds).toContain('leaf-a');expect(f.detailIds).not.toContain('old-broad');expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);
});
test('invalid replacement stays non-current and cannot expose new production actions',async({page})=>{
  const f=await fixture(page,{invalid:true});await page.goto(url+'?view=materials&material=old-broad');
  const warning=page.getByRole('alert').filter({hasText:'素材替代关系暂不可用'});await expect(warning).toContainText('REPLACEMENT SUCCESSOR MISSING');
  await expect(page.getByRole('button',{name:/建立素材制作资料|修订素材制作资料|复用已通过图片/})).toHaveCount(0);await expect(page.locator('[data-entity-total-count="2"]')).toBeVisible();
  expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);
});
