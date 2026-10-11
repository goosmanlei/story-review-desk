const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const context=vm.createContext({});vm.runInContext(fs.readFileSync('review_desk/static/management-cards.js','utf8'),context);
const page=(groups,p,rows)=>JSON.parse(JSON.stringify(context.groupedCardPage(groups,p,rows)));
test('Independent group endings consume rows and continuation retains the group',()=>{
 const groups=[{key:'a',items:['a0','a1','a2','a3']},{key:'b',items:['b0']},{key:'c',items:Array.from({length:12},(_,i)=>'c'+i)}];
 const first=page(groups,1,3),second=page(groups,2,3);
 assert.deepEqual(first.groups.map(g=>g.items),[['a0','a1','a2','a3'],['b0'],['c0','c1','c2','c3']]);
 assert.deepEqual(second.groups.map(g=>g.items),[['c4','c5','c6','c7','c8','c9','c10','c11']]);assert.equal(second.groups[0].key,'c');assert.equal(second.groups[0].continued,true);
});
test('All pages contain each entity or group/material identity once; width is not a pagination input',()=>{
 const groups=[1,2,31,4,78,1].map((n,j)=>({key:'g'+j,items:Array.from({length:n},(_,i)=>`${j}/${i}`)})),first=page(groups,1,10),seen=[];
 for(let p=1;p<=first.pages;p++){const current=page(groups,p,10);assert.ok(current.groups.reduce((n,g)=>n+g.items.length,0)<=40);seen.push(...current.groups.flatMap(g=>g.items))}
 assert.deepEqual(seen,groups.flatMap(g=>g.items));assert.equal(new Set(seen).size,seen.length);assert.equal(page(groups,100,10).page,first.pages);
 assert.equal(page([],50,10).page,1);assert.equal(page([],50,10).pages,1);assert.equal(page(groups,1,5).rowsPerPage,5);
});

test('All supported row sizes preserve independent four-column rows and every item',()=>{
 const groups=[{key:'a',items:['a']},{key:'b',items:Array.from({length:205},(_,i)=>'b'+i)},{key:'c',items:['c']}];
 for(const rows of [5,10,20,50]){
  const first=page(groups,1,rows),all=[];assert.equal(first.totalRows,54);
  for(let p=1;p<=first.pages;p++){const current=page(groups,p,rows);assert.ok(current.groups.reduce((n,g)=>n+Math.ceil(g.items.length/4),0)<=rows);all.push(...current.groups.flatMap(g=>g.items));}
  assert.deepEqual(all,groups.flatMap(g=>g.items));assert.equal(page(groups,999,rows).page,first.pages);
 }
 assert.equal(page([{key:'only',items:['a','b','c','d']}],1,10).pages,1);
 assert.equal(page([{key:'only',items:['a']}],99,10).page,1);
});

test('Material media groups deduplicate uses and candidates, order results then natural codes, and retain unknowns',()=>{
 const material=(id,media,generated=false,extra={})=>({object_id:id,canonical_material_id:id,business_code:id,media_type:media,generated,...extra});
 const items=[material('M10','image'),material('M2','image'),material('M20','image',true,{candidate_count:3}),material('M1','audio',true),material('M30','video'),material('M40','project'),material('M50','document'),material('M60',null),material('M70','future'),material('M20','image',true)];
 const groups=JSON.parse(JSON.stringify(context.managementMaterialGroups({items})));
 assert.deepEqual(groups.map(g=>g.key),['image','audio','video','project','document','unknown']);
 assert.deepEqual(groups[0].items.map(i=>i.object_id),['M20','M2','M10']);
 assert.equal(groups.flatMap(g=>g.items).length,9);
 assert.deepEqual(groups.at(-1).items.map(i=>i.object_id),['M60','M70']);
 assert.deepEqual(JSON.parse(JSON.stringify(context.managementMaterialGroups({items:[]}))),[]);
 assert.equal(context.managementMaterialGroups({items:[material('M1','video')]}).length,1);
});
test('Five-column material pages exhaust each media group exactly once at every row size',()=>{
 const groups=[1,34,5,11,203].map((n,j)=>({key:'g'+j,title:'media'+j,items:Array.from({length:n},(_,i)=>`${j}/${i}`)}));
 const materialPage=(p,rows)=>JSON.parse(JSON.stringify(context.groupedCardPage(groups,p,rows,5)));
 for(const rows of [5,10,20,50]){
  const first=materialPage(1,rows),all=[];assert.equal(first.totalRows,53);assert.equal(first.columns,5);
  for(let p=1;p<=first.pages;p++){const current=materialPage(p,rows);assert.ok(current.groups.reduce((n,g)=>n+Math.ceil(g.items.length/5),0)<=rows);assert.ok(current.groups.flatMap(g=>g.items).length<=rows*5);all.push(...current.groups.flatMap(g=>g.items));assert.ok(current.groups.every(g=>g.title));}
  assert.deepEqual(all,groups.flatMap(g=>g.items));assert.equal(new Set(all).size,all.length);assert.equal(materialPage(999,rows).page,first.pages);
 }
 assert.equal(context.groupedCardPage([],99,10,5).pages,1);
});
