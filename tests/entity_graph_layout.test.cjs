const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const c={businessCode:r=>r.business_code||r.object_id};vm.createContext(c);vm.runInContext(fs.readFileSync('review_desk/static/entity-relations.js','utf8'),c);
const rows='ABCDEFGHIZ'.split('').map(object_id=>({object_id,payload:{title:object_id}}));
const edge=(a,b,direction='forward')=>({id:a+b,endpoints:[a,b],direction,summary:a+' 与 '+b+' 的真实关系'});
const edges=[edge('A','B'),edge('B','C'),edge('D','C'),edge('C','E','reverse'),edge('F','G'),edge('G','H'),edge('H','F'),edge('C','I','related')];
test('directed ranks, reverse, multiple parents, SCC, undirected and isolated identities',()=>{
 const nodes=c.managementGraphLayout(rows,edges),by=new Map(nodes.map(n=>[n.id,n]));assert.equal(new Set(nodes.map(n=>n.id)).size,rows.length);
 for(const [a,b] of [['A','B'],['B','C'],['D','C'],['E','C']])assert.ok(by.get(a).x<by.get(b).x,a+' upstream of '+b);
 assert.equal(by.get('F').x,by.get('G').x);assert.equal(by.get('G').x,by.get('H').x);assert.notEqual(by.get('Z').component,by.get('A').component);
 for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)assert.equal(c.managementOverlap(nodes[i],nodes[j]),false);
});
const router=require('../review_desk/static/entity-graph-routing.js'),{instance}=require('../review_desk/static/vendor/viz-3.31.0.js');
const {audit}=require('./helpers/graph-audit.cjs'),{inspect:measure}=require('./helpers/graph-paths.cjs');
const renderer=instance();
async function inspect(nodes,edges){
 const geometry=router.layout(await renderer,nodes,edges);
 assert.equal(geometry.views.length,edges.length);
 assert.deepEqual(geometry.nodes.map(n=>n.id),Array.from(nodes,n=>n.id));
 assert.deepEqual(audit(geometry).issues,[]);
 const ports=new Set();
 for(const [i,v] of geometry.views.entries()){
  assert.deepEqual(v.edge,edges[i]);assert.ok(!/[LQ]/.test(v.path));
  for(const port of [v.ap,v.bp]){const key=port.point.join(',');assert.ok(!ports.has(key),'separate endpoint ports');ports.add(key);}
 }
 return geometry;
}
test('ASH012 adjacent caption exits stay separate from earlier full routes',async()=>{
 const f=JSON.parse(fs.readFileSync('tests/fixtures/entity-graph-ash012.json','utf8')),nodes=c.managementGraphLayout(f.rows,f.edges);nodes.forEach(n=>n.h=f.card_height);await inspect(nodes,f.edges);
});
test('ASH242 measured input keeps every exact relationship, including the stranded blade route',async()=>{
 const f=JSON.parse(fs.readFileSync('tests/fixtures/entity-graph-ash242.json','utf8')),nodes=c.managementGraphLayout(f.rows,f.edges);nodes.forEach(n=>n.h=f.card_height);
 const g=await inspect(nodes,f.edges);
 assert.deepEqual(Array.from(g.views,v=>v.edge.id),f.edges.map(e=>e.id));
 for(const v of g.views){assert.deepEqual(Array.from([v.a.id,v.b.id]),v.edge.direction==='reverse'?[...v.edge.endpoints].reverse():v.edge.endpoints);assert.ok(v.path.startsWith('M'+v.ap.point.join(' ')));assert.ok(v.path.endsWith(v.bp.point.join(' ')));}
 assert.ok(g.views.some(v=>v.edge.id==='relation-7f655d38ec2be91c7e458555b3dc1fb0'));
});
test('smooth separated routes do not cross cards or captions',()=>inspect(c.managementGraphLayout(rows,edges),edges));
test('dense undirected, long captions and enlarged cards keep every real edge',async()=>{
 const dense=[];for(let i=0;i<8;i++)for(let j=i+1;j<8;j++)dense.push({...edge(rows[i].object_id,rows[j].object_id,'related'),summary:'保留完整简短摘要，不能被别的卡片遮盖'});
 const nodes=c.managementGraphLayout(rows,dense);nodes[0].h=160;await inspect(nodes,dense);
});
test('node focus includes only incident edges, never edges between neighbours or two hops',()=>{
 const graph=[edge('A','B'),edge('A','C'),edge('B','C'),edge('B','D')];
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'node',id:'A'})),['AB','AC']);
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'node',id:'Z'})),[]);
 assert.deepEqual(Array.from(c.managementGraphSelection(graph,{kind:'edge',id:'BC'})),['BC']);
});
test('shared endpoint multi-edges have distinct ports and no shared straight section',async()=>{
 const graph=[{...edge('A','B','related'),id:'first'},{...edge('A','B','related'),id:'second'},{...edge('B','A','related'),id:'third'}];await inspect(c.managementGraphLayout(rows.slice(0,2),graph),graph);
});

test('joint placement removes the crossing in a planar family/house graph; bends are broad smooth cubics',async()=>{
 const graph=[edge('A','B','related'),edge('A','C','related'),edge('A','D','related'),edge('B','D','related'),edge('C','D','related')];
 const g=await inspect(c.managementGraphLayout(rows.slice(0,5),graph),graph);
 assert.equal(measure(g).crossings,0);
 const shape=audit(g);assert.ok(shape.maxTangent<1);
 assert.ok(shape.curvedLengths.length>0);assert.ok(Math.max(...shape.curvedLengths)>80,'a bend must span the route, not just a 16 px orthogonal corner');
 assert.deepEqual(router.layout(await renderer,c.managementGraphLayout(rows.slice(0,5),graph),graph),g,'deterministic layout');
});
test('actual spline placement preserves dependency direction, multiple parents and SCC ranks',async()=>{
 const g=await inspect(c.managementGraphLayout(rows,edges),edges),by=new Map(g.nodes.map(n=>[n.id,n]));
 for(const [a,b] of [['A','B'],['B','C'],['D','C'],['E','C']])assert.ok(by.get(a).x<by.get(b).x);
 assert.equal(by.get('F').x,by.get('G').x);assert.equal(by.get('G').x,by.get('H').x);
});
test('one missing spline rejects the entire graph instead of silently omitting an edge',async()=>{
 const viz=await renderer,broken={renderJSON(...args){const result=viz.renderJSON(...args);result.edges[1]._draw_=[];return result;}};
 assert.throws(()=>router.layout(broken,c.managementGraphLayout(rows,edges),edges),/完整样条/);
});
test('obstacle validation catches a long straight cubic with no interior samples',()=>{
 assert.equal(router.valid({nodes:[{x:30,y:30,w:40,h:40}],views:[{label:{x:150,y:100,w:20,h:20},curves:[[[0,50],[25,50],[75,50],[100,50]]]}]}),false);
});
