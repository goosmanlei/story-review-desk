const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const context=vm.createContext({});vm.runInContext(fs.readFileSync('review_desk/static/management-cards.js','utf8'),context);
const page=(groups,p,rows)=>JSON.parse(JSON.stringify(context.groupedCardPage(groups,p,rows)));
test('Independent group endings consume rows and continuation retains the group',()=>{
 const groups=[{key:'a',items:['a0','a1','a2','a3']},{key:'b',items:['b0']},{key:'c',items:Array.from({length:12},(_,i)=>'c'+i)}];
 const first=page(groups,1,4),second=page(groups,2,4);
 assert.deepEqual(first.groups.map(g=>g.items),[['a0','a1','a2','a3'],['b0'],['c0','c1','c2']]);
 assert.deepEqual(second.groups.map(g=>g.items),[['c3','c4','c5','c6','c7','c8','c9','c10','c11']]);assert.equal(second.groups[0].key,'c');assert.equal(second.groups[0].continued,true);
});
test('All pages contain each entity or group/material identity once; width is not a pagination input',()=>{
 const groups=[1,2,31,4,78,1].map((n,j)=>({key:'g'+j,items:Array.from({length:n},(_,i)=>`${j}/${i}`)})),first=page(groups,1,10),seen=[];
 for(let p=1;p<=first.pages;p++){const current=page(groups,p,10);assert.ok(current.groups.reduce((n,g)=>n+g.items.length,0)<=30);seen.push(...current.groups.flatMap(g=>g.items))}
 assert.deepEqual(seen,groups.flatMap(g=>g.items));assert.equal(new Set(seen).size,seen.length);assert.equal(page(groups,100,10).page,first.pages);
 assert.equal(page([],50,10).page,1);assert.equal(page([],50,10).pages,1);assert.equal(page(groups,1,5).rowsPerPage,5);
});
