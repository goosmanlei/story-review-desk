/** Run from project root. Pure in-memory repository; no DB, service or media I/O. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {saveProductionPreparation,readProductionPreparation} from '../host/instance-runtime/production-preparation.mjs';
const clone=value=>structuredClone(value), hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const episodes=[{episodeUid:'EP-1',displayId:'E01',title:'第一集',sceneIds:['SCENE-1']}];
 const scenes=[{id:'SCENE-1',displayId:'S01',title:'第一场',episodeUid:'EP-1',contentHash:hash('scene')}];
 const candidate={subjectKind:'EPISODE_PLAN',subjectId:'PLAN',creativeRevisionId:'CANDIDATE-1',contentHash:hash('candidate'),eventSequence:1,content:{episodes,narrativeRevision:{scenes}}};
 const view={releaseId:'RELEASE-1',profile:{episodePlanId:'PLAN'},snapshot:{instance:{episodePlanId:'PLAN'},productionModel:{}},eventsByKind:{'creative-revision':[candidate]}};
 const aux=new Map();let sequence=0;
 const tx={readView:async()=>clone(view),getAux:async(ns,key)=>aux.get(ns+'/'+key)||null,listAux:async(ns)=>[...aux.values()].filter(r=>r.namespace===ns),putAux:async({namespace,key,bytes,expectedRevisionId})=>{assert.equal(aux.get(namespace+'/'+key)?.revisionId||null,expectedRevisionId);const r={namespace,key,revisionId:'AUX-'+(++sequence),bytes:Buffer.from(bytes),sha256:hash(bytes)};aux.set(namespace+'/'+key,r);return r;}};
 const content={title:'准备稿',basis:{candidateRevisionId:candidate.creativeRevisionId,candidateContentHash:candidate.contentHash,sourceRole:'CANDIDATE'},episodes:clone(episodes),scenes:[{sceneId:'SCENE-1',displayId:'S01',episodeUid:'EP-1',sceneContentHash:scenes[0].contentHash,sourceSummary:{title:'第一场',purpose:'精确来源'},sourceEvidence:{scriptBlockIds:['BLOCK-1']},preparation:{classification:'A',sceneRole:'本场作用',visualIntent:'原意图',beats:[{order:1,actionIntent:'动作'}],sourceDialogue:[{scriptBlockId:'BLOCK-1',speaker:'人物甲',text:'原台词'}],entityStateRequirements:[{description:'人物甲的夜态',canonicalEntityId:null,stateId:null,bindingStatus:'UNBOUND_PROPOSAL'}],timeAndSpace:{storyTime:'夜',locationBinding:'UNKNOWN',stateBinding:'UNKNOWN',zoneBinding:'UNKNOWN',cameraBinding:'UNKNOWN',freezeBinding:'UNKNOWN'},materialGaps:{description:'未绑精确输入',adoptedAssetBindings:[],mediaObserved:false},formalShotIds:[],generationAuthorized:false,formalReviewCreated:false,adoptionCreated:false}}]};
 return {tx,view,aux,candidate,input:{requestId:'seed',expectedReleaseId:'RELEASE-1',expectedRevisionId:null,content}};
}
async function seeded(){const f=fixture();await saveProductionPreparation(f.tx,f.input);const state=await readProductionPreparation(f.tx);return {...f,state,edit:{requestId:'edit',expectedReleaseId:state.releaseId,expectedRevisionId:state.revisionId,content:clone(state.content)}};}
const invalidEdits={
 'top title':c=>{c.title='伪装新稿';},
 'top basis role':c=>{c.basis.sourceRole='CURRENT';},
 'top episode title':c=>{c.episodes[0].title='伪装候选标题';},
 'top episode membership':c=>{c.episodes[0].sceneIds=[];},
 'scene summary':c=>{c.scenes[0].sourceSummary.purpose='改写来源';},
 'scene evidence':c=>{c.scenes[0].sourceEvidence.scriptBlockIds=['OTHER'];},
 'scene display alias':c=>{c.scenes[0].displayId='S47';},
 'source dialogue':c=>{c.scenes[0].preparation.sourceDialogue[0].text='伪造原台词';},
 'generation flag':c=>{c.scenes[0].preparation.generationAuthorized=true;},
 'formal shot IDs':c=>{c.scenes[0].preparation.formalShotIds=['SHOT-1'];},
 'formal review fact':c=>{c.scenes[0].preparation.formalReviewCreated=true;},
 'adoption fact':c=>{c.scenes[0].preparation.adoptionCreated=true;},
 'canonical entity ID':c=>{c.scenes[0].preparation.entityStateRequirements[0].canonicalEntityId='ENTITY-OTHER';},
 'state ID':c=>{c.scenes[0].preparation.entityStateRequirements[0].stateId='STATE-OTHER';},
 'binding status':c=>{c.scenes[0].preparation.entityStateRequirements[0].bindingStatus='CONFIRMED';},
 'remove protected field':c=>{delete c.scenes[0].preparation.entityStateRequirements[0].canonicalEntityId;},
 'remove protected row':c=>{c.scenes[0].preparation.entityStateRequirements=[];},
 'replace protected subtree':c=>{c.scenes[0].preparation.materialGaps='改为纯文本绕过';},
 'adopted versions':c=>{c.scenes[0].preparation.materialGaps.adoptedAssetBindings=[{versionId:'V',sha256:hash('media')}];},
 'observed media':c=>{c.scenes[0].preparation.materialGaps.mediaObserved=true;},
 'new nested reserved fact':c=>{c.scenes[0].preparation.beats[0].facts={mediaObserved:true};},
 'spatial binding':c=>{c.scenes[0].preparation.timeAndSpace.cameraBinding='CAM-1';},
};
for(const [name,mutate] of Object.entries(invalidEdits))test('immutable envelope rejects '+name,async()=>{const f=await seeded();mutate(f.edit.content);const before=[...f.aux.keys()];await assert.rejects(saveProductionPreparation(f.tx,f.edit),{code:'DOMAIN_INVALID'});assert.deepEqual([...f.aux.keys()],before);assert.deepEqual((await readProductionPreparation(f.tx)).content,f.state.content);});
test('author text, ordinary arrays and requirement description remain editable',async()=>{const f=await seeded();const p=f.edit.content.scenes[0].preparation;p.sceneRole='新版作用';p.visualIntent='新版画面';p.beats.push({order:2,actionIntent:'第二个动作'});p.entityStateRequirements[0].description='明确夜态动作';p.timeAndSpace.storyTime='入夜';p.materialGaps.description='仍需核对';await saveProductionPreparation(f.tx,f.edit);assert.deepEqual((await readProductionPreparation(f.tx)).content.scenes[0].preparation,p);});
test('stale preparation cannot silently rebase through a valid current CAS',async()=>{const f=await seeded();const c=clone(f.candidate);c.creativeRevisionId='CANDIDATE-2';c.contentHash=hash('candidate-2');c.eventSequence=2;f.view.eventsByKind['creative-revision'].push(c);f.edit.content.basis.candidateRevisionId=c.creativeRevisionId;f.edit.content.basis.candidateContentHash=c.contentHash;await assert.rejects(saveProductionPreparation(f.tx,f.edit),{code:'DOMAIN_CONFLICT'});assert.deepEqual((await readProductionPreparation(f.tx)).content,f.state.content);});
test('successful author update remains idempotent while old CAS cannot issue a new edit',async()=>{const f=await seeded();f.edit.content.scenes[0].preparation.visualIntent='调整';const result=await saveProductionPreparation(f.tx,f.edit);assert.deepEqual(await saveProductionPreparation(f.tx,f.edit),result);await assert.rejects(saveProductionPreparation(f.tx,{...f.edit,requestId:'another'}),{code:'DOMAIN_CONFLICT'});});
test('initial draft cannot predeclare generated, observed or adopted facts',async()=>{for(const mutate of [c=>{c.scenes[0].preparation.generationAuthorized=true;},c=>{c.scenes[0].preparation.materialGaps.mediaObserved=true;},c=>{c.scenes[0].preparation.entityStateRequirements[0].canonicalEntityId='ENTITY-1';}]){const f=fixture();mutate(f.input.content);await assert.rejects(saveProductionPreparation(f.tx,f.input),{code:'DOMAIN_INVALID'});assert.equal(f.aux.size,0);}});
