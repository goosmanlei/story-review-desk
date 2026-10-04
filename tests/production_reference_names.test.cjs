const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
class Element{
  constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.dataset={};this.isConnected=true}
  append(...nodes){this.children.push(...nodes)}
  setAttribute(name,value){this.attrs[name]=value}
  all(){return [this,...this.children.flatMap(node=>node.all())]}
}
const record=(object_id,id,title,kind='ASSEMBLY',extra={})=>({object_id,id,current_revision:id,kind,version:1,payload:{title,blocks:[],...extra}});
const ref=row=>({object_id:row.object_id,revision_id:row.id});
const projected=row=>({...ref(row),title:row.payload.title});
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(records=[],screenplays=[],sources=[]){
  const calls=[],state={productionRecords:records,screenplays,sources},root=new Element('main');
  const context={state,URL,location:{href:'http://fixture/?workspace=production.workspace'},
    el:(tag,cls)=>new Element(tag,cls),Option:function(text,value){const node=new Element('option');node.textContent=text;node.value=value;return node},
    nodeText:(tag,cls,text,parent)=>{const node=new Element(tag,cls);node.textContent=text;parent.append(node);return node},
    toast:()=>{},openPanel:()=>{},link:(text,url,parent)=>{const node=new Element('a');node.textContent=text;node.href=url;parent.append(node);return node},
    reviewSurface:node=>node};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(source,context);
  context.openProductionRecord=(...args)=>calls.push({type:'record',args});
  context.materialReferenceLink=(parent,reference,label,sourceOnly)=>{const node=new Element('button');node.textContent=label;node.reference=reference;node.sourceOnly=sourceOnly;parent.append(node);calls.push({type:'reference',reference,label,sourceOnly});return node};
  context.productionFields=()=>{};context.productionList=()=>{};context.renderProductionTransitions=()=>{};
  return {context,state,root,calls,text:()=>root.all().map(node=>node.textContent||'').join('\n')};
}

test('actual detail renderer displays exact old dependency names while links retain old revisions',async()=>{
  const oldAssembly=record('assembly','assembly-v1','Red then blue'),newAssembly=record('assembly','assembly-v2','Blue then red');
  const oldVideo=record('video','video-v1','Video v1','ASSET'),newVideo=record('video','video-v2','Video v2','ASSET');
  const output=record('output','output-v1','Old output','DELIVERABLE',{assembly:ref(oldAssembly),dependencies:[ref(oldVideo)]});
  const f=fixture([newAssembly,newVideo]),detail={record:output,history:[output],uses:[],reference_titles:[projected(oldAssembly),projected(oldVideo)]};
  f.state.productionSelected=output;f.state.productionDetail=detail;
  f.context.renderProductionRecord(f.root,detail);
  assert.match(f.text(),/assembly：Red then blue/);assert.match(f.text(),/Video v1/);
  assert.doesNotMatch(f.text(),/Blue then red|Video v2/);
  const assemblyLink=f.root.all().find(node=>node.textContent==='assembly：Red then blue');await assemblyLink.onclick();
  assert.deepEqual(plain(f.calls.find(call=>call.type==='record').args),['assembly','assembly-v1',true]);
  assert.deepEqual(plain(f.calls.find(call=>call.type==='reference').reference),ref(oldVideo));
});

test('actual timeline renderer uses each exact asset and shot title from its own detail',()=>{
  const oldImage=record('image','image-v1','Original image','ASSET'),currentImage=record('image','image-v2','Renamed image','ASSET');
  const oldShot=record('shot','shot-v1','Original shot','SHOT_DESIGN'),currentShot=record('shot','shot-v2','Renamed shot','SHOT_DESIGN');
  const assembly=record('assembly','assembly-v1','Timeline','ASSEMBLY',{fps:24,duration_frames:24,items:[{track:'picture',start_frame:0,duration_frames:24,asset:ref(oldImage),shot:ref(oldShot)}]});
  const f=fixture([currentImage,currentShot]),detail={record:assembly,history:[assembly],uses:[],reference_titles:[projected(oldImage),projected(oldShot)]};
  f.state.productionSelected=assembly;f.context.renderProductionRecord(f.root,detail);
  assert.match(f.text(),/Original image/);assert.match(f.text(),/Original shot/);assert.doesNotMatch(f.text(),/Renamed image|Renamed shot/);
});

test('legacy server absence uses an exact known history row or ID, never the renamed current head',()=>{
  const old=record('object','old','Old title'),head=record('object','new','New title');
  const f=fixture([head]);
  assert.equal(f.context.productionName(ref(old)),'object');
  f.state.productionDetail={record:head,history:[head,old]};
  assert.equal(f.context.productionName(ref(old)),'Old title');
  assert.equal(f.context.productionName(ref(head)),'New title');
  assert.equal(f.context.productionName({object_id:'object'}),'New title');
});

test('same visible names do not authorize wrong object or wrong revision matches',()=>{
  const a=record('a','a-v1','Shared label'),b=record('b','b-v1','Shared label');
  const f=fixture([a,b]);
  assert.equal(f.context.productionName({object_id:'a',revision_id:'b-v1'},[projected(b)]),'a');
  assert.equal(f.context.productionName({object_id:'a',revision_id:'a-v0'},[projected(a)]),'a');
  assert.equal(f.context.productionName(ref(a),[projected(a),projected(b)]),'Shared label');
});

test('explicit placement labels and exact media component/crop/range are unchanged',()=>{
  const old=record('image','old','Old image','ASSET'),head=record('image','new','New image','ASSET');
  const f=fixture([head]),reference={...ref(old),component_id:'detail',crop:{x:.1,y:.2,width:.3,height:.4},range:{start_seconds:1,end_seconds:2}};
  f.context.productionRefLink(f.root,reference,'Explicit usage description',[projected(old)]);
  assert.equal(f.calls[0].label,'Explicit usage description');assert.deepEqual(plain(f.calls[0].reference),reference);
});

test('SOURCE scene/block references keep their existing material-reference path and exact title',()=>{
  const f=fixture([],[],[{id:'source',target_revision_id:'source-v2',title:'New source title'}]);
  const reference={object_id:'source',revision_id:'source-v1',block_ids:['block'],quote:'original quote'};
  f.context.productionRefLink(f.root,reference,undefined,[{object_id:'source',revision_id:'source-v1',title:'Old source title'}]);
  assert.equal(f.calls[0].label,'Old source title · 正文依据');assert.equal(f.calls[0].sourceOnly,true);assert.deepEqual(plain(f.calls[0].reference),reference);
  assert.equal(f.context.productionName(reference),'source');
  assert.equal(f.context.productionName({object_id:'source',revision_id:'source-v2'}),'New source title');
});

test('episode and whole screenplay references keep exact existing routes and titles',()=>{
  const oldEpisode=record('episode','episode-v1','Old episode','EPISODE',{screenplay_id:'script-v1'});
  const newEpisode=record('episode','episode-v2','New episode','EPISODE',{screenplay_id:'script-v2'});
  const oldScript={...record('script-v1','script-rev1','Old screenplay','SCREENPLAY'),episodes:[oldEpisode]};
  const newScript={...record('script-v2','script-rev2','New screenplay','SCREENPLAY'),episodes:[newEpisode]};
  const f=fixture([],[newScript,oldScript]);
  f.context.productionRefLink(f.root,ref(oldEpisode));
  const episode=f.root.children[0],url=new URL(episode.href);
  assert.equal(episode.textContent,'Old episode · 本集');assert.equal(url.searchParams.get('workspace'),'story.script');
  assert.equal(url.searchParams.get('script'),'script-v1');assert.equal(url.searchParams.get('episode'),'episode');
  f.context.productionRefLink(f.root,ref(oldScript));
  assert.equal(f.root.children[1].textContent,'Old screenplay');
  assert.equal(new URL(f.root.children[1].href).searchParams.get('script'),'script-v1');
  assert.equal(f.context.productionName(ref(oldEpisode)),'Old episode');
});

test('details with different projections do not install global name caches or issue lookup requests',()=>{
  const head=record('assembly','v3','Current third name'),f=fixture([head]);
  f.context.api=()=>{throw Error('No per-reference request expected')};
  f.context.productionRefLink(f.root,{object_id:'assembly',revision_id:'v1'},undefined,[{object_id:'assembly',revision_id:'v1',title:'First name'}]);
  f.context.productionRefLink(f.root,{object_id:'assembly',revision_id:'v2'},undefined,[{object_id:'assembly',revision_id:'v2',title:'Second name'}]);
  assert.deepEqual(f.root.children.map(node=>node.textContent),['First name','Second name']);
  assert.equal(f.context.productionName({object_id:'assembly',revision_id:'v1'}),'assembly');
  assert.equal(f.state.productionRecords[0].payload.title,'Current third name');
});
test('displayed dependency and source labels normalize location codes while exact records stay unchanged',()=>{
 const asset=record('asset','asset-v1','E2-004 河口素材','ASSET'),episode=record('ep','ep-v1','第2集 灯火','EPISODE'),f=fixture([asset],[{episodes:[episode]}]);const before=JSON.stringify([asset,episode]);
 assert.equal(f.context.productionName(ref(asset)),'E02 / SH004 河口素材');f.context.productionRefLink(f.root,ref(asset),'参考图 · E2-004 河口素材');assert.equal(f.root.children[0].textContent,'参考图 · E02 / SH004 河口素材');assert.deepEqual(f.root.children[0].reference,ref(asset));
 f.context.productionRefLink(f.root,{...ref(episode),scene_id:'s003',block_ids:['b']});assert.equal(f.root.children[1].textContent,'E02 灯火 · S003');assert.equal(JSON.stringify([asset,episode]),before);
});
