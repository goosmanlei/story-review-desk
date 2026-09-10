import test from 'node:test';
import assert from 'node:assert/strict';
import {callOpenAICommentPolish} from '../workers/comment-polish-core.mjs';
const digest='a'.repeat(64);
const input={requestId:'fixture_provider_01',inputBindingHash:digest,snapshotId:'synthetic',sceneId:'synthetic-scene',sceneContentHash:digest,businessContextHash:digest,dossierHash:digest,transcriptSha256:digest,sceneScript:'测试场景',selectionText:'测试',commentDraft:'测试意见',directSourceSegments:[{beatId:'synthetic-beat',authority:'F',asrStatus:'VERIFIED',text:'合成测试资料',contentSha256:digest}]};
test('missing provider credential fails before any invocation',async()=>{
 let calls=0;await assert.rejects(callOpenAICommentPolish({input,apiKey:'',fetchImpl:async()=>{calls++;throw Error('must not call');}}),e=>e.code==='PROVIDER_CONFIGURATION');assert.equal(calls,0);
});
test('mock authentication failure preserves request identity and is not retried',async()=>{
 let calls=0;await assert.rejects(callOpenAICommentPolish({input,apiKey:'synthetic-not-a-key',fetchImpl:async()=>{calls++;return new Response('{}',{status:401,headers:{'x-request-id':'mock-auth-01'}});}}),e=>e.code==='PROVIDER_AUTH'&&e.resultState==='FAILED'&&e.providerRequestId==='mock-auth-01');assert.equal(calls,1);
});
test('mock output succeeds, while an ambiguous transport result is never retried',async()=>{
 const result=await callOpenAICommentPolish({input,apiKey:'synthetic-not-a-key',fetchImpl:async()=>Response.json({output_text:JSON.stringify({polishedComment:'模拟建议'})})});assert.equal(result.polishedComment,'模拟建议');
 let calls=0;await assert.rejects(callOpenAICommentPolish({input,apiKey:'synthetic-not-a-key',fetchImpl:async()=>{calls++;throw Error('injected stream loss');}}),e=>e.code==='RESULT_UNKNOWN'&&e.resultState==='UNKNOWN');assert.equal(calls,1);
});
