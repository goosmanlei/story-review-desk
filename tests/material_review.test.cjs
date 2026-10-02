const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx={};vm.createContext(ctx);
for(const f of ['production.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',f),'utf8'),ctx);
const need=(id,revision=id+'-v1',media='image')=>({object_id:id,id:revision,current_revision:revision,payload:{media_type:media}});
const item=(id,refs,media='image')=>({id,record:{object_id:id,id:id+'-v1',payload:{media_type:media,candidate_requirements:refs}}});
const ref=r=>({object_id:r.object_id,revision_id:r.id});
test('cards preserve exact plan candidates and do not attach an old candidate to a new recipe',()=>{
 const a=need('a'),b=need('b'),old=need('a','a-old'),clip=item('clip',[ref(a),ref(b)]),previous=item('old',[ref(old)]);
 const cards=ctx.materialCardModels([a,b],[clip,previous]);
 assert.equal(cards.length,3);assert.equal(cards[0].candidates[0],clip);assert.equal(cards[1].candidates[0],clip);
 assert.equal(cards[2].need,null);assert.equal(cards[2].candidates[0],previous);
 assert.equal(ctx.materialCardModels([a],[previous])[0].candidates.length,0);
});
test('audio and image remain individual material cards without media-type columns',()=>{
 const cards=ctx.materialCardModels([need('voice',undefined,'audio'),need('front'),need('back')],[]);
 assert.equal(cards.length,3);assert.equal(cards[0].need.object_id,'front');assert.equal(cards[1].need.object_id,'back');assert.equal(cards[2].need.object_id,'voice');
});
test('CALL review uses server numeric spelling and omits only a duplicate prompt parameter',()=>{
 const row={payload:{format:'production-call-v1',blocks:[],model:'m',parameters:{prompt:'words',pitch:1},prompt:'words'},review_call_parameter_text:'{\n  "pitch": 1.0\n}'};
 const blocks=ctx.productionTextBlocks(row);assert.equal(blocks.find(b=>b.field==='call.parameters').text,row.review_call_parameter_text);
 assert.equal(blocks.find(b=>b.field==='call.prompt').text,'words');assert.equal(row.payload.parameters.prompt,'words');
});
