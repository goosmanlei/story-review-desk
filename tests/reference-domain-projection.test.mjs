import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {referenceProjectionSupport,invokePinnedMapProxyReuse} from '../host/instance-map-proxy-adapter.mjs';

test('reference projection restores only exact missing relationship fields',()=>{
 const result=execFileSync('python3',['-B','-c',referenceProjectionSupport+String.raw`
import copy,json
prior={'families':[{'id':'reference-a','assetRole':'PRODUCTION_REFERENCE','currentVersionId':'version-a','domainContext':{'entityId':'place-a','stateIds':['state-a']}},{'id':'reference-b','assetRole':'PRODUCTION_REFERENCE','currentVersionId':'version-b'}]}
baseline=copy.deepcopy(prior)
model={'assetFamilies':[{'id':'material','assetRole':'MATERIAL'},*copy.deepcopy(prior['families'])]}
del model['assetFamilies'][1]['domainContext']
preserve_reference_domain_context(model,prior)
assert model['assetFamilies'][1:]==prior['families'] and prior==baseline
model['assetFamilies'][1]['domainContext']['stateIds'].append('personal-test')
assert prior==baseline
checks=2
for mode in ['context-change','metadata-change','identity-missing','identity-added','duplicate','missing-context-metadata-change']:
 model={'assetFamilies':copy.deepcopy(prior['families'])}
 if mode=='context-change':model['assetFamilies'][0]['domainContext']['entityId']='different'
 elif mode=='metadata-change':model['assetFamilies'][0]['currentVersionId']='version-other'
 elif mode=='identity-missing':model['assetFamilies'].pop()
 elif mode=='identity-added':model['assetFamilies'].append({'id':'reference-extra','assetRole':'PRODUCTION_REFERENCE'})
 elif mode=='duplicate':model['assetFamilies'].append(copy.deepcopy(model['assetFamilies'][0]))
 else:
  del model['assetFamilies'][0]['domainContext']
  model['assetFamilies'][0]['currentVersionId']='version-other'
 try:preserve_reference_domain_context(model,prior)
 except ValueError:checks+=1
 else:raise AssertionError(mode)
 assert prior==baseline
model={'assetFamilies':copy.deepcopy(prior['families'])}
preserve_reference_domain_context(model,prior)
assert model['assetFamilies']==prior['families'];checks+=1
print(json.dumps({'checks':checks,'databaseWrites':0,'mediaReads':0}))
`],{encoding:'utf8',timeout:30_000});
 assert.deepEqual(JSON.parse(result),{checks:9,databaseWrites:0,mediaReads:0});
});

test('legacy adapter guards original main before applying one serialization hook',()=>{
 assert.ok(invokePinnedMapProxyReuse.indexOf('projection_guard_sha =')<invokePinnedMapProxyReuse.indexOf('tree = transform_retired_production(tree)'));
 assert.match(invokePinnedMapProxyReuse,/fc8ab082ebbcdacdbdfe29cc9b33cddec337d2909bcd8d856fba476228ade16e/);
 assert.match(invokePinnedMapProxyReuse,/__instance_preserve_reference_domain_context\(payload\["productionModel"\]\)/);
});
