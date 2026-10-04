const fs=require('node:fs'),assert=require('node:assert/strict');
const {fixture}=require('./comment-persistence-fixture.cjs');
const input=JSON.parse(fs.readFileSync(0,'utf8')),results=[];
const transport=(url,options)=>fetch(input.base_url+url,options);
const setup=(f,example,data=input.material)=>{
  f.target(example.workspace,example.object_id,example.revision);f.context.state.anchor=example.anchor;f.textarea.value=example.body;
  if(example.material){
    f.context.state.materialReview=JSON.parse(JSON.stringify(data));f.context.state.materialReview.selectedMaterialRounds={[example.object_id]:1};
    f.context.intent=f.intent;f.intent.checked=true;
  }
};
async function main(){
  for(const example of input.examples){
    const first=fixture({fetch:transport});setup(first,example);const key=first.context.key();await first.context.saveComment();
    assert.match(first.messages.at(-1),/fetch failed/);assert.equal(first.storage.get(key),example.body);
    const pending=JSON.parse(first.storage.get(key+':submission'));
    const data=example.material?await (await transport('/api/production?object_id='+example.object_id)).json():input.material;
    // New JS environment models refresh; only durable browser storage survives.
    const next=fixture({fetch:transport,storage:first.storage});setup(next,example,data);
    if(example.material){assert.equal(next.context.materialRevisionIntent(),null);assert.equal(next.context.commentRevisionIntent(),null)}
    await next.context.saveComment();assert.equal(next.messages.at(-1),'评论已保存');
    const before=JSON.parse(first.requests[0].body),after=JSON.parse(next.requests[0].body);
    assert.deepEqual(before,after);assert.equal(after.id,pending.id);assert.equal(next.storage.has(key),false);assert.equal(next.storage.has(key+':submission'),false);
    results.push({body:example.body,first:before,retry:after,material_rounds_after_first:data.material_versions?.[example.object_id]?.map(r=>r.number)});
  }
  const changed={...input.examples[0],body:'changed first'},f=fixture({fetch:transport});setup(f,changed);await f.context.saveComment();
  f.textarea.value='changed second';await f.context.saveComment();assert.equal(f.messages.at(-1),'评论已保存');
  const [first,second]=f.requests.map(r=>JSON.parse(r.body));assert.notEqual(first.id,second.id);assert.equal(second.body,'changed second');
  process.stdout.write(JSON.stringify({results,changed:{first,second}}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
