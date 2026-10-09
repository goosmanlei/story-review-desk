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
