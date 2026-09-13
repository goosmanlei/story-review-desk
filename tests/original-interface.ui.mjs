import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { requiredPhase } from '../tools/process-resources.mjs';
const phase=await requiredPhase(process.cwd());
if(!phase)throw Error('Use the managed process runner');
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913';
const browser=await chromium.launch({channel:'chrome'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const failures=[];
  const paths=['overview','story&storyMode=source','story&storyMode=story-structure','story&storyMode=logic','settings','settings&settingsSection=space','materials','pipeline','system','system&systemTab=configuration','system&systemTab=runtime','system&systemTab=unavailable'];
  const errors=[];page.on('pageerror',e=>errors.push(e.stack));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/'))errors.push(`${r.status()} ${r.url()}`);});
  for(const view of paths){
    errors.length=0;
    await page.goto(base+'/?view='+view,{waitUntil:'networkidle'});
    await page.locator('nav[aria-label="主要工作区"], .review-shell, #overview-title, .workspace-view').first().waitFor({timeout:5000}).catch(()=>{});
    if(view.startsWith('system')){
      const tabs=page.getByRole('tablist',{name:'系统管理模块'});
      await tabs.waitFor();
      assert.deepEqual(await tabs.getByRole('tab').allTextContents(),['使用与初始化','系统配置','数据与运行']);
      if(view.endsWith('systemTab=unavailable'))await page.locator('#management-panel-start h2').waitFor();
    }
    const body=(await page.locator('body').innerText()).slice(0,1800);
    const item={view,errors:[...errors],body};
    if(errors.length)failures.push(item);
    console.log(JSON.stringify({view,errors:[...errors],textLength:body.length}));
  }
  if(failures.length)process.exitCode=1;
}finally{await browser.close();}
