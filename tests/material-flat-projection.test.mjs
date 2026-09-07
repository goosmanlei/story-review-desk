import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const here=path.dirname(fileURLToPath(import.meta.url));
const site=path.resolve(here,'..');
const require=createRequire(path.join(site,'package.json'));
const {buildSync,build}=require('esbuild');
const source=path.join(site,'app/material-canvas-projection.ts');
const compiled=buildSync({entryPoints:[source],bundle:true,platform:'node',format:'cjs',write:false});
const module={exports:{}};new Function('module','exports',compiled.outputFiles[0].text)(module,module.exports);
const {exactMaterialRepresentation,materialAttributes,materialReferenceEdges,materialReferenceLevels,materialRepresentativeImage}=module.exports;
const hash='a'.repeat(64);
function fixture(){const rows=['a','b','c'].map(id=>({id,entityId:'entity',stateId:'state-'+id,representationId:'rep-'+id,required:true,title:'素材 '+id}));const graph={schemaVersion:'1.0',entities:[{id:'entity'}],states:rows.map(row=>({id:row.stateId,entityId:'entity',label:'条件 '+row.id,dimensions:{viewpoint:'北'},scope:[],authority:'L',evidence:[]})),representations:rows.map(row=>({id:row.representationId,entityId:'entity',stateId:row.stateId,label:row.title,type:'IDENTITY',dimensions:{viewpoint:'东'},requirementIds:[row.id],assetFamilyIds:['family-'+row.id],authority:'L',evidence:[]})),requirements:[],relations:[{id:'ref-a-b',from:{kind:'REPRESENTATION',id:'rep-a'},to:{kind:'REPRESENTATION',id:'rep-b'},type:'VISUAL_REFERENCE',label:'画风参考',status:'CONFIRMED'},{id:'ref-b-c',from:{kind:'REPRESENTATION',id:'rep-b'},to:{kind:'REPRESENTATION',id:'rep-c'},type:'VISUAL_REFERENCE',label:'细节参考',status:'UNKNOWN'}]};return{graph,rows};}
const edgesFor=(f)=>materialReferenceEdges(f.graph,f.rows,['VISUAL_REFERENCE']);
test('精确素材链只投影已有参考定义、永久需求端点与真实方向',()=>{const f=fixture(),before=structuredClone(f),edges=edgesFor(f);assert.deepEqual(edges.map(e=>[e.id,e.from,e.to,e.mode,e.uncertain]),[['ref-a-b','material:a','material:b','REGISTERED_REFERENCE_DEFINITION',false],['ref-b-c','material:b','material:c','REGISTERED_REFERENCE_DEFINITION',true]]);assert.ok(edges.every(e=>e.label.endsWith('参考定义')));assert.deepEqual(materialReferenceLevels(f.rows,edges),{'material:a':0,'material:b':1,'material:c':2});assert.deepEqual(f,before);});
for(const [name,mutate]of [
 ['错端点 kind，字符串相同也不连线',f=>{f.graph.relations[0].from.kind='ENTITY';}],
 ['STATE 关系不扩张为素材关系',f=>{f.graph.relations[0].from={kind:'STATE',id:'state-a'};f.graph.relations[0].to={kind:'STATE',id:'state-b'};}],
 ['历史关系不作为当前参考',f=>{f.graph.relations[0].historicalOnly=true;}],
 ['非参考类别不冒充参考',f=>{f.graph.relations[0].type='STATE_TRANSITION';}],
 ['重复关系身份拒绝',f=>{f.graph.relations.push(structuredClone(f.graph.relations[0]));}],
 ['重复素材永久身份拒绝',f=>{f.rows.push(structuredClone(f.rows[0]));}],
 ['不唯一 representation 拒绝',f=>{f.graph.representations.push({...structuredClone(f.graph.representations[0]),id:'another-rep'});}],
 ['不一致显式 representation 拒绝',f=>{f.rows[0].representationId='another-rep';}],
 ['未知端点不借用同名对象',f=>{f.graph.relations[0].from.id='unknown';}],
 ['被过滤端点不补回统计或虚构节点',f=>{f.rows=f.rows.filter(row=>row.id!=='a');}],
 ['独立试制不映射正式需求',f=>{f.rows[0].required=false;}],
 ['错误实体归属不换绑',f=>{f.rows[0].entityId='other';}],
 ['共享 family 不能替代缺失 requirementID',f=>{f.graph.representations[0].requirementIds=[];}],
 ['一个表现关联多个可见需求不做笛卡尔积',f=>{f.graph.representations[0].requirementIds.push('a2');f.rows.push({...f.rows[0],id:'a2'});}],
])test(name,()=>{const f=fixture();mutate(f);assert.equal(edgesFor(f).filter(e=>e.id==='ref-a-b').length,0);});
test('条件冲突保留两份原值和精确来源，不覆盖或创建状态',()=>{const f=fixture(),before=structuredClone(f),projection=materialAttributes(f.graph,f.rows[0]);assert.deepEqual(projection.attributes.map(a=>[a.value,a.sourceKind,a.sourceId]),[['北','STATE','state-a'],['东','REPRESENTATION','rep-a']]);assert.deepEqual(projection.sourceStates,[f.graph.states[0]]);assert.deepEqual(f,before);});
test('目录条件与原业务状态同时保留来源审计',()=>{const f=fixture(),original=structuredClone(f.graph);f.graph.states.push({...structuredClone(f.graph.states[0]),id:'directory-state',directoryOnly:true,appliesTo:'DIRECTORY_METADATA_ONLY',dimensions:{viewpoint:'南'}});f.rows[0].stateId='directory-state';f.graph.representations[0].stateId='directory-state';const p=materialAttributes(f.graph,f.rows[0],original);assert.deepEqual(p.sourceStates.map(s=>s.id),['directory-state','state-a']);assert.deepEqual(p.attributes.map(a=>[a.value,a.directoryOnly]),[['南',true],['北',false],['东',false]]);});
test('未知状态保持空属性来源，不借第一项',()=>{const f=fixture();f.rows[0].stateId='unknown';f.graph.representations[0].dimensions={};assert.deepEqual(materialAttributes(f.graph,f.rows[0]).sourceStates,[]);assert.deepEqual(materialAttributes(f.graph,f.rows[0]).attributes,[]);});
test('无参考不按命名或状态生成发展层级',()=>{const f=fixture();assert.deepEqual(materialReferenceLevels(f.rows,[]),{'material:a':0,'material:b':0,'material:c':0});});
test('环不循环计算或虚构生产先后',()=>{const f=fixture(),edges=edgesFor(f);edges.push({...edges[0],from:'material:c',to:'material:a'});assert.deepEqual(materialReferenceLevels(f.rows,edges),{'material:a':0,'material:b':0,'material:c':0});});
function media(){return {assetFamilies:[{id:'family-a',currentVersionId:'a@V001',versionRefs:['a@V001','a@V002']}],assetVersions:[1,2].map(i=>({id:'a@V00'+i,familyId:'family-a',path:'image-v'+i+'.png',sha256:hash,outputState:'PRESENT',historyRole:'CURRENT',lifecycleState:'RELEASED'}))};}
test('代表图优先当前采用，不改变版本选择或业务数据',()=>{const m=media(),before=structuredClone(m);assert.equal(materialRepresentativeImage(m,['family-a']).id,'a@V001');assert.deepEqual(m,before);});
test('没有当前采用时使用同族最新有效注册图',()=>{const m=media();m.assetFamilies[0].currentVersionId=null;assert.equal(materialRepresentativeImage(m,['family-a']).id,'a@V002');});
for(const [name,mutate]of [
 ['删除',v=>{v.outputState='DELETED';}],['退役',v=>{v.mediaRetirement={state:'PURGED'};}],['历史证据',v=>{v.historyRole='EVIDENCE_ONLY';}],['禁止使用',v=>{v.lifecycleState='DO_NOT_USE';}],['非图像',v=>{v.path='voice.wav';}],['SHA缺失',v=>{v.sha256=null;}],['错family',v=>{v.familyId='other';}],
])test('不使用'+name+'文件作代表图',()=>{const m=media();for(const v of m.assetVersions)mutate(v);assert.equal(materialRepresentativeImage(m,['family-a']),undefined);});
test('重复version永久身份不读取其图像',()=>{const m=media();m.assetVersions.push(...structuredClone(m.assetVersions));assert.equal(materialRepresentativeImage(m,['family-a']),undefined);});
test('未知family不从整个模型挑首图',()=>{assert.equal(materialRepresentativeImage(media(),['unknown']),undefined);});
test('仅family重合不能解析素材身份',()=>{const f=fixture();f.graph.representations[0].requirementIds=[];assert.equal(exactMaterialRepresentation(f.graph,'a'),undefined);});

const uiCompiled=await build({stdin:{contents:"export * from './material-appearance';export {FreeCanvas} from './free-canvas';",resolveDir:path.join(site,'app'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',packages:'external',write:false,plugins:[{name:'isolated-real-source',setup(build){build.onResolve({filter:/\.css$/},args=>({path:args.path,namespace:'empty-css'}));build.onLoad({filter:/.*/,namespace:'empty-css'},()=>({contents:'',loader:'js'}));}}]});
const uiModule={exports:{}};new Function('require','module','exports',uiCompiled.outputFiles[0].text)(require,uiModule,uiModule.exports);
const {createElement}=require('react'),{renderToStaticMarkup}=require('react-dom/server');
test('四进度有四套不同颜色与SVG，详情和画布使用同一语义表',()=>{const {materialProgressAppearance,MaterialProgressBadge,FreeCanvas}=uiModule.exports;assert.equal(Object.keys(materialProgressAppearance).length,4);assert.equal(new Set(Object.values(materialProgressAppearance).map(v=>v.tone)).size,4);assert.equal(new Set(Object.values(materialProgressAppearance).map(v=>v.icon)).size,4);for(const [value,appearance]of Object.entries(materialProgressAppearance)){const detail=renderToStaticMarkup(createElement(MaterialProgressBadge,{stage:value})),canvas=renderToStaticMarkup(createElement(FreeCanvas,{nodes:[{id:'material:a',label:'素材',group:'素材',x:0,y:0,badge:{value,...appearance}}],edges:[],onSelect:()=>{}}));for(const html of [detail,canvas]){assert.ok(html.includes(appearance.tone));assert.ok(html.includes(appearance.label));assert.ok(html.includes('<svg'));}assert.ok(detail.includes('data-material-progress="'+value+'"'));assert.ok(canvas.includes('data-canvas-badge="'+value+'"'));}});
test('媒介四种图标不同，类别复用实体外观且无业务写入',()=>{const {materialMediaAppearance,MaterialAppearanceIcon}=uiModule.exports;assert.equal(new Set(['IMAGE','AUDIO','VIDEO','TEXT'].map(kind=>materialMediaAppearance[kind].icon)).size,4);for(const kind of ['IMAGE','AUDIO','VIDEO','TEXT'])assert.ok(renderToStaticMarkup(createElement(MaterialAppearanceIcon,{kind:'media',value:kind})).includes('<svg'));for(const value of ['CHARACTER','LOCATION','PROP'])assert.ok(renderToStaticMarkup(createElement(MaterialAppearanceIcon,{kind:'category',value})).includes('<svg'));});
test('共享画布可选badge不改变只读能力与旧节点默认显示',()=>{const {FreeCanvas}=uiModule.exports;const props={nodes:[{id:'entity',label:'原实体',group:'实体',x:0,y:0}],edges:[],onSelect:()=>{}};const normal=renderToStaticMarkup(createElement(FreeCanvas,props)),readonly=renderToStaticMarkup(createElement(FreeCanvas,{...props,readOnly:true,showReadableList:false}));assert.ok(!normal.includes('data-canvas-badge'));assert.ok(normal.includes('重置个人布局'));assert.ok(readonly.includes('节点位置固定'));assert.ok(!readonly.includes('重置个人布局'));assert.ok(!readonly.includes('按列表浏览全部实体与关系'));});
