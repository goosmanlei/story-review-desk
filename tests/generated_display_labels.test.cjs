const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.style={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}
 append(...nodes){this.children.push(...nodes)}replaceChildren(...nodes){this.children=nodes}setAttribute(k,v){this.attrs[k]=v}addEventListener(){}
 all(){return [this,...this.children.flatMap(n=>n.all())]}
}
function fixture(){
 const c={URL,URLSearchParams,state:{productionRecords:[]},el:tag=>new Element(tag),ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame(){},link(){}};
 c.nodeText=(tag,_cls,text,parent)=>{const n=new Element(tag);n.textContent=text;parent.append(n);return n};
 vm.createContext(c);require('./load_review_helpers.cjs')(c);for(const name of ['production.js','material-review.js','production-breakdown.js','unified-cards.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),c,{filename:name});
 return c;
}
test('unified material ownership uses exact scene, shot and episode numbers without rewriting stored titles or body',()=>{
 const c=fixture(),root=new Element('main'),seen=[];c.materialSmallCard=()=>{};c.renderMaterialWorkspace=()=>{};c.paintProductionReview=()=>{};c.materialReferenceLink=()=>{};c.reviewTextBlocks=(_host,row)=>seen.push(row.payload.blocks[0].text);
 c.state.materialReview={record:{object_id:'asset',id:'asset-r1',kind:'ASSET',payload:{title:'素材'}}};
 for(const [kind,payload,expected] of [
  ['PREPARATION',{title:'01-01 米铺门口',source:{scene_id:'s012'}},'S012 · 米铺门口'],
  ['SHOT_DESIGN',{title:'E01-004 河街开场',number:4},'SH004 · 河街开场'],
  ['EPISODE',{title:'第2集 灯火',number:2},'E02 · 灯火']
 ]){
  const scope={kind,payload:{...payload,blocks:[{id:'same-id',text:'正文中的第1集 E01-004 原样保留'}]}},before=JSON.stringify(scope);c.state.unifiedScope=scope;c.renderUnifiedCard(root);assert.equal(root.all().find(n=>n.tag==='h2').textContent,expected);assert.equal(JSON.stringify(scope),before);
 }
 assert.deepEqual(seen,Array(3).fill('正文中的第1集 E01-004 原样保留'));
});
test('material image labels normalize generated codes while file, crop and source record remain exact',()=>{
 const c=fixture(),visuals=[],img={addEventListener(){}},stage={style:{},dataset:{},querySelector:()=>img},viewport={classList:{add(){}}};
 c.el=()=>({dataset:{},append(){},addEventListener(){},querySelector:s=>s==='.structure-visual-stage'?stage:viewport});c.renderStructureVisual=v=>{visuals.push(v);return stage};
 const component={id:'original',mime:'image/png',file:'exact.png',width:160,height:90},item={record:{id:'asset-old',payload:{title:'E2-004 河街'}},component,crop:{x:0,y:0,width:.5,height:.5}},before=JSON.stringify(item);
 c.materialMedia({append(){}},item);assert.equal(visuals[0].title,'E02 / SH004 河街');assert.equal(visuals[0].alt,'E02 / SH004 河街');assert.equal(visuals[0].file,'exact.png');assert.equal(stage.dataset.reviewCrop,JSON.stringify(item.crop));assert.equal(JSON.stringify(item),before);
});
test('reference image and its lightbox share the normalized label and exact old component',async()=>{
 const c=fixture(),dialog=new Element('dialog'),body=new Element('section'),title=new Element('h2'),lightboxes=[],requests=[];
 const record={object_id:'asset',id:'asset-old',kind:'ASSET',version:1,payload:{title:'E2-004 参考图',components:[{id:'original',role:'original',mime:'image/png',file:'old.png'}],blocks:[{id:'note',text:'原文 E2-004 第2集'}]}},before=JSON.stringify(record);
 c.openReviewDialog=()=>({dialog,body,title});c.api=async url=>{requests.push(url);return {record}};c.openStructureImage=(visual,trigger)=>lightboxes.push({visual,trigger});c.paintReviewCommentCounts=()=>{};
 await c.openMaterialReference({object_id:'asset',revision_id:'asset-old',component_id:'original'},null,false);
 const img=body.all().find(n=>n.tag==='img');assert.ok(img);assert.equal(img.alt,'E02 / SH004 参考图');assert.equal(img.attrs['aria-label'],'放大查看：E02 / SH004 参考图');img.onclick();assert.equal(lightboxes[0].visual.title,'E02 / SH004 参考图');assert.equal(lightboxes[0].visual.alt,img.alt);assert.equal(lightboxes[0].visual.file,'old.png');assert.equal(new URL(requests[0],'http://fixture').searchParams.get('revision_id'),'asset-old');assert.ok(body.all().some(n=>n.textContent==='原文 E2-004 第2集'));assert.equal(JSON.stringify(record),before);
});
test('legacy image projections and review renderer share display codes without mutating components',()=>{
 const c=fixture(),root=new Element('section'),visuals=[],component={id:'original',role:'original',mime:'image/png',file:'exact.png',width:160,height:90,bytes:4,sha256:'exact'};
 c.state.productionSelected={payload:{title:'E2-004 河街素材',components:[component]}};const before=JSON.stringify(c.state.productionSelected);c.renderStructureVisual=v=>{visuals.push(v);return new Element('figure')};
 const projected=c.productionVisuals();c.productionMedia(root,component);assert.equal(projected[0].title,'E02 / SH004 河街素材');assert.equal(projected[0].alt,projected[0].title);assert.equal(visuals[0].title,projected[0].title);assert.equal(visuals[0].file,'exact.png');assert.equal(JSON.stringify(c.state.productionSelected),before);
});
test('generated comment groups, version accessibility labels and placeholders format positions while opinions stay intact',()=>{
 const c=fixture();vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/entity-review.js'),'utf8'),c);const root=new Element('section'),row={id:'asset-v1',object_id:'asset',current_revision:'asset-v1',kind:'ASSET',version:1,payload:{title:'E2-004 河街素材',media_type:'image'}};
 c.state.entityReview={entity:{id:'entity',payload:{title:'实体'}},states:[],media:[{record:row}],versions:{asset:[row,{...row,id:'asset-v0',version:0}]}};c.materialRecordRound=()=>1;c.Option=function(text,value){const n=new Element('option');n.textContent=text;n.value=value;return n};c.productionEntityIcon=()=>new Element('svg');
 const comment={target_revision_id:'asset-v1',body:'评论 E2-004 不改动'},before=JSON.stringify({row,comment});assert.equal(c.entityReviewCommentGroup(comment),'素材 · E02 / SH004 河街素材 · 版本 1');c.entityVersionControl(root,row,()=>{});assert.equal(root.children[0].attrs['aria-label'],'E02 / SH004 河街素材的版本');c.renderMaterialPlaceholder(root,row);assert.equal(root.children[1].attrs['aria-label'],'E02 / SH004 河街素材 · 未生成');assert.equal(JSON.stringify({row,comment}),before);
});
test('scene material cards replace local heading codes only from an exact owning scene scope',()=>{
 const c=fixture(),root=new Element('section'),scope={object_id:'scene',revision_id:'scene-old'},item={object_id:'material',id:'need-old',title:'01-01 米铺门口 · 场级调度图',media_type:'image',placement:scope,placement_title:'01-01 米铺门口',locations:[{scope,kind:'PREPARATION',scene:'s012'}]};c.productionEntityIcon=()=>new Element('svg');const before=JSON.stringify(item);
 const button=c.materialSmallCard(root,item,()=>{});assert.equal(button.all().find(n=>n.tag==='strong').textContent,'S012 · 米铺门口 · 场级调度图');assert.equal(button.title,'S012 · 米铺门口 · 场级调度图 · S012 · 米铺门口');assert.equal(JSON.stringify(item),before);
 const wrong={...item,locations:[{scope:{...scope,revision_id:'scene-current'},kind:'PREPARATION',scene:'s099'}]};assert.equal(c.materialPositionText(wrong),item.title);c.state.productionRecords=[{...scope,id:'scene-current',kind:'PREPARATION',payload:{source:{scene_id:'s099'}}}];assert.equal(c.materialPositionText(wrong),item.title);
 c.state.breakdownSceneData={scene:{object_id:'scene',id:'scene-old',kind:'PREPARATION',payload:{source:{scene_id:'s012'}}}};assert.equal(c.materialPositionText({...item,locations:[]}), 'S012 · 米铺门口 · 场级调度图');
});
test('allocated object codes override local numbers while prose and excluded object titles stay literal',()=>{
 const c=fixture();c.state.businessCodes=new Map([['ep','E71'],['scene:ep:s001','S143'],['shot-a','SH222'],['shot-b','SH223']]);c.state.legacyShotCodes=new Map([['E1-7','E71 / SH222']]);
 assert.equal(c.reviewPositionLabel('episode',{object_id:'ep',payload:{number:1}}),'E71');
 assert.equal(c.reviewPositionLabel('scene','s001','ep'),'S143');
 for(const [id,expected] of [['shot-a','SH222'],['shot-b','SH223']])assert.equal(c.reviewPositionLabel('shot',{object_id:id,payload:{number:7}}),expected);
 assert.equal(c.reviewPositionText('E1-007 河街'),'E71 / SH222 河街');
 assert.equal(c.reviewPositionText('E2-007 旧镜'),'第2集第7镜 旧镜');
 assert.equal(c.reviewPositionText('第1集的第7镜'),'第1集的第7镜');
 assert.equal(c.businessTitle({object_id:'shot-a',kind:'SHOT_DESIGN',payload:{title:'E1-007 河街'}}),'SH222 · 河街');
 assert.equal(c.businessTitle({object_id:'shot-a',kind:'SHOT_DESIGN',payload:{title:'SH222 河街'}}),'SH222 · 河街');
 assert.equal(c.businessTitle({kind:'SOURCE',business_code:'D003',payload:{title:'第1集资料'}}),'第1集资料');
 assert.equal(c.businessTitle({kind:'STORY',business_code:'B003',payload:{title:'版本四'}}),'版本四');
});
