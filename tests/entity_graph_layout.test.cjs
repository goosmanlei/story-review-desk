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
function sample(path){
 const tokens=path.match(/[MLC]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi),points=[];let i=0,p;
 while(i<tokens.length){const op=tokens[i++],read=()=>[Number(tokens[i++]),Number(tokens[i++])];
  if(op==='M'){p=read();points.push(null,p);}else if(op==='L'){const b=read();for(let j=1;j<=32;j++){const t=j/32;points.push([p[0]+(b[0]-p[0])*t,p[1]+(b[1]-p[1])*t]);}p=b;}
  else{const c=read(),d=read(),b=read();for(let j=1;j<=48;j++){const t=j/48,u=1-t;points.push([u*u*u*p[0]+3*u*u*t*c[0]+3*u*t*t*d[0]+t*t*t*b[0],u*u*u*p[1]+3*u*u*t*c[1]+3*u*t*t*d[1]+t*t*t*b[1]]);}p=b;}
 }return points;
}
function inspect(nodes,edges){const geometry=c.managementEdgeGeometry(nodes,edges);assert.equal(geometry.views.length,edges.length);
 const seen=new Set(),ports=new Set();
 for(let i=0;i<geometry.views.length;i++){const v=geometry.views[i];assert.match(v.path,/C/);assert.ok(!seen.has(v.path));seen.add(v.path);
  for(const n of nodes)assert.equal(c.managementOverlap(v.label,n),false);for(let j=0;j<i;j++)assert.equal(c.managementOverlap(v.label,geometry.views[j].label),false);
  for(const port of [v.ap,v.bp]){const key=port.point.join(',');assert.ok(!ports.has(key),'separate endpoint ports');ports.add(key);}
  for(const p of sample(v.path).filter(Boolean))for(const b of [...nodes,...geometry.views.map(v=>v.label)])assert.equal(p[0]>b.x+.01&&p[0]<b.x+b.w-.01&&p[1]>b.y+.01&&p[1]<b.y+b.h-.01,false,v.edge.id+' crosses card or caption');
 }
 return geometry;
}
test('smooth separated routes do not cross cards or captions',()=>inspect(c.managementGraphLayout(rows,edges),edges));
test('dense undirected, long captions and enlarged cards keep every real edge',()=>{
 const dense=[];for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)dense.push({...edge(rows[i].object_id,rows[j].object_id,'related'),summary:'保留完整简短摘要，不能被别的卡片遮盖'});
 const nodes=c.managementGraphLayout(rows,dense);nodes[0].h=160;inspect(nodes,dense);
});
test('node focus includes only incident edges, never edges between neighbours or two hops',()=>{
 const graph=[edge('A','B'),edge('A','C'),edge('B','C'),edge('B','D')];
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'node',id:'A'})),['AB','AC']);
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'node',id:'Z'})),[]);
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'edge',id:'BC'})),['BC']);
});
test('shared endpoint multi-edges have distinct ports and no shared straight section',()=>{
 const graph=[{...edge('A','B','related'),id:'first'},{...edge('A','B','related'),id:'second'},{...edge('B','A','related'),id:'third'}],g=inspect(c.managementGraphLayout(rows.slice(0,2),graph),graph);
 const runs=v=>v.routes.flatMap(route=>route.slice(1).map((b,i)=>[route[i],b]).filter(([a,b])=>a[0]===b[0]||a[1]===b[1]));
 for(let i=0;i<g.views.length;i++)for(let j=0;j<i;j++)for(const [a,b] of runs(g.views[i]))for(const [d,e] of runs(g.views[j])){
  const shared=a[0]===b[0]&&d[0]===e[0]&&a[0]===d[0]?Math.min(Math.max(a[1],b[1]),Math.max(d[1],e[1]))-Math.max(Math.min(a[1],b[1]),Math.min(d[1],e[1])):a[1]===b[1]&&d[1]===e[1]&&a[1]===d[1]?Math.min(Math.max(a[0],b[0]),Math.max(d[0],e[0]))-Math.max(Math.min(a[0],b[0]),Math.min(d[0],e[0])):0;
  assert.ok(shared<=1,'distinct edges cannot share a run');
 }
});
