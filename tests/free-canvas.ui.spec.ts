import {test,expect,type Page,type Locator} from '@playwright/test';
import {spatialMapBackground} from '../app/spatial-map-backdrop';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {type DomainGraph} from '../host/instance-runtime/domain-model.mjs';
import {workspaceProjection} from '../host/instance-runtime/domain-workspaces.mjs';

async function canvasFixture(page:Page,{readonly=false,conflict=false,large=false,focusGraph=false,curves=false,spatialBackground=false}={}){
 const profile=blankProfile({title:'自由画布回归',instanceId:'free-canvas-fixture',projectId:'canvas-story'}),snapshot=blankSnapshot(profile).snapshot,configuration=defaultConfiguration(profile);
 const entity=(id:string,name:string,type='CHARACTER')=>({id,name,type,description:`${name}的原始说明`,aliases:[],authority:'A' as const,evidence:[]});
 const graph:DomainGraph={schemaVersion:'1.0',entities:[entity('a','人物甲'),entity('b','人物乙'),entity('west','西侧地点','LOCATION'),entity('east','东侧地点','LOCATION'),entity('unknown','未知地点','LOCATION')],states:[],representations:[],requirements:[],relations:[{id:'knows',type:'SOCIAL',from:{kind:'ENTITY',id:'a'},to:{kind:'ENTITY',id:'b'},label:'共同经营',purpose:'',inherit:[],exclude:[],scope:[],authority:'A',evidence:[],status:'CONFIRMED'}]};
 if(focusGraph){
  graph.entities.push(entity('prop','记账簿','PROP'),entity('c','人物丙'),entity('d','人物丁'),entity('alone','独立人物'));
  const relation=(id:string,from:string,to:string,label:string)=>({id,type:'SOCIAL',from:{kind:'ENTITY' as const,id:from},to:{kind:'ENTITY' as const,id:to},label,purpose:'',inherit:[],exclude:[],scope:[],authority:'A' as const,evidence:[],status:'CONFIRMED' as const});
  graph.relations.push(relation('owns','a','prop','保管账簿'),relation('reads','prop','c','阅读账簿'),relation('unrelated','c','d','同乡'),relation('visits','a','west','到访西侧地点'),{...relation('historical','a','d','旧版认识'),historicalOnly:true},{...relation('wrong-kind','a','alone','同名但不同类型身份'),from:{kind:'REPRESENTATION',id:'a'}});
 }
 if(curves){
  const directedType=workspaceProjection(snapshot,graph,'SETTINGS').configuration.relationTypes.find(type=>type.directed);if(!directedType)throw new Error('曲线测试需要真实配置的有向关系类型');
  graph.relations.push({...graph.relations[0],id:'knows-proposed',type:directedType.id,label:'尚待核对的委托',status:'PROPOSED'},{...graph.relations[0],id:'knows-reverse',type:directedType.id,from:{kind:'ENTITY',id:'b'},to:{kind:'ENTITY',id:'a'},label:'反向偿还'});
 }
 if(large)graph.entities.push(...Array.from({length:198},(_,index)=>entity('extra-'+index,'压力实体 '+index)));
 const spatial={version:'fixture-1',orientation:'北上东右',sourceRef:'data/production_map_spec.json',sourceSha256:'a'.repeat(64),locations:[{id:'west',name:'西侧地点',pos:[20,40],fact:'西侧为已登记位置',lock:'北上东右',zone:'西片区'},{id:'east',name:'东侧地点',pos:[70,40],fact:'东侧为已登记位置',lock:'北上东右',zone:'东片区'}],mapCards:[]};
 if(spatialBackground){for(let i=0;i<12;i++){const id='map-place-'+i;graph.entities.push(entity(id,'位置 '+i,'LOCATION'));spatial.locations.push({id,name:'位置 '+i,pos:[5+i%4*25,5+Math.floor(i/4)*30],fact:'fixture坐标',lock:'北上东右',zone:i%2?'东片区':'西片区'});}spatial.locations.push({id:'unknown',name:'未知地点',pos:[Number.NaN,4],fact:'无有效坐标',lock:'UNKNOWN',zone:'UNKNOWN'});}
 const mutations:Record<string,unknown>[]=[],unexpected:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url()),json=(value:unknown)=>route.fulfill({json:value});
  if(url.pathname==='/api/instance/profile')return json(profile);
  if(url.pathname==='/api/v8/ui/bootstrap')return json({data:snapshot,snapshotId:snapshot.snapshotId});
  if(url.pathname==='/api/instance/domain-workspaces'){
   if(request.method()!=='GET'){const body=request.postDataJSON();mutations.push(body);return route.fulfill({status:readonly?405:409,json:{error:readonly?'只读':'CAS_CONFLICT：源修订已变化；本地修改保留'}});}
   return json({...workspaceProjection(snapshot,graph,url.searchParams.get('owner')||'SETTINGS'),releaseId:conflict?'release-new':'release-1',revisionId:'graph-1',readOnly:readonly,draft:null,draftHeadRevisionId:null,legacyDrafts:[],spatial});
  }
  if(url.pathname==='/api/instance/setting-extraction')return json({releaseId:'release-1',sources:[],results:[],input:null,task:null,capability:{initialize:false},readOnly:readonly});
  if(url.pathname==='/api/instance/configuration')return json({configuration,defaults:configuration,releaseId:'release-1',revisionId:'config-1',sha256:'a'.repeat(64),history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:true,draft:null});
  if(url.pathname==='/api/instance/spatial-settings')return json({status:'NOT_CONFIGURED',snapshotId:snapshot.snapshotId,sourceBinding:null,specification:null});
  if(url.pathname==='/api/instance/sources')return json({releaseId:'release-1',readOnly:readonly,sources:[]});
  if(url.pathname==='/api/instance/documents')return json({documents:[]});
  if(url.pathname==='/api/v8/operations/snapshot')return json({mutationEtag:'"canvas-fixture"'});
  if(url.pathname==='/api/assistant/v1/conversations')return json({conversations:[],bridge:{online:false},pagination:{}});
  if(url.pathname==='/api/assistant/v1/context')return json({context:{focus:request.postDataJSON().focus,resources:[],missing:[],draftTargets:[]}});
  unexpected.push(request.method()+' '+url.pathname);return route.fulfill({status:418,json:{error:'UNEXPECTED_FIXTURE_API'}});
 });return {graph,spatial,configuration:workspaceProjection(snapshot,graph,'SETTINGS').configuration,mutations,unexpected,errors};
}

test('自由画布支持空白拖动、滚轮锚点缩放、按钮缩放与键盘适配',async({page})=>{
 const fixture=await canvasFixture(page);await page.goto('/?view=settings');
 const canvas=page.getByRole('group',{name:'主体与关联关系画板',exact:true});await expect(canvas).toBeVisible();await canvas.scrollIntoViewIfNeeded();
 const rect=await canvas.boundingBox();if(!rect)throw new Error('画布没有尺寸');
 const beforeX=Number(await canvas.getAttribute('data-canvas-x')),beforeScale=Number(await canvas.getAttribute('data-canvas-scale'));
 const start={x:rect.x+24,y:rect.y+24};expect(await canvas.evaluate((element,point)=>document.elementFromPoint(point.x,point.y)===element,start),'拖动起点必须是画布空白，不是悬浮助手或节点').toBeTruthy();
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+80,start.y+50,{steps:8});await page.mouse.up();
 await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-x'))).toBeGreaterThan(beforeX+70);
 await page.mouse.wheel(0,-100);await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeGreaterThan(beforeScale);
 const zoomed=Number(await canvas.getAttribute('data-canvas-scale'));await page.getByRole('button',{name:'缩小画板',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeLessThan(zoomed);
 await canvas.focus();await canvas.press('Home');await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeCloseTo(beforeScale,3);
 const fittedX=Number(await canvas.getAttribute('data-canvas-x'));await canvas.press('ArrowRight');await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-x'))).toBeCloseTo(fittedX-40,0);
 expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('主体节点固定不可拖动，点击只高亮真实关联，不弹详情或写入',async({page})=>{
 const fixture=await canvasFixture(page);await page.goto('/?view=settings');
 const node=page.locator('[data-canvas-node-id="a"]'),canvas=page.getByRole('group',{name:'主体与关联关系画板',exact:true});await expect(node).toBeVisible();await node.scrollIntoViewIfNeeded();
 const originalX=await node.getAttribute('data-canvas-node-x'),originalY=await node.getAttribute('data-canvas-node-y'),canvasWidth=(await canvas.boundingBox())!.width,rect=(await node.boundingBox())!;
 await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+70,rect.y+rect.height/2+35,{steps:10});await page.mouse.up();
 await expect(node).toHaveAttribute('data-canvas-node-x',originalX!);await expect(node).toHaveAttribute('data-canvas-node-y',originalY!);await expect(page.getByRole('button',{name:'取消高亮',exact:true})).toBeDisabled();
 await node.focus();await node.press('Alt+ArrowRight');await expect(node).toHaveAttribute('data-canvas-node-x',originalX!);
 await node.press('Enter');await expect(node).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'取消高亮',exact:true})).toBeEnabled();expect(new URL(page.url()).searchParams.has('settingsEntity')).toBe(false);
 expect((await canvas.boundingBox())!.width).toBeCloseTo(canvasWidth,0);await expect(page.getByRole('button',{name:'重置个人布局',exact:true})).toHaveCount(0);await expect(page.locator('.free-canvas-help')).not.toContainText('拖动卡片');
 expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('主体关系文字不打开详情，显式永久关系深链仍可核对和关闭',async({page})=>{
 const fixture=await canvasFixture(page);await page.goto('/?view=settings');const label=page.locator('button[data-canvas-edge="knows"]');await expect(label).toBeVisible();await expect(label).toBeEnabled();await expect(page.getByRole('dialog')).toHaveCount(0);expect(new URL(page.url()).searchParams.has('settingsRelation')).toBe(false);
 await page.goto('/?view=settings&settingsRelation=knows');await expect(page).toHaveURL(/settingsRelation=knows/);const dialog=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(dialog.getByRole('heading',{name:'关系定义',exact:true})).toBeVisible();await expect(dialog.getByRole('heading',{name:'共同经营',exact:true})).toBeVisible();await dialog.getByRole('button',{name:'关闭对象详情',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(label).toBeEnabled();expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('空间全局保留北上东右及原始锚点，未知地点不冒充已登记坐标',async({page})=>{
 const fixture=await canvasFixture(page,{readonly:true});await page.goto('/?view=settings&settingsSection=space');const board=page.getByRole('region',{name:'全局空间与地点',exact:true});await expect(board).toBeVisible();await expect(page.locator('.settings-compass')).toHaveText('↑ 北　　东 →');
 await expect(page.getByRole('region',{name:'位置待核地点',exact:true})).toContainText('UNKNOWN：未登记全局位置');await expect(page.locator('[data-canvas-node-id="unknown"]')).toHaveCount(0);await expect(page.getByRole('region',{name:'位置待核地点',exact:true}).getByRole('button',{name:/未知地点/})).toBeVisible();
 const anchors=board.locator('.free-canvas-anchor circle'),before=await anchors.evaluateAll(nodes=>nodes.map(node=>({x:node.getAttribute('cx'),y:node.getAttribute('cy')})));expect(before).toEqual([{x:'320',y:'640'},{x:'1120',y:'640'}]);
 const node=page.locator('[data-canvas-node-id="west"]');await node.focus();await node.press('Alt+ArrowRight');expect(await anchors.evaluateAll(nodes=>nodes.map(node=>({x:node.getAttribute('cx'),y:node.getAttribute('cy')})))).toEqual(before);
 await node.press('Enter');const dialog=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(dialog).toContainText('西侧为已登记位置');await expect(dialog.getByRole('button',{name:'编辑此项',exact:true})).toHaveCount(0);expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('移动端空间画布和只读详情无页面横向溢出，模态背景不能获得Tab焦点',async({page})=>{
 const fixture=await canvasFixture(page,{readonly:true});await page.setViewportSize({width:390,height:844});await page.goto('/?view=settings&settingsSection=space');await page.locator('[data-canvas-node-id="west"]').click();const dialog=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(dialog).toBeVisible();
 for(let index=0;index<10;index++){await page.keyboard.press('Tab');expect(await dialog.evaluate(node=>node.contains(document.activeElement))).toBeTruthy();}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);await expect(page.getByRole('button',{name:'编辑此项',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/确认本模块更新/})).toHaveCount(0);expect(fixture.mutations).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('大图默认可阅读，适配全图能包含全部节点且可一键回到阅读比例',async({page})=>{
 const fixture=await canvasFixture(page,{large:true});await page.goto('/?view=settings');const canvas=page.getByRole('group',{name:'主体与关联关系画板',exact:true});await expect(canvas).toBeVisible();await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeGreaterThanOrEqual(.5);
 await page.getByRole('button',{name:'适配全图',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeLessThan(.12);
 const viewport=(await canvas.boundingBox())!;for(const id of ['a','extra-197']){const box=(await page.locator(`[data-canvas-node-id="${id}"]`).boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(viewport.x);expect(box.x+box.width).toBeLessThanOrEqual(viewport.x+viewport.width);expect(box.y).toBeGreaterThanOrEqual(viewport.y);expect(box.y+box.height).toBeLessThanOrEqual(viewport.y+viewport.height);}
 await page.getByRole('button',{name:'阅读比例',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeGreaterThanOrEqual(.5);expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('模态中的编辑仍使用精确CAS，冲突保留作者修改且不会自动重试',async({page})=>{
 const fixture=await canvasFixture(page,{conflict:true});await page.goto('/?view=settings&settingsEntity=a');const dialog=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'编辑此项',exact:true}).click();const name=dialog.getByLabel('实体名称',{exact:true});await name.fill('未保存作者名称');await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('CAS_CONFLICT');await expect(name).toHaveValue('未保存作者名称');expect(fixture.mutations).toHaveLength(1);expect(fixture.mutations[0]).toMatchObject({action:'save',owner:'SETTINGS',expectedReleaseId:'release-new',expectedDraftRevisionId:null});await expect(dialog.getByRole('button',{name:'确认本模块更新',exact:true})).toBeDisabled();await page.waitForTimeout(350);expect(fixture.mutations).toHaveLength(1);expect(fixture.errors).toEqual([]);
});

test('主体分类按钮整合类型图标，移除重复图例和列表，大画布保持全宽',async({page})=>{
 const fixture=await canvasFixture(page);await page.setViewportSize({width:1440,height:1000});await page.goto('/?view=settings');
 const filters=page.getByRole('navigation',{name:'实体分类',exact:true}),board=page.getByRole('region',{name:'主体与关联关系',exact:true}),canvas=board.getByRole('group',{name:'主体与关联关系画板',exact:true});await expect(canvas).toBeVisible();
 for(const type of fixture.configuration.entityTypes.filter(type=>type.id!=='LOCATION'))await expect(filters.getByRole('button',{name:type.label,exact:true}).locator('svg')).toHaveCount(1);
 await expect(page.locator('.settings-canvas-legend')).toHaveCount(0);await expect(board.locator('.board-readable-list')).toHaveCount(0);await expect(board.getByText('按列表浏览全部实体与关系',{exact:true})).toHaveCount(0);
 expect((await canvas.boundingBox())!.height).toBeGreaterThan(760);expect((await board.boundingBox())!.width).toBeGreaterThan((await page.locator('.settings-browse').boundingBox())!.width*.95);
 expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

/** Compare geometry in one browser frame. Outer scrolling is deliberately
 * excluded; node positions, curve bytes, label positions and camera are not. */
async function graphGeometry(board:Locator){
 return board.evaluate(root=>{
  const viewport=root.querySelector<HTMLElement>('.free-canvas-viewport')!,v=viewport.getBoundingClientRect();
  const rect=(node:Element)=>{const b=node.getBoundingClientRect();return {x:Math.round((b.x-v.x)*1000)/1000,y:Math.round((b.y-v.y)*1000)/1000,width:Math.round(b.width*1000)/1000,height:Math.round(b.height*1000)/1000};};
  return {camera:{x:viewport.dataset.canvasX,y:viewport.dataset.canvasY,scale:viewport.dataset.canvasScale},
   nodes:[...root.querySelectorAll<HTMLElement>('[data-canvas-node-id]')].map(n=>({id:n.dataset.canvasNodeId,worldX:n.dataset.canvasNodeX,worldY:n.dataset.canvasNodeY,...rect(n)})),
   edges:[...root.querySelectorAll<SVGPathElement>('path[data-canvas-edge-path]')].map(p=>({id:p.dataset.canvasEdgePath,from:p.dataset.canvasEdgeFrom,to:p.dataset.canvasEdgeTo,d:p.getAttribute('d')})),
   labels:[...root.querySelectorAll<HTMLElement>('button[data-canvas-edge]')].map(n=>({id:n.dataset.canvasEdge,left:n.style.left,top:n.style.top,styleWidth:n.style.width,...rect(n)})),
   captions:[...root.querySelectorAll<SVGPathElement>('path[data-canvas-caption-for]')].map(p=>({id:p.dataset.canvasCaptionFor,d:p.getAttribute('d')}))};
 });
}
async function expectGraphUnchanged(board:Locator,original:Awaited<ReturnType<typeof graphGeometry>>){
 const actual=await graphGeometry(board);
 const stable=(geometry:typeof original)=>({...geometry,nodes:geometry.nodes.map(({x,y,width,height,...identity})=>identity),labels:geometry.labels.map(({x,y,width,height,...identity})=>identity)});
 // Identity, all world coordinates, exact curve bytes, label layout styles and
 // camera are strict. Browser subpixel subtraction alone gets a 0.01px epsilon.
 expect(stable(actual)).toEqual(stable(original));
 for(const collection of ['nodes','labels'] as const)for(let i=0;i<original[collection].length;i++)for(const field of ['x','y','width','height'] as const)expect(Math.abs(actual[collection][i][field]-original[collection][i][field]),collection+' '+original[collection][i].id+' '+field).toBeLessThanOrEqual(.01);
}
async function assertEmphasis(board:Locator,selected:string|null,edges:DomainGraph['relations'],expectedNodes:string[]){
 const incident=selected?edges.filter(e=>e.from.id===selected||e.to.id===selected):[];
 const highlighted=new Set(selected?[selected,...incident.flatMap(e=>[e.from.id,e.to.id])]:[]);
 for(const id of expectedNodes){
  const node=board.locator('[data-canvas-node-id="'+id+'"]');
  await expect(node).toHaveAttribute('data-canvas-node-related',selected?(highlighted.has(id)?'true':'false'):'none');
  await expect(node).toHaveAttribute('aria-pressed',String(id===selected));
  if(selected&&highlighted.has(id)){await expect(node).toHaveClass(/is-related/);await expect(node).toHaveCSS('opacity','1');}
  else if(selected){await expect(node).toHaveClass(/is-muted/);expect(await node.evaluate(n=>Number(getComputedStyle(n).opacity))).toBeLessThan(1);}
  else{await expect(node).not.toHaveClass(/is-muted|is-related/);await expect(node).toHaveCSS('opacity','1');}
 }
 for(const edge of edges){
  const active=incident.some(e=>e.id===edge.id),path=board.locator('path[data-canvas-edge-path="'+edge.id+'"]'),label=board.locator('button[data-canvas-edge="'+edge.id+'"]');
  await expect(path).toHaveAttribute('data-canvas-related',String(active));await expect(label).toBeEnabled();
  if(active){await expect(path).toHaveClass(/is-related/);await expect(label).toHaveClass(/is-related/);expect(await path.evaluate(p=>Number(getComputedStyle(p).opacity))).toBe(1);expect(await path.evaluate(p=>parseFloat(getComputedStyle(p).strokeWidth))).toBeGreaterThanOrEqual(3);expect(await label.evaluate(n=>getComputedStyle(n).color)).toBe(await path.evaluate(n=>getComputedStyle(n).stroke));}
  else{await expect(path).not.toHaveClass(/is-related/);await expect(label).not.toHaveClass(/is-related/);if(selected){expect(await path.evaluate(p=>Number(getComputedStyle(p).opacity))).toBeLessThan(.5);expect(await label.evaluate(p=>Number(getComputedStyle(p).opacity))).toBeLessThan(.6);}}
 }
 return {incident:incident.map(e=>e.id).sort(),highlighted:[...highlighted].sort()};
}

for(const width of [1440,390])for(const category of ['ALL','CHARACTER'] as const)test(width+'px 主体'+category+'全图点选不删节点连线或重排，只高亮直接邻居并可取消',async({page},info)=>{
 const f=await canvasFixture(page,{readonly:true,focusGraph:true,curves:true});await page.setViewportSize({width,height:1000});await page.goto('/?view=settings');
 const board=page.getByRole('region',{name:'主体与关联关系',exact:true}),viewport=board.locator('.free-canvas-viewport'),filters=page.getByRole('navigation',{name:'实体分类',exact:true});
 const label=category==='ALL'?'全部':f.configuration.entityTypes.find(t=>t.id===category)!.label;
 await filters.getByRole('button',{name:label,exact:true}).click();
 const shown=f.graph.entities.filter(e=>e.type!=='LOCATION'&&(category==='ALL'||e.type===category)),ids=shown.map(e=>e.id),idSet=new Set(ids);
 const edges=f.graph.relations.filter(e=>e.from.kind==='ENTITY'&&e.to.kind==='ENTITY'&&!e.historicalOnly&&idSet.has(e.from.id)&&idSet.has(e.to.id));
 await expect(board.locator('[data-canvas-node-id]')).toHaveCount(ids.length);await expect(board.locator('path[data-canvas-edge-path]')).toHaveCount(edges.length);
 await board.getByRole('button',{name:'适配全图',exact:true}).click();await viewport.scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 const original=await graphGeometry(board);
 expect(original.nodes.map(n=>n.id).sort()).toEqual([...ids].sort());expect(original.edges.map(e=>e.id).sort()).toEqual(edges.map(e=>e.id).sort());expect(original.labels.map(e=>e.id).sort()).toEqual(edges.map(e=>e.id).sort());
 // Neither a historical ENTITY edge nor a same-ID REPRESENTATION endpoint may
 // create a neighbor. Category-filtered LOCATION/PROP nodes stay excluded.
 expect(original.edges.map(e=>e.id)).not.toContain('historical');expect(original.edges.map(e=>e.id)).not.toContain('wrong-kind');expect(original.edges.map(e=>e.id)).not.toContain('visits');
 for(const edge of original.edges)expect(edge.d).toContain(' C ');
 await assertEmphasis(board,null,edges,ids);await expect(board.getByRole('button',{name:'取消高亮',exact:true})).toBeDisabled();
 for(const selected of ['a',category==='ALL'?'prop':'b','alone']){
  const node=board.locator('[data-canvas-node-id="'+selected+'"]');await node.click();await expect(node).toHaveAttribute('aria-pressed','true');
  await expectGraphUnchanged(board,original);
  const proof=await assertEmphasis(board,selected,edges,ids);
  if(selected==='a')expect(proof.highlighted).toEqual(category==='ALL'?['a','b','prop']:['a','b']);
  if(selected==='prop')expect(proof.incident).toEqual(['owns','reads']);
  if(selected==='alone'){expect(proof.highlighted).toEqual(['alone']);expect(proof.incident).toEqual([]);}
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(board.locator('.board-readable-list')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('settingsEntity')).toBe(false);expect(new URL(page.url()).searchParams.has('settingsRelation')).toBe(false);
  // Cancel button is always mounted; its activation must not change header or
  // canvas height. Clicking the selected node again also cancels below.
  await board.getByRole('button',{name:'取消高亮',exact:true}).click();await expectGraphUnchanged(board,original);await assertEmphasis(board,null,edges,ids);
 }
 const selected=board.locator('[data-canvas-node-id="a"]');await selected.click();await selected.click();await assertEmphasis(board,null,edges,ids);await expectGraphUnchanged(board,original);
 await selected.click();await selected.focus();await selected.press('Alt+ArrowRight');expect(new URL(page.url()).searchParams.get('view')).toBe('settings');await expectGraphUnchanged(board,original);
 await viewport.scrollIntoViewIfNeeded();
 const hit=await selected.evaluate(element=>{const b=element.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return {x,y,exact:document.elementFromPoint(x,y)?.closest('[data-canvas-node-id]')===element};});expect(hit.exact).toBe(true);
 await page.mouse.move(hit.x,hit.y);await page.mouse.down();await page.mouse.move(hit.x+40,hit.y+30,{steps:6});await page.mouse.up();await expectGraphUnchanged(board,original);await assertEmphasis(board,'a',edges,ids);
 // Every curve, not just its caption, remains the identical path through all
 // selections. Parallel/reciprocal curves and directed marker colors stay exact.
 const siblings=await board.locator('path[data-canvas-edge-path^="knows"]').evaluateAll(nodes=>nodes.map(n=>{const p=n as SVGPathElement,m=p.getPointAtLength(p.getTotalLength()/2);return {id:p.dataset.canvasEdgePath,x:m.x,y:m.y,d:p.getAttribute('d')};}));
 expect(siblings).toHaveLength(3);expect(new Set(siblings.map(p=>p.d)).size).toBe(3);for(let i=0;i<siblings.length;i++)for(let j=i+1;j<siblings.length;j++)expect(Math.hypot(siblings[i].x-siblings[j].x,siblings[i].y-siblings[j].y)).toBeGreaterThan(12);
 for(const id of ['knows-proposed','knows-reverse']){const p=board.locator('path[data-canvas-edge-path="'+id+'"]'),marker=await p.getAttribute('marker-end');expect(marker).toMatch(/-related\)$/);expect(await board.locator('marker[id="'+marker!.slice(5,-1)+'"] path').evaluate(n=>getComputedStyle(n).fill)).toBe(await p.evaluate(n=>getComputedStyle(n).stroke));}
 expect(await board.locator('path[data-canvas-edge-path="knows-proposed"]').evaluate(n=>getComputedStyle(n).strokeDasharray)).not.toBe('none');
 const geometry=await graphGeometry(board);await info.attach('retained-fullgraph-geometry',{body:JSON.stringify({category,width,original,selected:geometry},null,2),contentType:'application/json'});
 for(const a of geometry.labels)for(const b of geometry.nodes)expect(a.x+a.width<=b.x||a.x>=b.x+b.width||a.y+a.height<=b.y||a.y>=b.y+b.height,'关系标签 '+a.id+' 不能覆盖实体 '+b.id).toBe(true);
 await page.screenshot({path:info.outputPath('subject-retained-fullgraph-'+width+'-'+category+'.png'),fullPage:false});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 await filters.getByRole('button',{name:label,exact:true}).focus();await expect(filters.getByRole('button',{name:label,exact:true})).toHaveAttribute('aria-pressed','true');
 await board.getByRole('button',{name:'取消高亮',exact:true}).click();
 await page.getByRole('tab',{name:'空间设定',exact:true}).click();const space=page.getByRole('region',{name:'全局空间与地点',exact:true});await expect(space).toHaveAttribute('data-edge-routing','orthogonal');await expect(space).not.toHaveClass(/is-preserved-emphasis/);
 await space.locator('[data-canvas-node-id="west"]').click();const detail=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(detail).toContainText('西侧为已登记位置');await expect(detail.getByRole('button',{name:'编辑此项',exact:true})).toHaveCount(0);
 expect(f.mutations).toEqual([]);expect(f.unexpected).toEqual([]);expect(f.errors).toEqual([]);
});

test('空间底图不推断缺失、非数值或不完整坐标，也不画空基线',()=>{
 expect(spatialMapBackground(null)).toBeUndefined();expect(spatialMapBackground({locations:[]})).toBeUndefined();
 expect(spatialMapBackground({locations:[{id:'missing',name:'缺失'},{id:'short',name:'短',pos:[1]},{id:'nan',name:'非数',pos:[NaN,0]},{id:'infinite',name:'无穷',pos:[0,Infinity]}]})).toBeUndefined();
 const finite=spatialMapBackground({locations:[{id:'negative',name:'负坐标已登记',pos:[-2,3]}]})!;expect(finite).toMatchObject({x:-232,y:-162,width:400,height:380});
});
for(const width of [1440,390])test(width+'px空间底图严格绑定14坐标及SHA，与地点锚点同画布平移缩放',async({page},testInfo)=>{
 const fixture=await canvasFixture(page,{readonly:true,spatialBackground:true});await page.setViewportSize({width,height:1000});await page.goto('/?view=settings&settingsSection=space');
 const board=page.getByRole('region',{name:'全局空间与地点',exact:true}),canvas=board.getByRole('group',{name:'全局空间与地点画板',exact:true}),map=board.locator('svg.spatial-map-backdrop');await expect(map).toHaveAttribute('data-spatial-source-sha',fixture.spatial.sourceSha256);await expect(map).toHaveAttribute('data-spatial-version',fixture.spatial.version);
 await expect(map).toHaveAccessibleName('依据已发布坐标生成的空间底图');await expect(map.locator('desc')).toContainText('不表示真实边界、道路、建筑尺寸或人物行进路线');await expect(board.locator('.board-readable-list')).toHaveCount(0);
 const expected=fixture.spatial.locations.filter(row=>row.pos.length===2&&row.pos.every(Number.isFinite)).map(row=>({id:row.id,x:row.pos[0]*16,y:row.pos[1]*16}));expect(expected).toHaveLength(14);
 const world=()=>board.evaluate(root=>({locations:[...root.querySelectorAll<SVGGElement>('[data-map-location]')].map(n=>({id:n.dataset.mapLocation,x:Number(n.dataset.mapX),y:Number(n.dataset.mapY)})),anchors:[...root.querySelectorAll<SVGCircleElement>('.free-canvas-anchor circle')].map(n=>({x:Number(n.getAttribute('cx')),y:Number(n.getAttribute('cy'))})),nodes:[...root.querySelectorAll<HTMLElement>('[data-canvas-node-id]')].map(n=>({id:n.dataset.canvasNodeId,x:n.dataset.canvasNodeX,y:n.dataset.canvasNodeY})),background:(root.querySelector('[data-canvas-background]') as HTMLElement).getAttribute('style')}));
 const before=await world();expect(before.locations).toEqual(expected);expect(before.anchors).toEqual(expected.map(({x,y})=>({x,y})));await expect(board.locator('[data-map-location="unknown"],[data-canvas-node-id="unknown"]')).toHaveCount(0);await expect(page.getByRole('region',{name:'位置待核地点'})).toContainText('未知地点');
 const assertAligned=async()=>{const values=await board.evaluate(root=>{const world=root.querySelector('.free-canvas-world')!;return[...root.querySelectorAll<SVGGElement>('[data-map-location]')].map(point=>{const x=point.dataset.mapX,y=point.dataset.mapY,anchor=root.querySelector<SVGCircleElement>('.free-canvas-anchor circle[cx="'+x+'"][cy="'+y+'"]')!,a=point.querySelector('circle')!.getBoundingClientRect(),b=anchor.getBoundingClientRect();return{dx:(a.left+a.right-b.left-b.right)/2,dy:(a.top+a.bottom-b.top-b.bottom)/2,sameWorld:point.closest('.free-canvas-world')===world&&anchor.closest('.free-canvas-world')===world};});});for(const value of values){expect(value.sameWorld).toBe(true);expect(Math.abs(value.dx)).toBeLessThanOrEqual(.01);expect(Math.abs(value.dy)).toBeLessThanOrEqual(.01);}};
 await board.getByRole('button',{name:'适配全图',exact:true}).click();await canvas.scrollIntoViewIfNeeded();await assertAligned();const fitted=await canvas.getAttribute('data-canvas-scale');await page.screenshot({path:testInfo.outputPath('spatial-map-'+width+'.png')});
 await canvas.focus();const x=Number(await canvas.getAttribute('data-canvas-x'));await canvas.press('ArrowRight');await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-x'))).toBeCloseTo(x-40,1);await board.getByRole('button',{name:'放大画板',exact:true}).click();await expect.poll(async()=>Number(await canvas.getAttribute('data-canvas-scale'))).toBeGreaterThan(Number(fitted));expect(await world()).toEqual(before);await assertAligned();
 await testInfo.attach('spatial-geometry',{body:JSON.stringify({viewport:width,expected,before,after:await world(),sourceSha256:fixture.spatial.sourceSha256}),contentType:'application/json'});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);expect(fixture.mutations).toEqual([]);expect(fixture.unexpected).toEqual([]);expect(fixture.errors).toEqual([]);
});

test('主体双击打开详情，关系文字和连线独立强调两个端点且可再次取消',async({page})=>{
 const f=await canvasFixture(page,{readonly:true,focusGraph:true,curves:true});await page.goto('/?view=settings');
 const board=page.getByRole('region',{name:'主体与关联关系',exact:true});
 await board.getByRole('button',{name:'适配全图',exact:true}).click();
 const original=await graphGeometry(board),node=board.locator('[data-canvas-node-id="a"]');
 await node.dblclick();
 const detail=page.getByRole('dialog',{name:'对象设定详情',exact:true});await expect(detail.getByRole('heading',{name:'人物甲',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(detail).toHaveCount(0);await expect(node).toBeFocused();
 await node.press('Shift+Enter');await expect(detail).toBeVisible();await detail.getByRole('button',{name:'关闭对象详情',exact:true}).click();
 const label=board.locator('button[data-canvas-edge="knows"]');
 await label.click();await expect(label).toHaveAttribute('aria-pressed','true');
 await expect(board.locator('[data-canvas-node-id="a"]')).toHaveAttribute('data-canvas-node-related','true');
 await expect(board.locator('[data-canvas-node-id="b"]')).toHaveAttribute('data-canvas-node-related','true');
 await expect(board.locator('[data-canvas-node-id="prop"]')).toHaveAttribute('data-canvas-node-related','false');
 await expect(board.locator('path[data-canvas-edge-path="knows"]')).toHaveAttribute('data-canvas-related','true');
 await expect(board.locator('path[data-canvas-edge-path="knows-reverse"]')).toHaveAttribute('data-canvas-related','false');
 await expectGraphUnchanged(board,original);await expect(detail).toHaveCount(0);
 await label.click();await expect(label).toHaveAttribute('aria-pressed','false');
 const path=board.locator('path[data-canvas-edge-path="knows-reverse"]');
 const point=await path.evaluate(element=>{const path=element as SVGPathElement,p=path.getPointAtLength(path.getTotalLength()*.3),matrix=path.getScreenCTM()!;return {x:p.x*matrix.a+p.y*matrix.c+matrix.e,y:p.x*matrix.b+p.y*matrix.d+matrix.f};});
 await page.mouse.click(point.x,point.y);await expect(path).toHaveAttribute('aria-pressed','true');
 await path.focus();await path.press('Enter');await expect(path).toHaveAttribute('aria-pressed','false');
 const filters=page.getByRole('navigation',{name:'实体分类',exact:true}),category=filters.getByRole('button',{name:f.configuration.entityTypes.find(type=>type.id==='CHARACTER')!.label,exact:true});
 await category.click();await expect(category).toHaveAttribute('aria-pressed','true');await category.click();await expect(filters.getByRole('button',{name:'全部',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(f.mutations).toEqual([]);expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});

test('新主体保存冲突保留表单，不产生幽灵草稿也不重试',async({page})=>{
 const f=await canvasFixture(page,{conflict:true});await page.goto('/?view=settings');
 await page.getByRole('button',{name:'＋ 登记主体',exact:true}).click();const dialog=page.getByRole('dialog',{name:'登记主体',exact:true});
 await dialog.getByLabel('主体名称',{exact:true}).fill('等待核对的主体');await dialog.getByRole('button',{name:'保存草稿',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('CAS_CONFLICT');await expect(dialog.getByLabel('主体名称',{exact:true})).toHaveValue('等待核对的主体');
 expect(f.mutations).toHaveLength(1);await dialog.getByRole('button',{name:'取消',exact:true}).click();
 await expect(page.locator('.settings-draft-bar')).toHaveCount(0);expect(f.graph.entities.some(entity=>entity.name==='等待核对的主体')).toBe(false);expect(f.mutations).toHaveLength(1);
 expect(f.errors).toEqual([]);expect(f.unexpected).toEqual([]);
});
