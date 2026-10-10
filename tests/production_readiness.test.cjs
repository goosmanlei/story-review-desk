const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
class Element{
  constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.isConnected=true;this.disabled=false}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setAttribute(key,value){this.attrs[key]=value}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
}
const requirement=(id,required=true)=>({object_id:id,id:id+'-revision',payload:{title:id,scope:{object_id:'scope',revision_id:'scope-revision'},slot:id,required,purpose:'Fixture input',usage:'post_audio'}});
const row=(id,required=true,issues=[],adopted=true)=>({requirement:requirement(id,required),issues,pending_changes:[],asset:adopted?{object_id:id+'-asset',id:id+'-asset-revision',payload:{title:id+' recording'}}:null,adoption:adopted?{payload:{asset:{object_id:id+'-asset',revision_id:id+'-asset-revision'},component_id:'original'}}:null});
async function render(changes={}){
  const r={object_id:'scope',id:'scope-revision',kind:'AV_SHOT'},root=new Element('main');
  const data={required_count:1,missing_count:0,inputs_ready:true,package_available:true,package_issue:null,requirements:[row('required')],...changes};
  const requests=[],messages=[];
  const context={state:{productionSelected:r,productionRecords:[]},el:(tag,cls)=>new Element(tag,cls),
    nodeText:(tag,cls,text,parent)=>{const node=new Element(tag,cls);node.textContent=text;parent.append(node);return node},
    api:async url=>{requests.push(url);return data},materialRecordRound:()=>1,toast:text=>messages.push(text)};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(source,context);
  context.productionRefLink=(parent,ref,label)=>{const node=new Element('a');node.textContent=label;node.reference=ref;parent.append(node)};
  await context.renderProductionReadiness(root,r);
  const button=root.all().find(node=>node.tag==='button'&&node.textContent==='下载逐镜输入清单');
  return {context,root,data,button,requests,messages,text:()=>root.all().map(node=>node.textContent||'').join('\n')};
}

test('missing required input keeps the original disabled button and required summary',async()=>{
  const f=await render({inputs_ready:false,package_available:false,missing_count:1,requirements:[row('required',true,['missing_adoption'],false)]});
  assert.equal(f.button.disabled,true);assert.match(f.text(),/必要输入：1 项，缺项 1 项/);assert.doesNotMatch(f.text(),/暂不能下载完整清单/);
});

test('unselected optional input and optional quality warnings stay downloadable',async()=>{
  for(const optional of [row('optional',false,['missing_adoption'],false),row('optional',false,['below_minimum_sample_rate'])]){
    const f=await render({requirements:[row('required'),optional]});
    assert.equal(f.button.disabled,false);assert.match(f.text(),/必要输入齐备/);
    assert.match(f.text(),optional.adoption?/采样率不足/:/尚未采用/);assert.doesNotMatch(f.text(),/暂不能下载完整清单/);
  }
});

test('broken optional original disables only download and gives one precise reason',async()=>{
  const reason='missing media or byte size mismatch';
  const f=await render({package_available:false,package_issue:{object_id:'optional-asset',revision_id:'optional-asset-revision',title:'可选录音',component_id:'original',file:'exact.wav',reason},requirements:[row('required'),row('optional',false,[reason])]});
  assert.equal(f.button.disabled,true);assert.match(f.text(),/必要输入：1 项，缺项 0 项/);assert.match(f.text(),/必要输入齐备/);
  assert.equal(f.root.all().filter(node=>(node.textContent||'').includes('文件缺失或大小不符')).length,1);
  assert.match(f.text(),/暂不能下载完整清单：「可选录音」的 original 组成：文件缺失或大小不符/);assert.doesNotMatch(f.text(),/missing media or byte size mismatch/);
  assert.equal(f.root.all().filter(node=>node.tag==='button'&&(node.textContent||'').startsWith('下载')).length,1);
  assert.equal(f.requests.length,1);
  assert.equal(f.root.all().filter(node=>node.textContent==='查看所引用的原件').length,0);
});

test('historical dependency failure is explained while unrelated optional warnings remain visible',async()=>{
  const f=await render({package_available:false,package_issue:{object_id:'historic-voice',revision_id:'historic-revision',title:'旧录音依据',component_id:'original',reason:'media checksum mismatch'},requirements:[row('required'),row('optional',false,['below_minimum_sample_rate'])]});
  assert.equal(f.button.disabled,true);assert.match(f.text(),/旧录音依据.*文件校验失败/);assert.match(f.text(),/采样率不足/);
  const link=f.root.all().find(node=>node.textContent==='查看所引用的原件');assert.equal(link.reference.revision_id,'historic-revision');assert.equal(link.reference.component_id,'original');
});

test('legacy API responses retain their existing required-input behavior',async()=>{
  const f=await render({package_available:undefined,package_issue:undefined});assert.equal(f.button.disabled,false);
});

test('download still calls the package endpoint and reports a later validation failure',async()=>{
  const f=await render();f.context.api=async url=>{f.requests.push(url);throw Error('原件在检查后改变')};
  await f.button.onclick();assert.equal(f.requests.at(-1),'/api/production/package?scope=scope');assert.deepEqual(f.messages,['原件在检查后改变']);
});
