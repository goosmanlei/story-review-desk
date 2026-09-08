import test from 'node:test';
import assert from 'node:assert/strict';
import {providerKeyEnvironment} from '../host/instance-runtime/provider-environment.mjs';
import {defaultConfiguration,validateConfiguration,projectConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
test('provider key configuration names a variable, never changes Codex auth or stores its value',()=>{
 assert.equal(providerKeyEnvironment({}),'OPENAI_API_KEY');
 assert.equal(providerKeyEnvironment({capabilities:{apiKeyEnvName:'STORY_OPENAI_API_KEY'}}),'STORY_OPENAI_API_KEY');
 for(const name of ['HOME','PATH','NODE_OPTIONS','sk-secret-value','API_KEY=x','ABC API_KEY'])assert.throws(()=>providerKeyEnvironment({capabilities:{apiKeyEnvName:name}}));
 const config=defaultConfiguration();config.collaboration.apiKeyEnvName='STORY_OPENAI_API_KEY';assert.equal(validateConfiguration(config).collaboration.apiKeyEnvName,'STORY_OPENAI_API_KEY');
 const projected=projectConfiguration(blankSnapshot(blankProfile()).snapshot,config,{},{});assert.equal(projected.instance.capabilities.apiKeyEnvName,'STORY_OPENAI_API_KEY');
 const legacy=defaultConfiguration();delete legacy.collaboration.apiKeyEnvName;assert.doesNotThrow(()=>validateConfiguration(legacy));
 const legacyBridge=defaultConfiguration();delete legacyBridge.collaboration.codexBridge;assert.deepEqual(validateConfiguration(legacyBridge).collaboration.codexBridge,{autoStart:false,model:'gpt-5.6-sol',maxConcurrent:5,idleTtlSeconds:600});
 config.collaboration.apiKeyEnvName='sk-not-a-config-value';assert.throws(()=>validateConfiguration(config));
});
