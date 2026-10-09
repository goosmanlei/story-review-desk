const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(url){
 const c={state:{workspace:'settings.workspace',businessCodes:new Map([['ep','AE001'],['scene','AS001']])},URL,URLSearchParams,location:{href:url},history:{state:null},document:{querySelector:()=>null},window:{scrollX:0,scrollY:0},sessionStorage:{setItem(){}},groups:[]};
 c.history.replaceState=(_s,_t,u)=>c.location.href=String(u);c.history.pushState=c.history.replaceState;
 vm.createContext(c);for(const f of ['navigation.js','production-breakdown.js','management-cards.js'])vm.runInContext(fs.readFileSync('review_desk/static/'+f,'utf8'),c);
 c.flatFilterGroup=(_p,key,label,options,selected,_counts,change)=>c.groups.push({key,label,options,selected,change});
 c.switchWorkspace=()=>{};c.rememberWorkspacePosition=()=>{};c.rememberWorkspaceRoute=()=>{};
 return c;
}
test('both managers share exact scope and reject guessing a legacy source scene',()=>{
 const c=fixture('http://fixture/?entity_episode=story&entity_scene=s1'),memory={page:2,filters:{search:'M001'}};
 c.managementScopeMemory(memory,new URL(c.location.href).searchParams,'entity_');assert.equal(memory.legacyScope,true);assert.equal(memory.filters.episode,'');assert.equal(memory.filters.search,'M001');
 c.location.href='http://fixture/?production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene';c.managementScopeMemory(memory,new URL(c.location.href).searchParams,'material_');assert.equal(memory.filters.scope_revision,'old');assert.equal(memory.filters.scene,'scene');assert.equal(memory.page,1);
});
test('empty locations do not erase a valid selected scene or hide future directory children',()=>{
 const c=fixture('http://fixture/'),filters={episode:'ep',scene:'scene',scope_revision:'old'},catalog={episodes:[{object_id:'ep',id:'old',kind:'AV_EPISODE',scenes:[{id:'scene',title:'测试场',kind:'AV_SCENE'},{id:'future',title:'新场',kind:'AV_SCENE'}]}]};
 c.managementScopeFilters({},filters,catalog,[],()=>{});assert.equal(filters.scene,'scene');assert.deepEqual(Array.from(c.groups[1].options,x=>x[0]),['','scene','future']);
});
test('switching manager keeps filters but applies the source exact scope; returning refuses another edition',()=>{
 const c=fixture('http://fixture/?workspace=materials.workspace&production_tab=materials&production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene');c.state.workspace='materials.workspace';
 vm.runInContext("workspaceSubRoutes.set('settings.workspace:entities','http://fixture/?workspace=settings.workspace&production_tab=entities&entity_search=kept&production_scope_episode=ep&production_scope_revision=new&production_scope_scene=scene')",c);
 c.selectProductionTab('entities');let p=new URL(c.location.href).searchParams;assert.equal(p.get('entity_search'),'kept');assert.equal(p.get('production_scope_revision'),'old');
 c.state.workspace='settings.workspace';vm.runInContext("workspaceSubRoutes.set('settings.workspace:breakdown','http://fixture/?workspace=settings.workspace&production_tab=breakdown&production_scope_episode=ep&production_scope_revision=new&production_scope_scene=scene&breakdown_episode=ep&breakdown_scene=scene&breakdown_object=new-shot&breakdown_revision=new-shot-revision')",c);
 c.selectProductionTab('breakdown');p=new URL(c.location.href).searchParams;assert.equal(p.get('breakdown_object'),'ep');assert.equal(p.get('breakdown_revision'),'old');assert.equal(p.get('breakdown_episode_revision'),'old');const target=c.breakdownEditionTarget({design:{object_id:'ep',id:p.get('breakdown_episode_revision')},scenes:[{object_id:'scene'}]},p);assert.equal(target.error,undefined);assert.equal(target.scene.object_id,'scene');
});
test('a scoped material opens its unique accurate reference instead of its head',async()=>{
 const c=fixture('http://fixture/');let ref;c.openUnifiedMaterial=async value=>{ref=value};await c.openManagementMaterial({object_id:'material',scope_references:[{object_id:'material',revision_id:'old'}]},null);assert.equal(ref.revision_id,'old');assert.equal(ref.defaultSelection,undefined);
});

test('a scene shared by two current editions uses an explicit parent choice',()=>{
 const c=fixture('http://fixture/'),filters={episode:'',scene:''},catalog={episodes:['one','two'].map(id=>({object_id:id,id:id+'-exact',kind:'AV_EPISODE',scenes:[{id:'shared',kind:'AV_SCENE',title:'共有场'}]}))};
 c.managementScopeFilters({},filters,catalog,[],()=>{});const options=c.groups[1].options;assert.notEqual(options[1][0],options[2][0]);c.groups[1].change(options[2][0]);assert.equal(filters.episode,'two');assert.equal(filters.scope_revision,'two-exact');assert.equal(filters.scene,'shared');
});

test('reopening a historical manager URL cannot return through a stale current shot',()=>{
 const c=fixture('http://fixture/?workspace=materials.workspace&production_tab=materials&production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene&breakdown_episode=ep&breakdown_episode_revision=current-edition&breakdown_scene=scene&breakdown_object=current-shot&breakdown_revision=current');c.state.workspace='materials.workspace';c.selectProductionTab('breakdown');const p=new URL(c.location.href).searchParams;assert.equal(p.get('breakdown_object'),'ep');assert.equal(p.get('breakdown_revision'),'old');assert.equal(p.get('breakdown_episode_revision'),'old');const target=c.breakdownEditionTarget({design:{object_id:'ep',id:p.get('breakdown_episode_revision')},scenes:[{object_id:'scene'}]},p);assert.equal(target.error,undefined);assert.equal(target.scene.object_id,'scene');
});
