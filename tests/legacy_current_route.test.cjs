const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('legacy ASSET backing plan opens its own material instead of the first state material',()=>{
 const asset={object_id:'voice',id:'voice-address',kind:'ASSET',payload:{components:[]}},plan={object_id:'working-voice',id:'working-address',kind:'REQUIREMENT',payload:{scope:{object_id:'voice',revision_id:'voice-address'},current_plan_for:{object_id:'voice',revision_id:'voice-address'}}};
 const round={number:1,current_content:true,plan,results:[asset],members:[plan,asset]},data={entity:{object_id:'girl'},states:[],material_versions:{voice:[round]},media:[{record:asset,state:null}]};
 const c={state:{},productionRef:r=>({object_id:r.object_id,revision_id:r.id}),entityReviewDetail:r=>({record:r}),focusProductionReview:()=>{},restoreProductionDraft:()=>{}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/entity-review.js','utf8'),c);
 c.restoreEntityMaterialRoute(data,{row:asset,selected:{material_id:'voice',round}});
 assert.equal(data.materialTab,'entity');assert.equal(data.selectedCandidates.voice,'voice-address');assert.equal(c.state.materialCommentCard.material_id,'voice');
});
