import {test,expect,type Page} from '@playwright/test';
import {buildSync} from 'esbuild';
import path from 'node:path';
const site=path.resolve(import.meta.dirname,'..');
async function mount(page:Page,code:string){
 const files=buildSync({stdin:{contents:code,resolveDir:site,sourcefile:'optimization-proof.tsx',loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,outdir:'test-bundle',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_REVIEW_BASE_PATH':'""'}}).outputFiles;
 const bundle=files.find(file=>file.path.endsWith('.js'))!.text,css=files.find(file=>file.path.endsWith('.css'))?.text||'';
 await page.route('**/__optimization-proof',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>'+css+'</style></head><body><div id="root"></div><script>'+bundle.replaceAll('</script','<\\/script')+'</script></body></html>'}));
 await page.goto('/__optimization-proof');
}
test('地点原件及预览均失败时各试一次，不循环请求或错用其他图片',async({page})=>{
 const counts:Record<string,number>={};
 await page.route('**/missing-*',route=>{const name=new URL(route.request().url()).pathname;counts[name]=(counts[name]||0)+1;return route.fulfill({status:404,body:''});});
 await mount(page,`import React from 'react';import{createRoot}from'react-dom/client';import{LocationVisualGallery}from'./app/location-visual-gallery';createRoot(document.getElementById('root')).render(<LocationVisualGallery configuration={{representationTypes:[],stateDimensions:[]}} items={[{entityId:'loc',representationId:'rep',familyId:'family',type:'PLACE',label:'地点原图',dimensions:{},association:'DIRECT',version:{id:'v',sha256:'a'.repeat(64),imageUrl:'/missing-original.png',previewUrl:'/missing-preview.png',lifecycleState:'RELEASED'}}]}/>);`);
 await expect(page.getByText('此版本图片暂不可读取',{exact:true})).toBeVisible();expect(counts).toEqual({'/missing-original.png':1,'/missing-preview.png':1});await expect(page.locator('img')).toHaveCount(0);
});

test('地点图片同页模态预览，Escape只关闭顶层图片并恢复焦点',async({page})=>{
 const popupPages:Page[]=[];page.on('popup',popup=>popupPages.push(popup));
 await page.route('**/fixture-location.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#ac8"/></svg>'}));
 await mount(page,`import React from'react';import{createRoot}from'react-dom/client';import{SettingsDetailDialog}from'./app/settings-detail-dialog';import{SettingsImagePreview}from'./app/settings-image-preview';function Fixture(){const[open,setOpen]=React.useState(true);return open?<SettingsDetailDialog enabled onRequestClose={()=>setOpen(false)}><section><h2>地点详情</h2><SettingsImagePreview src="/fixture-location.svg" label="地点结构"/><button onClick={()=>setOpen(false)}>关闭地点</button></section></SettingsDetailDialog>:<p>地点已关闭</p>;}createRoot(document.getElementById('root')).render(<Fixture/>);`);
 const parent=page.getByRole('dialog',{name:'对象设定详情',exact:true}),trigger=parent.getByRole('button',{name:'放大图片：地点结构',exact:true});
 await trigger.click();const image=page.getByRole('dialog',{name:'地点结构 · 图片预览',exact:true});await expect(image).toBeVisible();
 for(let i=0;i<3;i++){await page.keyboard.press('Tab');expect(await image.evaluate(node=>node.contains(document.activeElement))).toBe(true);}
 await page.keyboard.press('Escape');await expect(image).toHaveCount(0);await expect(parent).toBeVisible();await expect(trigger).toBeFocused();
 await trigger.click();await image.getByRole('button',{name:'关闭图片预览',exact:true}).click();await expect(image).toHaveCount(0);await expect(parent).toBeVisible();
 expect(popupPages).toHaveLength(0);await page.keyboard.press('Escape');await expect(parent).toHaveCount(0);
});

test('独立试制审阅再次点击取消且保留修改意见，不自动提交',async({page})=>{
 let mutations=0;await page.route('**/api/trial/reviews',route=>{mutations++;return route.fulfill({status:500,body:'unexpected mutation'});});
 await mount(page,`import React from'react';import{createRoot}from'react-dom/client';import{AssetReview}from'./app/trial-asset-review';const asset={id:'trial-fixture',mediaId:'m',versionId:'v',sha256:'a'.repeat(64),mediaKind:'AUDIO',mediaUrl:'',version:1,lifecycle:'REVIEW_PENDING',metadata:{},prompt:'test-only',qa:{},reviewCriteria:[{id:'quality',label:'表现',description:'核对表现'}]};createRoot(document.getElementById('root')).render(<AssetReview asset={asset} etag="test-only" refresh={async()=>{}} currentVersion/>);`);
 const pass=page.getByRole('radio',{name:'符合',exact:true}),fail=page.getByRole('radio',{name:'需要修改',exact:true});
 await pass.click();await expect(pass).toBeChecked();await pass.click();await expect(pass).not.toBeChecked();
 await fail.click();await expect(fail).toBeChecked();await page.getByLabel('表现的修改意见（选填）').fill('保留这个意见');
 await fail.click();await expect(fail).not.toBeChecked();await fail.click();await expect(page.getByLabel('表现的修改意见（选填）')).toHaveValue('保留这个意见');expect(mutations).toBe(0);
});
