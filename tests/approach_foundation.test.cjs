const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function context(href){
 const c={URL,location:{href,hash:new URL(href).hash},history:{state:{draft:'retain'},replaceState(s,t,u){this.state=s;c.location.href=String(u);c.location.hash=new URL(u).hash}},window:{addEventListener(){}},document:{addEventListener(){}}};
 vm.createContext(c);
 for(const file of ['navigation.js','approach.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/',file),'utf8'),c);
 return c;
}
test('legacy METHODS moves six exact identities together, retains comment hash and history state',()=>{
 const values={method_object:'method.resource.book',method_revision:'original-resource',method_file:'book/chapter.md',method_file_version:'2',method_node:'method.skill.video-plan',method_node_revision:'original-skill'};
 const c=context('http://fixture/?workspace=project.configuration&config_section=METHODS&'+new URLSearchParams(values)+'#original-comment');
 assert.equal(c.normalizeApproachWorkspace('project.configuration'),'production.approach');
 const url=new URL(c.location.href);assert.equal(url.searchParams.get('tab'),'foundation');assert.equal(url.hash,'#original-comment');assert.equal(c.history.state.draft,'retain');
 for(const [key,value]of Object.entries(values))assert.equal(url.searchParams.get(key),value);
});
test('legacy CODES redirects only its navigation, while ordinary configuration stays put',()=>{
 const c=context('http://fixture/?workspace=project.configuration&config_section=CODES&production_object=exact');
 assert.equal(c.normalizeApproachWorkspace('project.configuration'),'production.approach');assert.equal(new URL(c.location.href).searchParams.get('tab'),'model');assert.equal(new URL(c.location.href).searchParams.get('production_object'),'exact');
 const d=context('http://fixture/?workspace=project.configuration&config_section=SYSTEM');assert.equal(d.normalizeApproachWorkspace('project.configuration'),'project.configuration');
});
test('old standalone pages and chapter-only links resolve the exact resource section',()=>{
 const ref={category:'resource',object:'method.resource.filmcraft-execution',node:'method.skill.story-structure',file:'production/filmcraft/applications.md',section:'六类应用'};
 const guide={reading_routes:{filmcraft:{default:{...ref,section:''},anchors:{'approach-filmcraft-applications-case':ref}}}};
 for(const query of ['?workspace=production.approach&tab=filmcraft','?workspace=production.approach']){
  const c=context('http://fixture/'+query+'#approach-filmcraft-applications-case');assert.equal(c.migrateApproachReadingRoute(guide),true);
  const u=new URL(c.location.href);assert.equal(u.searchParams.get('tab'),'foundation');assert.equal(u.searchParams.get('method_file'),ref.file);assert.equal(decodeURIComponent(u.hash),'#method-section-六类应用');
 }
});
test('explicit historical file identity is never replaced by a current professional default',()=>{
 const c=context('http://fixture/?workspace=production.approach&tab=filmcraft&method_object=method.resource.old&method_revision=old&method_file=original.md&method_file_version=1&method_node=method.skill.original&method_node_revision=old-node');
 const ref={category:'resource',object:'method.resource.current',node:'method.skill.current',file:'current.md',section:''};
 assert.equal(c.migrateApproachReadingRoute({reading_routes:{filmcraft:{default:ref,anchors:{}}}}),true);
 const p=new URL(c.location.href).searchParams;assert.equal(p.get('method_object'),'method.resource.old');assert.equal(p.get('method_revision'),'old');assert.equal(p.get('method_node_revision'),'old-node');
});
