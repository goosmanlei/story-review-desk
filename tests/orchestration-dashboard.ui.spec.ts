import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import path from 'node:path';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {dashboardFixture} from './fixtures/orchestration-dashboard.mjs';
import type {OrchestrationDashboard} from '../host/instance-runtime/orchestration-dashboard.mjs';

const profile=blankProfile({title:'协作状态验收',instanceId:'orchestration-ui',projectId:'orchestration-story'});
const snapshot=blankSnapshot(profile).snapshot,configuration=defaultConfiguration(profile);
async function fixture(page:Page,{empty=false}={}){
  const writes:string[]=[],errors:string[]=[],reads:string[]=[];
  let fail=false,value:OrchestrationDashboard=await dashboardFixture({empty});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
    if(request.method()!=='GET'){writes.push(`${request.method()} ${url.pathname}`);return route.fulfill({status:405,json:{error:'Write rejected'}});}
    if(url.pathname==='/api/instance/orchestration'){
      reads.push(url.search);
      if(fail)return route.fulfill({status:503,json:{error:'PRIVATE_SERVER_ERROR'}});
      return json({...value,completed:empty?value.completed:(await dashboardFixture({completedPage:Number(url.searchParams.get('completedPage')||0)})).completed});
    }
    if(url.pathname==='/api/instance/profile')return json(profile);
    if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
    if(url.pathname==='/api/v8/operations')return json({snapshotId:snapshot.snapshotId,events:[],sourceOperationEvents:[],creativeRevisionEvents:[]});
    if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
    if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'fixture',revisionId:null,sha256:null,history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
    if(url.pathname==='/api/instance/maintenance')return json({runtime:{status:'READY'},storage:{provider:'postgresql'},backups:[],operations:[],capabilities:{}});
    return route.fulfill({status:404,json:{error:'Outside fixture'}});
  });
  return {writes,errors,reads,setFailure:(enabled:boolean)=>{fail=enabled;},setValue:(next:OrchestrationDashboard)=>{value=next;},getValue:()=>value};
}
const url='/?view=system&systemTab=orchestration';
test('four tabs preserve deep links, reload, keyboard navigation and the existing panels',async({page})=>{
  const f=await fixture(page,{empty:true});await page.goto(url);
  const tab=page.getByRole('tab',{name:'多 Agent 协作',exact:true});
  await expect(tab).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tablist',{name:'系统管理模块'}).getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('tabpanel',{name:'多 Agent 协作',exact:true})).toHaveAttribute('id','management-panel-orchestration');
  await expect(tab).toHaveAttribute('aria-controls','management-panel-orchestration');
  await page.reload();await expect(tab).toHaveAttribute('aria-selected','true');
  await tab.focus();await page.keyboard.press('ArrowLeft');await expect(page.getByRole('tab',{name:'数据与运行',exact:true})).toBeFocused();await expect(page.getByRole('heading',{name:'这个故事的数据与运行'})).toBeVisible();
  await page.keyboard.press('ArrowLeft');await expect(page.getByRole('tab',{name:'系统配置',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'项目设定',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'系统配置',exact:true}).focus();await page.keyboard.press('Home');await expect(page.getByRole('tab',{name:'使用与初始化',exact:true})).toBeFocused();await expect(page.getByRole('heading',{name:'系统初始化'})).toBeVisible();
  await page.keyboard.press('End');await expect(tab).toBeFocused();await expect(page).toHaveURL(/systemTab=orchestration/);
  await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'使用与初始化',exact:true})).toBeFocused();
  await page.goBack();await expect(tab).toHaveAttribute('aria-selected','true');
  expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

test('observed pools, actual model, dependencies, QA, rework, decisions and paged completion are readable at 390px with zero writes',async({page},info)=>{
  const f=await fixture(page);await page.goto(url);
  await expect(page.getByRole('heading',{name:'Worker 状态'})).toBeVisible();
  const dev=page.getByRole('region',{name:'开发 Worker',exact:true});
  await expect(dev).toContainText('gpt-test');await expect(dev).toContainText('推理强度：high');await expect(dev).toContainText('1 个名额等待执行核查');
  const pool=await dev.locator('dl>div').evaluateAll(nodes=>nodes.map(n=>n.textContent));expect(pool).toEqual(['配置并发3','运行1','等待4','可用名额1']);
  await expect(page.getByRole('region',{name:'创作质检 Worker',exact:true})).toContainText('实际模型：未记录');
  await dev.getByRole('link',{name:'实现协作页面',exact:true}).click();await expect(page).toHaveURL(/#orchestration-task-working/);
  await expect(page.locator('#orchestration-task-working')).toBeInViewport();
  await expect(page.locator('#orchestration-queue').locator('..')).toContainText('前置任务：实现协作页面（未完成）');
  await expect(page.locator('#orchestration-processing').locator('..')).toContainText('等待独立质检');
  await expect(page.locator('#orchestration-processing').locator('..')).toContainText('等待返修');
  await expect(page.locator('#orchestration-decisions').locator('..')).toContainText('质检轮数已达上限');
  await expect(page.locator('#orchestration-completed').locator('..')).toContainText('质检未通过 · 本轮结束');
  await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('#orchestration-completed').locator('..')).toContainText('已取消任务');
  await expect(page.locator('#orchestration-completed').locator('..')).toContainText('已由返修版本替代');
  await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'上一页',exact:true}).click();await expect(page.getByRole('navigation',{name:'已完成任务分页'})).toContainText('第 1 页');
  await page.screenshot({path:info.outputPath('dashboard-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole('tab',{name:'多 Agent 协作',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('dashboard-390.png'),fullPage:true});
  await expect(page.getByRole('tabpanel')).not.toContainText('SENTINEL');
  for(const name of ['启动','暂停','重试','取消','扩容','缩容'])await expect(page.getByRole('tabpanel').getByRole('button',{name,exact:true})).toHaveCount(0);
  expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

test('manual refresh covers empty, paused, stopped, unknown host and errors without exposing raw diagnostics',async({page})=>{
  const f=await fixture(page,{empty:true});await page.goto(url);
  for(const text of ['当前没有正在处理的任务。','任务队列为空。','没有待用户决策。','尚无已完成任务（含已取消及已替代记录）。'])await expect(page.getByText(text,{exact:true})).toBeVisible();
  await expect(page.getByText('UNKNOWN · 后台状态未确认',{exact:true})).toBeVisible();
  for(const status of ['PAUSED','STOPPED']){f.setValue({...f.getValue(),mode:{enabled:true,status},scheduler:{hostStatus:'BLOCKED',heartbeatAt:null,blocked:true}});await page.getByRole('button',{name:'手动刷新'}).click();await expect(page.getByText(`(${status})`,{exact:true})).toBeVisible();await expect(page.getByText('调度受阻，等待主会话处理')).toBeVisible();}
  f.setFailure(true);await page.getByRole('button',{name:'手动刷新'}).click();await expect(page.getByRole('alert')).toContainText('下方保留上次读取结果');await expect(page.getByRole('alert')).not.toContainText('PRIVATE_SERVER_ERROR');
  f.setFailure(false);await page.getByRole('button',{name:'手动刷新'}).click();await expect(page.getByRole('alert')).toHaveCount(0);
  f.setFailure(true);await page.reload();await expect(page.getByRole('alert')).toContainText('协作状态暂时无法读取');await expect(page.getByRole('heading',{name:'Worker 状态'})).toHaveCount(0);
  expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

test('automatic GETs stop at their bound, on idle/error, while hidden and after unmount',async({page})=>{
  const f=await fixture(page);await page.clock.install();await page.goto(url);await expect(page.getByRole('heading',{name:'Worker 状态'})).toBeVisible();
  const initial=f.reads.length;
  for(let i=0;i<60;i++){await page.clock.runFor(5001);await expect.poll(()=>f.reads.length).toBe(initial+i+1);await expect(page.getByRole('button',{name:'手动刷新'})).toBeEnabled();}
  await expect(page.getByText('本轮自动刷新已达上限，请手动刷新。')).toBeVisible();await page.clock.runFor(20000);expect(f.reads.length).toBe(initial+60);
  await page.getByRole('button',{name:'手动刷新'}).click();await expect.poll(()=>f.reads.length).toBe(initial+61);
  // 请求计数只证明已发出；先等读取完成，避免虚拟时钟把在途请求推到超时。
  await expect(page.getByRole('button',{name:'手动刷新'})).toBeEnabled();await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await expect(page.getByText('页面不可见，自动刷新已暂停。',{exact:true})).toBeVisible();await page.clock.runFor(10000);expect(f.reads.length).toBe(initial+61);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.getByText('有运行中或排队任务时每 5 秒刷新，最多 60 次；读取失败或离开页面即停止。',{exact:true})).toBeVisible();
  f.setValue({...f.getValue(),autoRefresh:false});await page.clock.runFor(5001);await expect.poll(()=>f.reads.length).toBe(initial+62);await expect(page.getByRole('button',{name:'手动刷新'})).toBeEnabled();await page.clock.runFor(10000);expect(f.reads.length).toBe(initial+62);
  f.setValue({...f.getValue(),autoRefresh:true});f.setFailure(true);await page.getByRole('button',{name:'手动刷新'}).click();await expect(page.getByRole('alert')).toBeVisible();const failed=f.reads.length;await page.clock.runFor(20000);expect(f.reads.length).toBe(failed);
  f.setFailure(false);await page.getByRole('button',{name:'手动刷新'}).click();await expect(page.getByRole('button',{name:'手动刷新'})).toBeEnabled();const beforeLeave=f.reads.length;
  await page.getByRole('tab',{name:'使用与初始化',exact:true}).click();await page.clock.runFor(20000);expect(f.reads.length).toBe(beforeLeave);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

test('hosted component issues no ledger request and shows local-only notice',async({page})=>{
  const requests:string[]=[];await page.route('**/api/**',route=>{requests.push(route.request().url());return route.fulfill({status:500,body:'must not read'});});
  const code=`import React from 'react';import {createRoot} from 'react-dom/client';import {RuntimeModeProvider} from './app/runtime-mode';import {OrchestrationDashboard} from './app/orchestration-dashboard';createRoot(document.getElementById('root')).render(<RuntimeModeProvider hostedReadOnly={true}><OrchestrationDashboard/></RuntimeModeProvider>);`;
  const files=buildSync({stdin:{contents:code,resolveDir:path.resolve(import.meta.dirname,'..'),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_REVIEW_BASE_PATH':'""'}}).outputFiles;
  const bundle=files[0].text;
  await page.route('**/__orchestration-hosted',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><div id="root"></div><script>${bundle.replaceAll('</script','<\\/script')}</script></body></html>`}));
  await page.goto('/__orchestration-hosted');await expect(page.getByRole('heading',{name:'多 Agent 协作',exact:true})).toBeVisible();await expect(page.getByText('协作状态仅在本地实例可用。',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'手动刷新'})).toHaveCount(0);expect(requests).toEqual([]);
});
