const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){const c={state:{},URL,URLSearchParams};vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);return c}
const shot=(id,revision)=>({object_id:id,id:revision,kind:'AV_SHOT'});
const scene=(id,revision,shots)=>({object_id:id,id:revision,kind:'AV_SCENE',payload:{shots:shots.map(r=>({object_id:r.object_id,revision_id:r.id}))}});
const params=(id,revision,where)=>new URLSearchParams({breakdown_object:id,...(revision?{breakdown_revision:revision}:{}),...(where?{breakdown_scene:where}:{})});
test('comparison uses identity only inside selected composition, including a moved parent',()=>{
 const c=fixture(),old=shot('s','old'),target=shot('s','new'),parent=scene('moved','parent-new',[target]);
 const data={design:{object_id:'e',id:'e2'},shots:[target],scenes:[parent]};
 const result=c.breakdownEditionTarget(data,params('s',null,'original'));
 assert.equal(result.target,target);assert.equal(result.scene,parent);
 assert.ok(c.breakdownEditionTarget(data,params('s','old')).error);
 assert.ok(c.breakdownEditionTarget(data,params('missing')).error);
 assert.ok(c.breakdownEditionTarget(data,params('e','wrong')).error);
 assert.equal(c.breakdownEditionTarget(data,params('moved')).target,parent);
});
test('multi-parent reuse is ambiguous until user chooses an exact parent in navigation',()=>{
 const c=fixture(),r=shot('s','same'),a=scene('a','a2',[r]),b=scene('b','b2',[r]),data={shots:[r,r],scenes:[a,b]};
 assert.match(c.breakdownEditionTarget(data,params('s')).error,/多个/);
 const result=c.breakdownEditionTarget(data,params('s','same','b'));
 assert.equal(result.target,r);assert.equal(result.scene,b);
});
test('edition change cannot reuse a scene from another edition even when every child is identical',()=>{
 const c=fixture(),a=new URLSearchParams('breakdown_episode_revision=v1'),b=new URLSearchParams('breakdown_episode_revision=v2');
 assert.notEqual(c.breakdownSelectionKey(a),c.breakdownSelectionKey(b));
});

test('return to a mounted edition reads its composition when an intermediate directory already advanced',async()=>{
 const c=fixture();
 class Node{constructor(){this.children=[];this.dataset={}}append(...n){this.children.push(...n)}replaceChildren(...n){this.children=n}querySelector(){return null}querySelectorAll(){return []}setAttribute(){}remove(){}}
 const body=new Node(),nav=new Node(),host=new Node();body.dataset={readingKey:'old',sceneId:'parent'};
 const oldScene=scene('parent','parent-v3',[]);host.dataset={breakdownWorkspace:'settings.workspace',breakdownTab:'breakdown'};host.querySelector=()=>nav;
 c.state.workspace='settings.workspace';c.state.breakdownData={design:{id:'v2'}};c.state.breakdownSceneData={scene:oldScene,shots:[]};
 c.location={href:'http://fixture/?breakdown_episode=e&breakdown_episode_revision=v3&breakdown_object=parent'};
 c.state.breakdownRenderedSelection=c.breakdownSelectionKey(new URL(c.location.href).searchParams);
 c.window={scrollY:0};c.document={querySelector:()=>body};c.$=()=>host;c.el=()=>new Node();c.nodeText=(_t,_c,_text,parent)=>{const n=new Node();parent.append(n);return n};
 c.history={state:null,replaceState(){}};c.rememberProductionDraft=()=>{};c.productionTab=()=> 'breakdown';c.breakdownHeading=c.renderAudiovisualEdition=c.renderComments=()=>{};
 c.activateBreakdownScene=()=>assert.fail('must not reuse a mounted reader with an intermediate edition directory');
 let requests=0;c.api=async()=>{requests++;return {design:{object_id:'e',id:'v3'},episode:'e',episodes:[],scenes:[],shots:[]}};
 vm.runInContext('let productionLoadEpoch=0,productionReadEpoch=0',c);
 await c.loadProductionBreakdown();assert.equal(requests,1);assert.equal(c.state.breakdownData.design.id,'v3');
});
