const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
 constructor(){this.children=[];this.isConnected=true;this.classList={add(){}};this.dataset={}}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=nodes}
 setAttribute(){} remove(){this.isConnected=false} scrollIntoView(){} querySelector(){return null}
}
function fixture(){
 const host=new Element(),drawn=[],facets={},pending=[],state={workspace:'settings.workspace'};
 const rows=Array.from({length:44},(_,i)=>({object_id:'e'+i,kind:'ENTITY',payload:{title:'entity '+i,entity_type:'character'}}));
 const result={records:rows,entity_adoption_statuses:Object.fromEntries(rows.map(r=>[r.object_id,'unaccepted'])),entity_search_fields:{},entity_locations:{},entity_state_counts:{},entity_material_counts:Object.fromEntries(rows.map(r=>[r.object_id,{}])),entity_previews:{}};
 const c=vm.createContext({document:{activeElement:null},state,URL,URLSearchParams,location:{href:'http://isolated/?entity_rows=5&entity_page=2'},el:()=>new Element(),nodeText:(_tag,_class,text,parent)=>{const n=new Element();n.textContent=text;parent.append(n);return n},$:()=>host,rememberProductionDraft(){},breakdownHeading(){},productionWorkspaceRows:rs=>rs,businessCode:r=>r.object_id,productionLabels:{character:'角色'},productionButton:(host,text,onclick)=>{const n=new Element();n.textContent=text;n.onclick=onclick;host.append(n);return n},flatFilterGroup:(host,key,label,options,value,counts,change)=>{facets[key]={value,counts,change}},breakdownRoute(){},api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),Option:function(){}});
 vm.runInContext('let productionLoadEpoch=1,productionReadEpoch=1;',c);
 vm.runInContext(fs.readFileSync('review_desk/static/management-cards.js','utf8'),c);
 c.reviewPagination=(_host,page)=>{c.page=page};c.managementSections=(_host,groups,card)=>{drawn.length=0;for(const g of groups)for(const r of g.items)card(_host,r)};c.entitySmallCard=(_host,row,info)=>drawn.push({id:row.object_id,adoption:info.adoption});
 return {c,state,result,pending,drawn,facets,load:()=>c.loadEntityManagement(result,{epoch:1})};
}
const fresh=(f,status)=>({...f.result,entity_adoption_statuses:{...f.result.entity_adoption_statuses,e0:status}});
test('[defect-probing] late old index response cannot overwrite a newer decision projection',async()=>{
 const f=fixture();await f.load();const older=f.state.refreshEntityIndex(),newer=f.state.refreshEntityIndex();
 f.pending[1].resolve(fresh(f,'accepted'));await newer;f.pending[0].resolve(fresh(f,'unaccepted'));await older;
 assert.equal(f.facets.acceptance.counts.accepted,1);assert.equal(f.facets.acceptance.counts.unaccepted,43);
});
test('refresh uses current search and acceptance filters and preserves or clamps pagination',async()=>{
 const f=fixture();await f.load();assert.equal(f.c.page.page,2);
 const keep=f.state.refreshEntityIndex();f.pending[0].resolve(fresh(f,'accepted'));await keep;assert.equal(f.c.page.page,2);
 const change=f.state.refreshEntityIndex();f.state.managementLists.entities.filters.search='entity 0';f.state.managementLists.entities.filters.acceptance='unaccepted';
 f.pending[1].resolve(fresh(f,'accepted'));await change;
 assert.equal(f.drawn.length,0);assert.equal(f.c.page.page,1);assert.equal(f.facets.acceptance.value,'unaccepted');
});
test('list refresh is inert after leaving and returning to a newer page lifecycle',async()=>{
 const f=fixture();await f.load();const oldRefresh=f.state.refreshEntityIndex,pending=oldRefresh();
 vm.runInContext('productionLoadEpoch++',f.c);f.pending[0].resolve(fresh(f,'accepted'));await pending;
 assert.equal(f.facets.acceptance.counts.accepted,0);const inactive=oldRefresh();const requests=f.pending.length;if(requests>1)f.pending[1].resolve(fresh(f,'accepted'));await inactive;assert.equal(requests,1);
});

test('saved decision plus index read failure stays explicit and its retry only reads the index',async()=>{
 const f=fixture();await f.load();const reading=f.state.refreshEntityIndex('「阿蘅」的采纳已保存');
 f.pending[0].reject(Error('index unavailable'));await reading;
 assert.equal(f.facets.acceptance.counts.accepted,0);
 const text=f.c.$().children[0].children.flatMap(n=>n.children||[]).map(n=>n.textContent||'').join(' ');
 assert.match(text,/已保存.*尚未更新/);
 const retry=f.state.refreshEntityIndex();f.pending[1].resolve(fresh(f,'accepted'));await retry;assert.equal(f.facets.acceptance.counts.accepted,1);
});
