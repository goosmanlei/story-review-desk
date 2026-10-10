const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){const c={state:{workspace:'settings.workspace',screenplays:[]},URL,URLSearchParams,location:{href:'http://fixture/'}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8'),c);return c}
test('current uses match exact work positions and source versions without expanding a sibling',()=>{
 const c=fixture(),work={positions:[{object_id:'shot',revision_id:'old-shot'}],sources:[{object_id:'episode',revision_id:'script-v4',scene_id:'scene'}]};
 assert.equal(c.reviewWorkMatches({payload:{scope:{object_id:'shot',revision_id:'old-shot'}}},work),true);
 assert.equal(c.reviewWorkMatches({payload:{scope:{object_id:'shot',revision_id:'new-shot'}}},work),false);
 assert.equal(c.reviewWorkMatches({kind:'AV_SHOT',object_id:'sibling-shot',id:'other',payload:{sources:[{object_id:'episode',revision_id:'script-v4',scene_id:'scene'}]}},work),false);
 for(const [revision,scene,expected] of [['script-v4','scene',true],['script-v3','scene',false],['script-v4','sibling',false]])assert.equal(c.reviewWorkMatches({payload:{sources:[{object_id:'episode',revision_id:revision,scene_id:scene}]}},work),expected);
});
test('a child card inherits the original work; clearing work for a whole permission never guesses from URL',()=>{
 const c=fixture(),reference={object_id:'source',revision_id:'exact',scene_id:'scene'};
 c.state.unifiedCardRoot={};c.state.reviewWork={reference};assert.equal(c.currentReviewWork(),reference);
 c.state.reviewWork=null;c.location.href='http://fixture/?production_scope_episode=old&production_scope_revision=old-revision';assert.equal(c.currentReviewWork(),null);
});

test('work comparison cannot grant a plan until the full exact plan is explicitly opened',async()=>{
 const c=fixture(),opened=[];vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);
 c.state.reviewWork={reference:{object_id:'work',revision_id:'exact'}};c.productionRef=row=>({object_id:row.object_id,revision_id:row.id});
 c.productionButton=(_host,label,click)=>({label,click});c.openUnifiedMaterial=ref=>opened.push(ref);c.api=()=>assert.fail('comparison must not request or save acceptance');
 let button;c.productionButton=(_host,label,click)=>(button={label,click});
 await c.renderProductionAcceptance({}, {kind:'REQUIREMENT',object_id:'plan',id:'old-plan'});assert.match(button.label,/生成许可/);button.click();assert.equal(opened[0].revision_id,'old-plan');assert.equal(opened[0].work,null);
});

test('common authored text is grouped without resurrecting represented raw fields',()=>{
 const c=fixture();vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/production-breakdown.js'),'utf8'),c);
 const shots=[0,1,2].map(i=>({record:{id:'shot-'+i,payload:{axis:i===2?'unique direction':'same selected direction',color:'raw colour already represented by scene',sound:[]},review_composition:{sections:[{parts:[{text:i===2?'unique direction':'same selected direction'}]}]}}}));
 const common=c.breakdownReadingConditions({scene:{id:'scene'},shots},true,'scene professional text');assert.equal(common.fields.color,undefined);assert.equal(common.shared.length,1);assert.equal(common.shared[0].value,'same selected direction');assert.equal(common.shared[0].shots.length,2);
});
