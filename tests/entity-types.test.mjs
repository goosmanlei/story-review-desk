import test from 'node:test';
import assert from 'node:assert/strict';
import {PresentationRead} from '../server/presentation/read-unit.mjs';
import {validateConfiguration} from '../server/project/service.mjs';
import {validate} from '../server/settings/service.mjs';
import {defaultDomainConfiguration} from '../web/presentation/domain-defaults.mjs';
import {configurationDefaults} from '../server/presentation/defaults.mjs';
test('retired organization type cannot return from old configuration or new saves; other types survive',async()=>{
 const saved={entityTypes:{entityTypes:[{id:'CHARACTER',label:'人物'},{id:'ORGANIZATION',label:'组织'},{id:'CUSTOM',label:'自定义'}],relationTypes:[{id:'CUSTOM_REL'}]}};
 const before=structuredClone(saved);const unit=new PresentationRead({query:async()=>({rows:[{scope:'system',version:3,content:saved}]})});
 const configuration=await unit.configuration();assert.deepEqual(configuration.domain.entityTypes.map(t=>t.id),['CHARACTER','CUSTOM']);assert.deepEqual(configuration.domain.relationTypes,saved.entityTypes.relationTypes);assert.deepEqual(saved,before);
 assert.throws(()=>validateConfiguration('system',saved),/退役/);assert.throws(()=>validate('ENTITY',{type:'ORGANIZATION',description:'legacy'}),/退役/);
 assert.doesNotThrow(()=>validate('ENTITY',{type:'CHARACTER',description:'人物'}));assert.doesNotThrow(()=>validateConfiguration('system',{entityTypes:configuration.domain}));
 assert.doesNotThrow(()=>validateConfiguration('system',saved,{historicalImport:true}));assert.deepEqual(saved,before,'Legacy snapshot bytes remain unchanged; only the current projection filters retired types');
 for(const domain of [defaultDomainConfiguration(),configurationDefaults.domain])assert.ok(!domain.entityTypes.some(t=>t.id==='ORGANIZATION'));
});
