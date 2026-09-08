import {test,expect} from '@playwright/test';
const open=async(page:import('@playwright/test').Page)=>{await page.goto('/?view=system#system-configuration');await page.getByRole('button',{name:'审阅标准',exact:true}).click();await expect(page.getByRole('navigation',{name:'审阅模块与标准目录'})).toBeVisible();};
test('hierarchy, shared aliases, inline editing, saved drafts and immutable bound standards',async({page,request,baseURL})=>{
 if(new URL(baseURL!).port!=='4197')throw Error('Mutation test requires isolated instance');
 const original=await request.get('/api/instance/configuration').then(r=>r.json());
 await open(page);
 const panel=page.getByRole('region',{name:'当前审阅标准'});
 await expect(panel.getByRole('heading',{name:'分集剧情设计'})).toBeVisible();
 await expect(page.getByLabel('适用对象',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'素材审阅',exact:true}).click();
 await page.getByRole('button',{name:'人物身份',exact:true}).click();
 await panel.locator('.standard-criterion').first().locator('summary').first().click();
 const title='身份与外观配置测试';await panel.getByLabel('判断标题',{exact:true}).first().fill(title);
 await page.getByRole('button',{name:'制作审阅',exact:true}).click();
 for(const label of ['镜头方案与预演','镜头成品','场景成片','分集成片','全剧交付'])await expect(page.locator('.standard-group > summary').filter({hasText:label}).first()).toBeVisible();
 await page.getByRole('button',{name:'素材审阅',exact:true}).click();await page.getByRole('button',{name:'人物身份',exact:true}).click();
 await expect(panel.getByText(title,{exact:true})).toBeVisible();
 await panel.locator('.standard-usage > summary').click();await panel.locator('.standard-bound > summary').first().click();
 await expect(panel.getByText('原对象必须保留的服装要求',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByText('草稿已保存，当前有效规则保持原版本')).toBeVisible();
 const draft=await request.get('/api/instance/configuration').then(r=>r.json());expect(draft.revisionId).toBe(original.revisionId);
 await page.getByRole('button',{name:'预览影响',exact:true}).click();await expect(page.getByText('影响预览已完成')).toBeVisible();
 await page.getByRole('button',{name:'发布配置',exact:true}).click();await expect(page.getByText('配置已发布，当前实例已生效')).toBeVisible();
 const after=await request.get('/api/instance/configuration').then(r=>r.json());expect(after.boundStandards).toEqual(original.boundStandards);expect(after.bindings).toEqual(original.bindings);
 await page.reload();await page.getByRole('button',{name:'审阅标准',exact:true}).click();await expect(page.getByRole('navigation',{name:'审阅模块与标准目录'})).toBeVisible();
 await page.getByRole('button',{name:'素材审阅',exact:true}).click();await page.getByRole('button',{name:'人物身份',exact:true}).click();await expect(panel.getByText(title,{exact:true})).toBeVisible();
});
test('390px directory and editor are usable without horizontal overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});await open(page);
 await page.getByRole('button',{name:'制作审阅',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
 await page.locator('.standard-group > summary').filter({hasText:'场景成片'}).first().click();
 // Use a visible root group regardless of its prior browser toggle state.
 await page.getByRole('button',{name:'故事审阅',exact:true}).click();
 await expect(page.getByRole('heading',{name:'分集剧情设计',exact:true})).toBeVisible();
 await page.screenshot({path:test.info().outputPath('configuration-mobile.png'),fullPage:true});
});
test('leaving unsaved configuration can be cancelled, while saved-draft preview never targets an unseen draft',async({page})=>{
 await open(page);const panel=page.getByRole('region',{name:'当前审阅标准'});
 await expect(page.getByRole('button',{name:'预览影响',exact:true})).toBeDisabled();
 await panel.getByLabel('标准名称',{exact:true}).fill('未保存的分集规则');
 page.once('dialog',dialog=>dialog.dismiss());
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'当前工作',exact:true}).click();
 await expect(panel.getByLabel('标准名称',{exact:true})).toHaveValue('未保存的分集规则');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'当前工作',exact:true}).click();
 await expect(page.getByRole('navigation',{name:'审阅模块与标准目录'})).toHaveCount(0);
});
