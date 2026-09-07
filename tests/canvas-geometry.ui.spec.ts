import {test,expect,type Page} from '@playwright/test';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {workspaceProjection} from '../host/instance-runtime/domain-workspaces.mjs';
import type {DomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {workflowOverview} from '../host/instance-runtime/workflow-overview.mjs';
import {buildEmptyActionQueueFixture} from './fixtures/empty-action-queue.mjs';

async function fixture(page:Page){
 const profile=blankProfile({title:'画布几何回归',instanceId:'geometry-fixture',projectId:'geometry-story'}),snapshot=blankSnapshot(profile).snapshot,configuration=defaultConfiguration(profile),queue=await buildEmptyActionQueueFixture(snapshot);
 const entity=(id:string,name:string,type:string)=>({id,name,type,description:'合成几何测试，不是故事地理事实。',aliases:[],authority:'A' as const,evidence:[]});
 const graph:DomainGraph={schemaVersion:'1.0',entities:[entity('person','人物甲','CHARACTER'),entity('prop','令牌','PROP'),entity('west','西侧地点','LOCATION'),entity('east','东侧地点','LOCATION')],states:[],representations:[],requirements:[],relations:[]};
 const unexpected:string[]=[],writes:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/assistant/v1/context'&&request.method()==='POST')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  if(request.method()!=='GET'){writes.push(url.pathname);return route.fulfill({status:405,json:{error:'Read-only geometry fixture'}});}
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/v8/action-queue')return json(queue);
  if(url.pathname==='/api/instance/workflow'){const workflow=workflowOverview(snapshot.productionModel,null,{queue,snapshotId:snapshot.snapshotId});return json(url.searchParams.get('workspace')==='1'?{queue,workflow}:workflow);}
  if(url.pathname==='/api/instance/domain-workspaces')return json({...workspaceProjection(snapshot,graph,url.searchParams.get('owner')||'SETTINGS'),releaseId:'geometry-release',revisionId:'geometry-graph',readOnly:true,draft:null,draftHeadRevisionId:null,legacyDrafts:[],spatial:{version:'geometry-1',orientation:'北上东右',sourceRef:'synthetic-map-fixture',sourceSha256:'a'.repeat(64),locations:[{id:'west',name:'西侧地点',pos:[120,140]},{id:'east',name:'东侧地点',pos:[170,140]}],mapCards:[]}});
  if(url.pathname==='/api/instance/setting-extraction')return json({releaseId:'geometry-release',sources:[],results:[],input:null,task:null,capability:{initialize:false},readOnly:true});
  if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'geometry-release',revisionId:'geometry-config',sha256:'a'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null,readOnly:true});
  if(url.pathname==='/api/instance/spatial-settings')return json({status:'NOT_CONFIGURED',snapshotId:snapshot.snapshotId,sourceBinding:null,specification:null});
  if(url.pathname==='/api/instance/sources')return json({releaseId:'geometry-release',readOnly:true,sources:[]});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  if(url.pathname==='/api/v8/operations/snapshot')return json({mutationEtag:'"geometry-fixture"'});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  unexpected.push(url.pathname);return route.fulfill({status:418,json:{error:'Unexpected fixture API'}});
 });return {unexpected,writes,errors};
}
function clean(f:Awaited<ReturnType<typeof fixture>>){expect(f.unexpected).toEqual([]);expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);}

test('正坐标空间按真实对象包围框取景，锚点不移位且不留下原点空白',async({page},info)=>{
 const f=await fixture(page);await page.goto('/?view=settings&settingsSection=space');
 const board=page.getByRole('region',{name:'全局空间与地点',exact:true}),viewport=board.locator('.free-canvas-viewport');
 await expect(viewport).toBeVisible();await board.getByRole('button',{name:'适配全图',exact:true}).click();
 const scale=Number(await viewport.getAttribute('data-canvas-scale'));expect(scale).toBeGreaterThan(.5);
 const bounds=(await viewport.boundingBox())!,nodes=await board.locator('[data-canvas-node-id]').all();
 expect(nodes).toHaveLength(2);
 for(const node of nodes){const rect=(await node.boundingBox())!;expect(rect.x).toBeGreaterThanOrEqual(bounds.x);expect(rect.x+rect.width).toBeLessThanOrEqual(bounds.x+bounds.width);expect(rect.y).toBeGreaterThanOrEqual(bounds.y);expect(rect.y+rect.height).toBeLessThanOrEqual(bounds.y+bounds.height);}
 // Framing now includes the coordinate backdrop and its map title, not just cards.
 const backdrop=board.locator('[data-canvas-background]'),mapBounds=(await backdrop.boundingBox())!;
 expect(mapBounds.x).toBeGreaterThanOrEqual(bounds.x);expect(mapBounds.x+mapBounds.width).toBeLessThanOrEqual(bounds.x+bounds.width);
 expect(mapBounds.y-bounds.y).toBeCloseTo(20+28*scale,1);
 expect(mapBounds.y+mapBounds.height).toBeLessThanOrEqual(bounds.y+bounds.height);
 await expect(backdrop.locator('[data-map-location]')).toHaveCount(2);
 expect(await board.locator('.free-canvas-anchor circle').evaluateAll(nodes=>nodes.map(node=>[node.getAttribute('cx'),node.getAttribute('cy')]))).toEqual([['1920','2240'],['2720','2240']]);
 await expect(page.locator('.settings-compass')).toHaveText('↑ 北　　东 →');await expect(board).toContainText('未登记的街巷连接和路线保持待核');
 await board.screenshot({path:info.outputPath('positive-spatial-bounds.png')});clean(f);
});

test('分类色与图标在实际CSS中一致，节点边色不被旧board样式覆盖',async({page},info)=>{
 const f=await fixture(page);await page.goto('/?view=settings');
 const board=page.getByRole('region',{name:'主体与关联关系',exact:true});await expect(board).toBeVisible();
 const colors:string[]=[],icons:string[]=[];
 for(const[id,label]of [['person','人物'],['prop','道具']]){
  const node=board.locator('[data-canvas-node-id="'+id+'"]'),filterIcon=page.getByRole('navigation',{name:'实体分类',exact:true}).getByRole('button',{name:label,exact:true}).locator('svg');
  await expect(node).toBeVisible();await expect(filterIcon).toHaveCount(1);const color=await filterIcon.evaluate(element=>getComputedStyle(element).color);
  await expect(node).toHaveCSS('border-left-color',color);await expect(node.locator('.free-canvas-symbol')).toHaveCSS('color',color);
  await expect(board.locator('.free-canvas-group').filter({hasText:label})).toHaveCSS('color',color);
  const icon=(await node.locator('.free-canvas-symbol path').getAttribute('d'))!;await expect(filterIcon.locator('path')).toHaveAttribute('d',icon);colors.push(color);icons.push(icon);
 }
 expect(new Set(colors).size).toBe(2);expect(new Set(icons).size).toBe(2);
 await board.screenshot({path:info.outputPath('category-colors.png')});clean(f);
});

test("当前工作仅保留工作链和阶段两级选择，直接连接任务区",async({page},info)=>{
 const f=await fixture(page);await page.goto("/?view=overview");
 const center=page.getByRole("region",{name:"流程驱动的当前工作",exact:true}),chains=center.getByRole("navigation",{name:"三条主体工作链",exact:true});
 await expect(chains.getByRole("button")).toHaveCount(3);
 await expect(center.locator(".free-canvas-viewport")).toHaveCount(0);await expect(center.locator(".workflow-chain-context")).toHaveCount(0);
 for(const label of ["故事 → 剧本","剧本 → 素材","剧本 + 素材 → 全剧制作"]){
  await chains.getByRole("button").filter({has:page.getByText(label,{exact:true})}).click();
  const stages=center.getByRole("navigation",{name:label+"阶段选择",exact:true});await expect(stages).toBeVisible();
  const last=stages.getByRole("button").last();await last.click();await expect(last).toHaveAttribute("aria-pressed","true");
  await expect(center.locator(".workflow-stage-inspector h3")).toHaveText((await last.locator("span").textContent())!);
  await expect(center.locator(".workflow-stage-tasks")).toBeVisible();await expect(center.locator(".free-canvas-viewport")).toHaveCount(0);
 }
 await center.screenshot({path:info.outputPath("current-work-two-level-navigation.png")});clean(f);
});
