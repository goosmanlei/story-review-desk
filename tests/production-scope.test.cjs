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
test('entity navigation carries the exact scope; explicit scopes still return to their edition',()=>{
 const c=fixture('http://fixture/?workspace=materials.workspace&production_tab=materials&production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene');c.state.workspace='materials.workspace';
 vm.runInContext("workspaceSubRoutes.set('settings.workspace:entities','http://fixture/?workspace=settings.workspace&production_tab=entities&entity_search=kept&production_scope_episode=ep&production_scope_revision=new&production_scope_scene=scene')",c);
 c.selectProductionTab('entities');let p=new URL(c.location.href).searchParams;assert.equal(p.get('entity_search'),'kept');assert.equal(p.get('production_scope_revision'),'old');
 c.location.href='http://fixture/?workspace=settings.workspace&production_tab=entities&production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene';
 c.state.workspace='settings.workspace';vm.runInContext("workspaceSubRoutes.set('settings.workspace:breakdown','http://fixture/?workspace=settings.workspace&production_tab=breakdown&production_scope_episode=ep&production_scope_revision=new&production_scope_scene=scene&breakdown_episode=ep&breakdown_scene=scene&breakdown_object=new-shot&breakdown_revision=new-shot-revision')",c);
 c.selectProductionTab('breakdown');p=new URL(c.location.href).searchParams;assert.equal(p.get('breakdown_object'),'ep');assert.equal(p.get('breakdown_revision'),'old');assert.equal(p.get('breakdown_episode_revision'),'old');const target=c.breakdownEditionTarget({design:{object_id:'ep',id:p.get('breakdown_episode_revision')},scenes:[{object_id:'scene'}]},p);assert.equal(target.error,undefined);assert.equal(target.scene.object_id,'scene');
});
test('a scoped material preserves its accurate identity and opens the current plan',async()=>{
 const c=fixture('http://fixture/');let ref;c.openUnifiedMaterial=async value=>{ref=value};await c.openManagementMaterial({object_id:'material',scope_references:[{object_id:'material',revision_id:'old'}]},null);assert.equal(ref.object_id,'material');assert.equal(ref.revision_id,undefined);assert.equal(ref.defaultSelection,true);
});

test('a scene shared by two current editions uses an explicit parent choice',()=>{
 const c=fixture('http://fixture/'),filters={episode:'',scene:''},catalog={episodes:['one','two'].map(id=>({object_id:id,id:id+'-exact',kind:'AV_EPISODE',scenes:[{id:'shared',kind:'AV_SCENE',title:'共有场'}]}))};
 c.managementScopeFilters({},filters,catalog,[],()=>{});const options=c.groups[1].options;assert.notEqual(options[1][0],options[2][0]);c.groups[1].change(options[2][0]);assert.equal(filters.episode,'two');assert.equal(filters.scope_revision,'two-exact');assert.equal(filters.scene,'shared');
});

test('reopening a historical manager URL cannot return through a stale current shot',()=>{
 const c=fixture('http://fixture/?workspace=materials.workspace&production_tab=materials&production_scope_episode=ep&production_scope_revision=old&production_scope_scene=scene&breakdown_episode=ep&breakdown_episode_revision=current-edition&breakdown_scene=scene&breakdown_object=current-shot&breakdown_revision=current');c.state.workspace='materials.workspace';c.selectProductionTab('breakdown');const p=new URL(c.location.href).searchParams;assert.equal(p.get('breakdown_object'),'ep');assert.equal(p.get('breakdown_revision'),'old');assert.equal(p.get('breakdown_episode_revision'),'old');const target=c.breakdownEditionTarget({design:{object_id:'ep',id:p.get('breakdown_episode_revision')},scenes:[{object_id:'scene'}]},p);assert.equal(target.error,undefined);assert.equal(target.scene.object_id,'scene');
});

test('material range changes clear a stale entity shot without changing material filters',()=>{
 const c=fixture('http://fixture/?production_scope_episode=ep&production_scope_scene=scene&production_scope_revision=old&production_scope_shot=first&material_search=kept');
 c.managementScopeRoute({episode:'ep',scene:'scene',scope_revision:'old'});assert.equal(new URL(c.location.href).searchParams.get('production_scope_shot'),'first');
 c.managementScopeRoute({episode:'ep',scene:'other',scope_revision:'old'});const p=new URL(c.location.href).searchParams;assert.equal(p.get('production_scope_shot'),null);assert.equal(p.get('material_search'),'kept');
});


test('changing the main shot clears stale material children and reaches that shot across pages',()=>{
 const c=fixture('http://fixture/?workspace=settings.workspace&production_tab=entities&production_scope_episode=ep&production_scope_revision=exact&production_scope_scene=scene&production_scope_shot=new-shot');
 vm.runInContext("workspaceSubRoutes.set('settings.workspace:breakdown','http://fixture/?workspace=settings.workspace&production_tab=breakdown&production_scope_episode=ep&production_scope_revision=exact&production_scope_scene=scene&production_scope_shot=old-shot&breakdown_episode=ep&breakdown_episode_revision=exact&breakdown_scene=scene&breakdown_object=old-shot&breakdown_revision=old-exact&shot_material_id=old-material&shot_candidate=old-candidate&shot_component=preview')",c);
 c.selectProductionTab('breakdown');const p=new URL(c.location.href).searchParams;
 assert.equal(p.get('breakdown_object'),'new-shot');assert.equal(p.get('production_scope_shot'),'new-shot');assert.equal(p.get('breakdown_revision'),null);
 for(const key of ['shot_material_id','shot_candidate','shot_component'])assert.equal(p.has(key),false);
});
test('the same exact shot restores its own candidate and component without borrowing another shot',()=>{
 const c=fixture('http://fixture/?workspace=settings.workspace&production_tab=entities&production_scope_episode=ep&production_scope_revision=exact&production_scope_scene=scene&production_scope_shot=shot');
 vm.runInContext("workspaceSubRoutes.set('settings.workspace:breakdown','http://fixture/?workspace=settings.workspace&production_tab=breakdown&production_scope_episode=ep&production_scope_revision=exact&production_scope_scene=scene&production_scope_shot=shot&breakdown_episode=ep&breakdown_episode_revision=exact&breakdown_scene=scene&breakdown_object=shot&breakdown_revision=shot-exact&shot_material_id=material&shot_candidate=candidate&shot_component=preview')",c);
 c.selectProductionTab('breakdown');const p=new URL(c.location.href).searchParams;
 assert.equal(p.get('breakdown_revision'),'shot-exact');assert.equal(p.get('shot_material_id'),'material');assert.equal(p.get('shot_candidate'),'candidate');assert.equal(p.get('shot_component'),'preview');
});
test('ordinary scoped cards open one material even when uses point at current plan and a historical original',async()=>{
 const c=fixture('http://fixture/');let opened;c.openUnifiedMaterial=async ref=>opened=ref;
 await c.openManagementMaterial({object_id:'canonical',scope_references:[{object_id:'canonical',revision_id:'current'},{object_id:'old-original',revision_id:'historical'}]},null);
 assert.equal(opened.object_id,'canonical');assert.equal(opened.defaultSelection,true);assert.equal(opened.revision_id,undefined);
});
