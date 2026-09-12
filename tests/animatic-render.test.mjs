import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdir} from 'node:fs/promises';
import {requiredPhase} from '../tools/process-resources.mjs';import {fileSha} from '../server/transfer.mjs';import {renderAnimatic,animaticProcess} from '../server/production/animatic-render.mjs';
test('managed deterministic animatic renders exact frames from registered SHA inputs',async()=>{
 assert.ok(await requiredPhase(process.cwd()));const dir=path.join(process.env.REVIEW_TASK_DIR,'animatic');await mkdir(dir);
 const input=path.join(dir,'source.png');await animaticProcess('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1920x1080','-frames:v','1','-threads','1','-n',input]);
 const sha=await fileSha(input),binding={versionId:'test-image',familyId:'test-family',sha256:sha};
 const timeline={schemaVersion:'1.0',sceneId:'test-scene',shotPlanRevisionId:'test-design',fps:24,width:1920,height:1080,shots:[{shotId:'test-shot',durationFrames:6,panels:[{id:'panel',media:binding,startFrame:0,endFrame:6,motion:'PUSH_IN'}],beats:[]}],audio:[],cards:[]};
 const args={object:{revision:{content:{timeline}}},inputs:[{id:binding.versionId,media:[{filename:input,sha256:sha,mime_type:'image/png',availability:'PRESENT'}]}],outputDirectory:dir};
 const result=await renderAnimatic(args);assert.equal(result.frameCount,6);assert.equal(result.observed,false);assert.equal(result.outputs.length,1);assert.equal(await fileSha(path.join(dir,result.outputs[0].file)),result.outputs[0].sha256);
 await assert.rejects(renderAnimatic({...args,inputs:[{...args.inputs[0],media:[{...args.inputs[0].media[0],sha256:'0'.repeat(64)}]}]}),/SHA/);
});
