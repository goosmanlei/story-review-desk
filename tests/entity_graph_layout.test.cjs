const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const c={businessCode:r=>r.object_id};vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/entity-relations.js','utf8'),c);
const rows='ABCDEFGHIZ'.split('').map(object_id=>({object_id,payload:{title:object_id}}));
const edge=(a,b,direction='forward')=>({id:a+b,endpoints:[a,b],direction,summary:a+' 与 '+b+' 的真实关系'});
const edges=[edge('A','B'),edge('B','C'),edge('D','C'),edge('C','E','reverse'),edge('F','G'),edge('G','H'),edge('H','F'),edge('C','I','related')];
test('directed ranks, reverse, multiple parents, SCC, undirected and isolated identities',()=>{
 const nodes=c.managementGraphLayout(rows,edges),by=new Map(nodes.map(n=>[n.id,n]));assert.equal(new Set(nodes.map(n=>n.id)).size,rows.length);
 for(const [a,b] of [['A','B'],['B','C'],['D','C'],['E','C']])assert.ok(by.get(a).x<by.get(b).x,a+' upstream of '+b);
 assert.equal(by.get('F').x,by.get('G').x);assert.equal(by.get('G').x,by.get('H').x);assert.notEqual(by.get('Z').component,by.get('A').component);
 for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)assert.equal(c.managementOverlap(nodes[i],nodes[j]),false);
});
function inspect(nodes,edges){const geometry=c.managementEdgeGeometry(nodes,edges);assert.equal(geometry.views.length,edges.length);
 for(let i=0;i<geometry.views.length;i++){const v=geometry.views[i];for(const n of nodes)assert.equal(c.managementOverlap(v.label,n),false);for(let j=0;j<i;j++)assert.equal(c.managementOverlap(v.label,geometry.views[j].label),false);
  for(let k=1;k<v.points.length;k++){const [a,b]=[v.points[k-1],v.points[k]];assert.ok(a[0]===b[0]||a[1]===b[1]);for(const n of nodes){const crossed=a[0]===b[0]?a[0]>n.x&&a[0]<n.x+n.w&&Math.max(a[1],b[1])>n.y&&Math.min(a[1],b[1])<n.y+n.h:a[1]>n.y&&a[1]<n.y+n.h&&Math.max(a[0],b[0])>n.x&&Math.min(a[0],b[0])<n.x+n.w;assert.equal(crossed,false,v.edge.id+' crosses '+n.id);}}
 }
 return geometry;
}
test('orthogonal routes never cross cards or cover another caption',()=>inspect(c.managementGraphLayout(rows,edges),edges));
test('dense undirected, long captions and enlarged cards keep every real edge',()=>{
 const dense=[];for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)dense.push({...edge(rows[i].object_id,rows[j].object_id,'related'),summary:'保留完整简短摘要，不能被别的卡片遮盖'});
 const nodes=c.managementGraphLayout(rows,dense);nodes[0].h=160;inspect(nodes,dense);
});
