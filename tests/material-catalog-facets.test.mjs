import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(here,'../app');
const require=createRequire(path.resolve(here,'../package.json'));
const ts=require('typescript');
const helperSource=fs.readFileSync(path.join(app,'material-catalog-facets.ts'),'utf8');
const transpiled=ts.transpileModule(helperSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
assert.deepEqual(transpiled.diagnostics,[]);
const {allMaterialCatalogFilters,filterMaterialCatalogRows,countMaterialCatalogRequirements,materialCatalogFacetCounts,materialCatalogEntityGroups,materialCatalogStateGroups,materialCatalogUsage}=await import('data:text/javascript;base64,'+Buffer.from(transpiled.outputText).toString('base64'));
const base=()=>({id:'R1',required:true,mediaType:'IMAGE',entityType:'CHARACTER',entityId:'A',stateId:'A-BASE',episodeUids:['EP-ONE'],sceneIds:['SCENE-PERMANENT-ONE'],creatorStage:'INITIAL',searchText:'人物 甲 身份 第一版'});
const rows=[base(),{...base(),id:'R2',mediaType:'AUDIO',creatorStage:'APPROVED',stateId:'A-NIGHT',episodeUids:['EP-TWO'],sceneIds:['SCENE-PERMANENT-TWO'],searchText:'人物 甲 夜间 声音'},{...base(),id:'R3',entityType:'LOCATION',entityId:'B',stateId:'B-EMPTY',episodeUids:['EP-ONE','EP-TWO'],sceneIds:['SCENE-PERMANENT-ONE','SCENE-PERMANENT-TWO'],searchText:'地点 乙 空态'},{...base(),id:'R4',entityId:'C',stateId:'C-BASE',episodeUids:[],sceneIds:[],searchText:'人物 丙 未绑定'}];
const all=allMaterialCatalogFilters;
test('all seven axes produce the matching unique REQUIRED need count',()=>{
 for(const [facet,value,expected]of [['mediaType','IMAGE',3],['entityType','CHARACTER',3],['entityId','A',2],['stateId','A-NIGHT',1],['episodeUid','EP-TWO',2],['sceneId','SCENE-PERMANENT-ONE',2],['creatorStage','APPROVED',1]])assert.equal(countMaterialCatalogRequirements(rows,{...all(),[facet]:value}),expected,facet);
});
test('each chip replaces only its own axis and preserves all other filters',()=>{
 const filters={...all(),entityId:'A',mediaType:'AUDIO',creatorStage:'APPROVED'};
 const options=materialCatalogFacetCounts(rows,filters,'mediaType',[{value:'ALL',label:'全部'},{value:'IMAGE',label:'图像'},{value:'AUDIO',label:'声音'}]);
 assert.deepEqual(options.map(row=>row.count),[1,0,1]);
 assert.deepEqual(filters,{...all(),entityId:'A',mediaType:'AUDIO',creatorStage:'APPROVED'});
});
test('entity filters and progress filters update each other with the same predicate',()=>{
 const filters={...all(),creatorStage:'APPROVED'};
 const groups=materialCatalogFacetCounts(rows,filters,'entityType',[{value:'CHARACTER',label:'人物'},{value:'LOCATION',label:'地点'}]);
 assert.deepEqual(groups.map(row=>row.count),[1,0]);
 assert.equal(countMaterialCatalogRequirements(rows,{...filters,entityType:'LOCATION'}),0);
});
test('search affects every chip count, without modifying data or adopting requirements',()=>{
 const before=structuredClone(rows);
 assert.equal(countMaterialCatalogRequirements(rows,{...all(),search:'夜间'}),1);
 assert.deepEqual(materialCatalogFacetCounts(rows,{...all(),search:'夜间'},'mediaType',[{value:'IMAGE',label:'图'},{value:'AUDIO',label:'声'}]).map(row=>row.count),[0,1]);
 assert.deepEqual(rows,before);
});
test('duplicate needs and multiple episode/scene appearances do not inflate totals',()=>{
 const repeated=[...rows,rows[0],rows[2],{...rows[2],episodeUids:['EP-ONE','EP-TWO','EP-THREE']}];
 assert.equal(countMaterialCatalogRequirements(repeated,all()),4);
 assert.equal(filterMaterialCatalogRows(repeated,all()).length,4);
 assert.equal(countMaterialCatalogRequirements(repeated,{...all(),episodeUid:'EP-TWO'}),2);
 assert.equal(filterMaterialCatalogRows(repeated,{...all(),episodeUid:'EP-THREE'}).length,1);
});
test('201 REQUIRED needs stay 201 when joined to six trial themes and repeated occurrences',()=>{
 const formal=Array.from({length:201},(_,index)=>({...base(),id:'REQUIRED-'+index}));
 const trials=Array.from({length:6},(_,index)=>({...base(),id:'TRIAL-'+index,required:false}));
 const joined=[...formal,...trials,...formal.slice(0,50)];
 assert.equal(countMaterialCatalogRequirements(joined,all()),201);
 assert.equal(filterMaterialCatalogRows(joined,all()).length,207);
 const group=materialCatalogEntityGroups(joined)[0];assert.equal(group.requirementCount,201);assert.equal(group.trialCount,6);
});
test('a trial can be viewed but never contributes a formal demand count',()=>{
 const trial={...base(),id:'TRIAL',required:false,entityId:'TRIAL-ONLY'};
 assert.equal(filterMaterialCatalogRows([trial],all()).length,1);
 assert.equal(countMaterialCatalogRequirements([trial],all()),0);
 assert.equal(materialCatalogFacetCounts([trial],all(),'entityId',[{value:'TRIAL-ONLY',label:'试制'}])[0].count,0);
});
test('classification and episode views use identical deduplicated entity/state/material rows',()=>{
 const matching=filterMaterialCatalogRows([...rows,rows[2]],{...all(),episodeUid:'EP-ONE'});
 const project=()=>materialCatalogEntityGroups(matching).map(group=>({id:group.entityId,states:materialCatalogStateGroups(group.rows).map(state=>({id:state.stateId,requirements:state.rows.map(row=>row.id)}))}));
 assert.deepEqual(project('classification'),project('episodes'));
 assert.deepEqual(project().map(group=>group.id),['A','B']);
});
test('unbound current usage stays visible under all, not under an arbitrary episode',()=>{
 assert.ok(filterMaterialCatalogRows(rows,all()).some(row=>row.id==='R4'));
 assert.ok(!filterMaterialCatalogRows(rows,{...all(),episodeUid:'EP-ONE'}).some(row=>row.id==='R4'));
});
test('episode and scene filters must match one exact use, not two unrelated appearances',()=>{
 const reused={...base(),episodeUids:['EP-ONE','EP-TWO'],sceneIds:['S1','S2'],usagePairs:[{episodeUid:'EP-ONE',sceneId:'S1'},{episodeUid:'EP-TWO',sceneId:'S2'}]};
 assert.equal(countMaterialCatalogRequirements([reused],{...all(),episodeUid:'EP-TWO',sceneId:'S1'}),0);
 assert.equal(countMaterialCatalogRequirements([reused],{...all(),episodeUid:'EP-TWO',sceneId:'S2'}),1);
 assert.equal(countMaterialCatalogRequirements([{...reused,usagePairs:undefined}],{...all(),episodeUid:'EP-TWO',sceneId:'S2'}),0);
 assert.deepEqual(materialCatalogFacetCounts([reused],{...all(),episodeUid:'EP-TWO'},'sceneId',[{value:'S1',label:'一'},{value:'S2',label:'二'}]).map(row=>row.count),[0,1]);
});
const preparation=()=>({candidate:{revisionId:'CANDIDATE',contentHash:'candidate-hash',episodes:[{episodeUid:'NEW-UID',displayId:'E01',title:'当前集',sceneIds:['NEW-SCENE']}],scenes:[{id:'NEW-SCENE',displayId:'S01',title:'当前场',contentHash:'scene-hash'}]},materialLinks:{scenes:[{sceneId:'NEW-SCENE',sceneContentHash:'scene-hash',references:[{requirementId:'R1',requirementHash:'requirement-hash',reason:'exact',matchKind:'EXACT'}]}]}});
test('candidate scene and requirement hashes must both match before usage is counted',()=>{
 assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash'},preparation()),{sceneIds:['NEW-SCENE'],episodeUids:['NEW-UID']});
 for(const kind of ['scene','requirement','stale','links-stale']){const p=preparation();if(kind==='scene')p.materialLinks.scenes[0].sceneContentHash='changed';if(kind==='requirement')p.materialLinks.scenes[0].references[0].requirementHash='changed';if(kind==='stale')p.stale=true;if(kind==='links-stale')p.materialLinksStale=true;assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash'},p),{sceneIds:[],episodeUids:[]},kind);}
});
test('server per-occurrence evidence keeps valid uses despite unrelated aggregate staleness',()=>{
 const p=preparation();p.stale=true;p.materialLinksStale=true;p.materialLinks.projectionPolicy='PER_OCCURRENCE_V2';
 p.materialLinks.pending=[{sceneId:'OTHER',requirementId:'R2',reason:'REQUIREMENT_CHANGED'}];
 assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash'},p),{sceneIds:['NEW-SCENE'],episodeUids:['NEW-UID']});
 p.materialLinks.scenes[0].references=[];
 assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash'},p),{sceneIds:[],episodeUids:[]});
});
test('old displayed scene and episode IDs never become new permanent usage bindings',()=>{
 const p=preparation();p.materialLinks.scenes[0].sceneId='S01';
 assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash',sceneIds:['S01'],episodeIds:['E01']},p),{sceneIds:[],episodeUids:[]});
});
test('duplicate precise references are deduplicated before counting usage',()=>{
 const p=preparation();p.materialLinks.scenes.push(structuredClone(p.materialLinks.scenes[0]));
 assert.deepEqual(materialCatalogUsage({id:'R1',requirementHash:'requirement-hash'},p),{sceneIds:['NEW-SCENE'],episodeUids:['NEW-UID']});
});
const catalog=fs.readFileSync(path.join(app,'entity-material-catalog.tsx'),'utf8');
const center=fs.readFileSync(path.join(app,'material-production-center.tsx'),'utf8');
const catalogAst=ts.createSourceFile('catalog.tsx',catalog,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const centerAst=ts.createSourceFile('center.tsx',center,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const descendants=node=>{const result=[];function visit(child){result.push(child);ts.forEachChild(child,visit);}visit(node);return result;};
const tags=tree=>descendants(tree).filter(node=>ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node));
test('both material surfaces contain no select, including version selection',()=>{
 assert.equal(tags(catalogAst).filter(node=>node.tagName.getText(catalogAst)==='select').length,0);
 assert.equal(tags(centerAst).filter(node=>node.tagName.getText(centerAst)==='select').length,0);
});
test('the main center passes the complete REQUIRED pool to shared facets, not old prefiltered rows',()=>{
 const node=tags(centerAst).find(node=>node.tagName.getText(centerAst)==='EntityMaterialCatalog');assert.ok(node);
 const attribute=node.attributes.properties.find(row=>row.name?.getText(centerAst)==='requirements');assert.equal(attribute.initializer.expression.getText(centerAst),'requirements');
 assert.match(center,/requirement\.requirementClass === 'REQUIRED'/);
});

test('both modes render one shared canvas and one conditional unified inspector',()=>{
 assert.equal(tags(catalogAst).filter(node=>node.tagName.getText(catalogAst)==='RelationshipCanvas').length,1);
 assert.equal(tags(catalogAst).filter(node=>node.tagName.getText(catalogAst)==='MaterialReviewDrawer').length,1);
 assert.equal(tags(catalogAst).filter(node=>node.tagName.getText(catalogAst)==='CatalogMaterialCard').length,0);
 assert.match(catalog,/selectedRequirement\?\.id===panelEntry\.id\?inspector/);
 const canvas=tags(catalogAst).find(node=>node.tagName.getText(catalogAst)==='RelationshipCanvas');
 const attributes=canvas.attributes.properties.map(row=>row.name?.getText(catalogAst));
 assert.ok(attributes.includes('onSelectEdge'));
 assert.ok(attributes.includes('onOpenNode')&&attributes.includes('preserveGraphOnSelect'));
 assert.match(catalog,/onSelect=\{id=>setCanvasHighlight/);
});
test('directory contains only compact type-grouped entities; selection never opens default material or scrolls',()=>{
 const nav=descendants(catalogAst).find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(catalogAst)==='nav'&&node.openingElement.getText(catalogAst).includes('material-entity-directory'));
 assert.ok(nav);assert.ok(!tags(nav).some(node=>['CatalogMaterialCard','MaterialReviewDrawer'].includes(node.tagName.getText(catalogAst))));
 assert.match(nav.getText(catalogAst),/material-entity-type-group/);assert.match(nav.getText(catalogAst),/entityCanvasIcon\(type\)/);
 assert.ok(!/scrollIntoView|(?:window|document)\.scrollTo/.test(catalog+center));
 const chooseEntity=descendants(catalogAst).find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='chooseEntity');
 assert.ok(chooseEntity);assert.ok(!/onSelect\(|choose\(|setFilters|changeFilter/.test(chooseEntity.getText(catalogAst)));
 const choose=descendants(catalogAst).find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='choose');
 assert.ok(choose);assert.ok(!/setFilters|changeFilter/.test(choose.getText(catalogAst)));assert.match(center,/inspectorReady=\{detailReady\}/);
});
test('five visible filter axes share exact live counts; removed entity/state axes are always ALL',()=>{
 for(const axis of ['mediaType','entityType','episodeUid','sceneId','creatorStage'])assert.ok(catalog.includes("materialCatalogFacetCounts(entries,filters,'"+axis+"'"),axis);
 for(const axis of ['entityId','stateId'])assert.ok(!catalog.includes("materialCatalogFacetCounts(entries,filters,'"+axis+"'"),axis);
 assert.match(catalog,/entityId:'ALL',stateId:'ALL'/);assert.match(catalog,/数字为保留其他筛选、点选该项后可匹配的需求数/);assert.match(catalog,/option\.count/);
 assert.match(catalog,/renderFacet\('episodeUid','集',true\)/);assert.match(catalog,/renderFacet\('sceneId','场',true\)/);
});
test('right workspace is only the large relation canvas; unified detail belongs to explicit drawer',()=>{
 const right=descendants(catalogAst).find(node=>ts.isJsxElement(node)&&node.openingElement.getText(catalogAst).includes('className="material-entity-workspace"'));
 assert.ok(right);assert.equal(tags(right).filter(node=>node.tagName.getText(catalogAst)==='RelationshipCanvas').length,1);
 assert.ok(!/material-entity-materials|material-entity-selected-detail|material-info-card/.test(right.getText(catalogAst)));
 assert.match(catalog,/viewportKey=\{'material-entity:'/);assert.match(catalog,/open=\{Boolean\(panel\)\}/);assert.match(catalog,/review:material-panel-location/);
});
test('definition maintenance retains exact release/revision CAS, trials and material rights remain independent',()=>{
 assert.match(catalog,/edit&&edit\.collection!=='states'/);assert.match(catalog,/历史状态／属性来源审计/);assert.doesNotMatch(catalog,/stageState\(/);
 const definitions=fs.readFileSync(path.join(app,'story-settings-workspace.tsx'),'utf8');
 assert.match(definitions,/expectedReleaseId:local\?\.base\.releaseId,expectedDraftRevisionId:local\?\.base\.draftHeadRevisionId/);
 assert.match(definitions,/draftRevisionId:state\.draft\?\.revisionId,previewHash:preview\?\.previewHash/);
 assert.match(catalog,/version\.mediaId===asset\.mediaId&&version\.versionId===asset\.versionId&&version\.sha256===asset\.sha256/);assert.match(catalog,/etag=\{trialSnapshot!\.mutationEtag\}/);
 assert.match(center,/familySelectionMismatch/);assert.match(center,/versionSelectionMismatch/);assert.match(center,/projectRightsGate/);
});
test('fixed entity directory, chip borders and modal responsiveness have isolated styles',()=>{
 const css=fs.readFileSync(path.join(app,'material-entity-review.css'),'utf8');
 assert.match(css,/grid-template-columns:300px minmax\(0,1fr\)/);assert.match(css,/material-entity-directory-list\{[^}]*overflow:auto/);
 assert.match(css,/grid-template-columns:44px minmax\(0,1fr\)/);
 assert.match(css,/material-filter-chip\{[^}]*border:1px solid var\(--material-line\)/);
 assert.match(css,/material-review-drawer\{[^}]*width:50vw/);assert.match(css,/material-review-drawer\{width:100vw/);assert.match(css,/@media\(max-width:760px\)/);
});
