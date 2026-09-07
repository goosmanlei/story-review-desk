import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {readingProjection} from '../host/instance-runtime/domain-reading.mjs';
function load(file,imports={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>imports[name],URL});return module.exports;}
test('approval shortcut fills only empty criteria and preserves every existing judgment and note',()=>{
 const {fillUnansweredWithPass}=load('review-shortcuts.ts'),findings={a:{verdict:'FAIL',note:'具体问题'},b:{verdict:'',note:'原有备注'},c:{verdict:'NA',note:'不适用依据'},other:{verdict:'',note:'另一集'}},before=structuredClone(findings);
 const result=fillUnansweredWithPass(findings,['a','b','c','d']);
 assert.equal(result.a.verdict,'FAIL');assert.equal(result.c.verdict,'NA');assert.equal(result.b.verdict,'PASS');assert.equal(result.b.note,'原有备注');assert.equal(result.d.verdict,'PASS');assert.equal(result.other.verdict,'');assert.deepEqual(findings,before);
});
test('material browse restores selection and filters without reopening a drawer; every explicit deep link wins',()=>{
 const memory=new Map(),module=load('material-browse-state.ts',{'./client-storage':{instanceLocalStorage:{getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value)}}});
 module.saveMaterialBrowseLocation(new URL('http://local/?view=materials&entity=exact-person&materialEntityType=CHARACTER&materialMedia=IMAGE&materialPanel=entity&material=old'));
 const plain=new URL('http://local/?view=materials');assert.equal(module.restoreMaterialBrowseLocation(plain),true);
 assert.equal(plain.searchParams.get('entity'),'exact-person');assert.equal(plain.searchParams.get('materialEntityType'),'CHARACTER');assert.equal(plain.searchParams.get('materialPanel'),'closed');assert.equal(plain.searchParams.has('material'),false);
 for(const field of ['entity','material','family','version','materialState','materialRelation','materialTrial','materialTrialVersion','materialDefinitionId','materialDefinitionKind','materialDefinitionTab','materialRepresentation']){
  const link=new URL('http://local/?view=materials&'+field+'=explicit'),before=link.href;assert.equal(module.restoreMaterialBrowseLocation(link),false);assert.equal(link.href,before);
 }
});
function fixture(){
 const entities=[{id:'loc',type:'LOCATION',name:'门前',description:'已发布说明',aliases:[]}],graph={entities,states:[{id:'state',entityId:'loc',dimensions:{time:'夜',weather:'雨'}}],representations:[{id:'rep',entityId:'loc',stateId:'state',type:'PLACE',label:'院内夜雨',dimensions:{viewpoint:'北望'},assetFamilyIds:['family'],requirementIds:['need'],authority:'L'}],requirements:[],relations:[]};
 const version={id:'version',familyId:'family',path:'media/place.png',sha256:'a'.repeat(64),outputState:'PRESENT',lifecycleState:'RELEASED',preview:'/preview/place.webp'},family={id:'family',versionRefs:['version'],currentVersionId:'version'};
 return {graph,configuration:{representationTypes:[{id:'PLACE',mediaType:'IMAGE'}]},snapshot:{productionModel:{assetFamilies:[family],assetVersions:[version],materialRequirements:[{id:'need',entityRef:'loc',mediaType:'IMAGE',requirementClass:'REQUIRED'}]}}};
}
test('location gallery binds exact dimensions, family, version and SHA without mutating sources',()=>{
 const f=fixture(),before=structuredClone(f),p=readingProjection(f.snapshot,f.graph,f.configuration);
 assert.equal(p.locationVisuals.loc[0].version.sha256,'a'.repeat(64));assert.deepEqual(p.locationVisuals.loc[0].dimensions,{time:'夜',weather:'雨',viewpoint:'北望'});assert.equal(p.businessFacts.loc.requirementCount,1);assert.deepEqual(f,before);
});
test('missing, retired, duplicate or cross-family images become placeholders',()=>{
 for(const mutate of [
  f=>f.snapshot.productionModel.assetVersions.push({...f.snapshot.productionModel.assetVersions[0]}),
  f=>f.snapshot.productionModel.assetFamilies.push({...f.snapshot.productionModel.assetFamilies[0]}),
  f=>{f.snapshot.productionModel.assetVersions[0].familyId='other';},
  f=>{f.snapshot.productionModel.assetVersions[0].sha256='';},
  f=>{f.snapshot.productionModel.assetVersions[0].outputState='MISSING';},
  f=>{f.snapshot.productionModel.assetVersions[0].mediaRetirement={};},
 ]){const f=fixture();mutate(f);assert.equal(readingProjection(f.snapshot,f.graph,f.configuration).locationVisuals.loc[0].version,null);}
});
test('live status can update but an existing version identity cannot be silently rebound',()=>{
 for(const patch of [{familyId:'other'},{path:'other.png'},{sha256:'b'.repeat(64)}]){const f=fixture();assert.equal(readingProjection(f.snapshot,f.graph,f.configuration,{assetVersionsById:{version:patch}}).locationVisuals.loc[0].version,null);}
 const f=fixture(),p=readingProjection(f.snapshot,f.graph,f.configuration,{assetVersionsById:{version:{sha256:'A'.repeat(64),lifecycleState:'REVISION_REQUIRED'}}});assert.equal(p.locationVisuals.loc[0].version.lifecycleState,'REVISION_REQUIRED');
});
test('confirmed composite membership adds labelled images, unrelated and historical links do not',()=>{
 const f=fixture();f.graph.entities.push({id:'group',type:'GROUP',name:'双铺',description:'',aliases:[]});f.graph.representations[0].entityId='group';
 const link={id:'membership',type:'PART_OF',status:'CONFIRMED',from:{kind:'ENTITY',id:'loc'},to:{kind:'ENTITY',id:'group'},label:'属于'};
 f.graph.relations.push(link);let p=readingProjection(f.snapshot,f.graph,f.configuration);assert.equal(p.locationVisuals.loc[0].association,'COMPOSITE_MEMBER');assert.equal(p.locationVisuals.loc[0].compositeName,'双铺');
 link.historicalOnly=true;assert.equal(readingProjection(f.snapshot,f.graph,f.configuration).locationVisuals.loc.length,0);
});
