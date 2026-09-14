import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from '../server/settings/service.mjs';
import {validate as validateMaterial} from '../server/materials/service.mjs';
import {present} from '../server/presentation/read-unit.mjs';
import {materialSubjectBindings} from '../server/presentation/materials.mjs';

test('CHARACTER has explicit tri-state isExtra without changing permanent identity or GROUP history', () => {
  for (const isExtra of [true,false,null,undefined]) {
    const content = {type:'CHARACTER',name:'人物',description:'独立人物档案',...(isExtra === undefined ? {} : {isExtra})};
    assert.doesNotThrow(() => validate('ENTITY',content));
    const row = present({id:'person-permanent',kind:'ENTITY',revisionId:'r1',version:1,content});
    assert.equal(row.id,'person-permanent'); assert.equal(row.type,'CHARACTER'); assert.equal(row.isExtra,isExtra ?? null);
  }
  for (const isExtra of ['true',0,1,[],{}]) assert.throws(() => validate('ENTITY',{type:'CHARACTER',description:'x',isExtra}),{code:'ENTITY_IS_EXTRA'});
  assert.throws(() => validate('ENTITY',{type:'GROUP',description:'历史群体',isExtra:true}),{code:'ENTITY_ATTRIBUTE_TYPE'});
  assert.doesNotThrow(() => validate('ENTITY',{type:'GROUP',description:'历史群体'}));
  for (const category of ['EXTRAS','CROWD','CHARACTER_GROUP']) assert.equal(present({kind:'ENTITY',content:{type:'CHARACTER',category}}).isExtra,null);
});

test('unbound and composition material requirements register without any invented entity', () => {
  for (const content of [{description:'环境用途'}, {acceptanceCriteria:['组合构图'],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'part',requirementId:'requirement-a'}]}}]) {
    const before = structuredClone(content); assert.doesNotThrow(() => validateMaterial('REQUIREMENT',content)); assert.deepEqual(content,before);
  }
  assert.doesNotThrow(() => validateMaterial('MATERIAL',{label:'双人画面',kind:'IMAGE'}));
});

test('material and subject APIs use the exact same CHARACTER attribute, with unknown and multiple bindings preserved', async () => {
  const entity = (id,type,isExtra) => ({id,kind:'ENTITY',revisionId:'r-'+id,version:1,content:{type,...(isExtra===undefined?{}:{isExtra})}});
  const all = [entity('a','CHARACTER',true),entity('b','CHARACTER',false),entity('c','CHARACTER'),entity('legacy','GROUP')];
  const row = (id,ids) => ({id,links:ids.map(id => ({id,role:'ENTITY'}))});
  const rows = [row('one',['a']),row('two',['a','b']),row('unknown',['c']),row('group',['legacy']),row('pure',[])];
  const unit = {rows:async (kinds,options) => kinds[0]==='ENTITY' ? all.filter(r=>options.ids.includes(r.id)) : []};
  const actual = await materialSubjectBindings(unit,rows);
  assert.deepEqual(actual.get('pure'),[]); assert.equal(actual.get('two').length,2);
  for (const [id,subject] of [['one','a'],['unknown','c'],['group','legacy']]) {
    const binding = actual.get(id)[0], projected = present(all.find(r=>r.id===subject));
    assert.equal(binding.entityType,projected.type); assert.equal(binding.isExtra,projected.isExtra);
  }
});
