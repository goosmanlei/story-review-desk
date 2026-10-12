/* Joint card/caption placement and spline routing. The renderer is supplied by
 * the worker (or by the Node test), so this module has no DOM or network work. */
const EntityGraphRouting = (() => {
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const midpoint=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
  function flatten(a,b,c,d,out,depth=0){
    const length=distance(a,d),deviation=p=>length?Math.abs((d[0]-a[0])*(a[1]-p[1])-(a[0]-p[0])*(d[1]-a[1]))/length:distance(a,p);
    if(depth===14||Math.max(deviation(b),deviation(c))<=.2){out.push(d);return;}
    const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),m=midpoint(abc,bcd);
    flatten(a,ab,abc,m,out,depth+1);flatten(m,bcd,cd,d,out,depth+1);
  }
  function samples(curve){const points=[curve[0]];for(let i=1;i<curve.length;i+=3)flatten(curve[i-1],curve[i],curve[i+1],curve[i+2],points);return points;}
  const segments=points=>points.slice(1).map((b,i)=>({a:points[i],b,l:Math.min(points[i][0],b[0]),r:Math.max(points[i][0],b[0]),t:Math.min(points[i][1],b[1]),d:Math.max(points[i][1],b[1])}));
  function intersection(s,t){
    if(s.r<t.l||t.r<s.l||s.d<t.t||t.d<s.t)return null;
    const [a,b,c,d]=[s.a,s.b,t.a,t.b],x=b[0]-a[0],y=b[1]-a[1],xx=d[0]-c[0],yy=d[1]-c[1],den=x*yy-y*xx;
    if(Math.abs(den)<1e-8)return null;
    const u=((c[0]-a[0])*yy-(c[1]-a[1])*xx)/den,v=((c[0]-a[0])*y-(c[1]-a[1])*x)/den;
    return u>=-1e-8&&u<=1+1e-8&&v>=-1e-8&&v<=1+1e-8?[a[0]+u*x,a[1]+u*y]:null;
  }
  function crossings(views){
    const lines=views.map(v=>v.curves.flatMap(c=>segments(samples(c)))),found=[];
    for(let i=0;i<lines.length;i++)for(let j=0;j<i;j++){
      const hits=[];for(const s of lines[i])for(const t of lines[j]){const p=intersection(s,t);if(p&&!hits.some(q=>distance(p,q)<.7))hits.push(p);}
      for(const point of hits)found.push({edges:[views[j].edge.id,views[i].edge.id],point});
    }
    return found;
  }
  const path=curve=>'M'+curve[0].join(' ')+curve.slice(1).reduce((s,p,i)=>s+(i%3===0?' C':' ')+p.join(' '),'');
  const overlap=(a,b)=>a.x<b.x+b.w-.05&&a.x+a.w>b.x+.05&&a.y<b.y+b.h-.05&&a.y+a.h>b.y+.05;
  // Clip sampled segments against the *interior* of each obstacle. Testing
  // only sample points misses a long straight span crossing an entire card.
  function enters(segment,box){
    let low=0,high=1;
    for(const [start,delta,min,max] of [[segment.a[0],segment.b[0]-segment.a[0],box.x+.3,box.x+box.w-.3],[segment.a[1],segment.b[1]-segment.a[1],box.y+.3,box.y+box.h-.3]]){
      if(Math.abs(delta)<1e-9){if(start<=min||start>=max)return false;}
      else {let a=(min-start)/delta,b=(max-start)/delta;if(a>b)[a,b]=[b,a];low=Math.max(low,a);high=Math.min(high,b);if(low>=high)return false;}
    }
    return high>=0&&low<=1;
  }
  function valid(geometry){
    const boxes=[...geometry.nodes,...geometry.views.map(v=>v.label)];
    for(let i=0;i<boxes.length;i++)for(let j=0;j<i;j++)if(overlap(boxes[i],boxes[j]))return false;
    for(const view of geometry.views)for(const c of view.curves)for(const segment of segments(samples(c)))for(const box of boxes)if(enters(segment,box))return false;
    return true;
  }
  function order(nodes,edges,variant){
    const adjacency=new Map(nodes.map(n=>[n.id,[]]));for(const e of edges){adjacency.get(e.endpoints[0]).push(e.endpoints[1]);adjacency.get(e.endpoints[1]).push(e.endpoints[0]);}
    const compare=(a,b)=>adjacency.get(b).length-adjacency.get(a).length||a.localeCompare(b),result=new Map();
    for(const n of [...nodes].sort((a,b)=>compare(a.id,b.id))){const queue=[n.id];while(queue.length){const id=queue.shift();if(result.has(id))continue;result.set(id,result.size);queue.push(...[...adjacency.get(id)].sort((a,b)=>(variant%2?-1:1)*(adjacency.get(b).length-adjacency.get(a).length)||a.localeCompare(b)));}}
    return result;
  }
  // Four deterministic candidates vary neighbour ordering and, only for
  // undirected components, orientation. Real dependency ranks are preserved.
  function candidate(viz,nodes,edges,variant){
    const directed=nodes.some(n=>n.rank!==null),ordering=order(nodes,edges,variant),names=new Map(nodes.map((n,i)=>[n.id,'n'+i])),labelSizes=edges.map(e=>({w:180,h:Math.max(48,Math.ceil(Array.from(e.summary||'').length/14)*20+18)}));
    const graph={directed:true,graphAttributes:{rankdir:directed||variant<2?'LR':'TB',splines:true,nodesep:.48,ranksep:.48,margin:0,pad:0,nslimit:5,nslimit1:5,mclimit:2},nodeAttributes:{shape:'box',label:'',fixedsize:true},edgeAttributes:{dir:'none'},nodes:nodes.map((n,i)=>({name:'n'+i,attributes:{width:n.w/72,height:n.h/72}})),edges:[],subgraphs:[]};
    if(directed){const ranks=new Map();for(const n of nodes){if(!ranks.has(n.rank))ranks.set(n.rank,[]);ranks.get(n.rank).push({name:names.get(n.id)});}for(const list of ranks.values())graph.subgraphs.push({graphAttributes:{rank:'same'},nodes:list});}
    const orientations=[];
    for(const [i,e] of edges.entries()){
      let [a,b]=e.endpoints;if(e.direction==='reverse')[a,b]=[b,a];
      if(e.direction==='related'&&ordering.get(a)>ordering.get(b))[a,b]=[b,a];orientations.push([a,b]);
      const box=labelSizes[i];graph.nodes.push({name:'e'+i,attributes:{width:box.w/72,height:box.h/72}});
      const constraint=!directed||nodes.find(n=>n.id===a).rank<nodes.find(n=>n.id===b).rank;
      graph.edges.push({tail:names.get(a),head:'e'+i,attributes:{id:'r'+i+'a',constraint}},{tail:'e'+i,head:names.get(b),attributes:{id:'r'+i+'b',constraint}});
    }
    if(variant%2)graph.nodes.reverse();
    const output=viz.renderJSON(graph,{engine:'dot'}),bounds=output.bb.split(',').map(Number),height=bounds[3],placed=new Map();
    for(const obj of output.objects||[]){if(!obj.pos)continue;const [x,y]=obj.pos.split(',').map(Number);placed.set(obj.name,{x:x-Number(obj.width)*36,y:height-y-Number(obj.height)*36,w:Number(obj.width)*72,h:Number(obj.height)*72});}
    const outNodes=nodes.map((n,i)=>({...n,...placed.get('n'+i),w:n.w,h:n.h})),by=new Map(outNodes.map(n=>[n.id,n])),routes=new Map();
    for(const line of output.edges||[]){const draws=(line._draw_||[]).filter(d=>d.op==='b');if(draws.length!==1)throw Error('实体关系未返回完整样条');routes.set(line.id,draws[0].points.map(([x,y])=>[x,height-y]));}
    const views=edges.map((edge,i)=>{
      let [a,b]=edge.endpoints;if(edge.direction==='reverse')[a,b]=[b,a];const reverse=orientations[i][0]!==a;
      let curves=[routes.get('r'+i+'a'),routes.get('r'+i+'b')];if(curves.some(c=>!c||c.length<4||(c.length-1)%3))throw Error('实体关系连线不完整');
      if(reverse)curves=curves.reverse().map(c=>[...c].reverse());
      return {edge,a:by.get(a),b:by.get(b),label:{...placed.get('e'+i),...labelSizes[i],id:'caption:'+edge.id},curves};
    });
    const geometry={nodes:outNodes,views,width:bounds[2],height};
    if(!valid(geometry))return null;
    geometry.crossings=crossings(views);return geometry;
  }
  function layout(viz,nodes,edges){
    if(new Set(nodes.map(n=>n.id)).size!==nodes.length||new Set(edges.map(e=>e.id)).size!==edges.length)throw Error('实体关系身份重复');
    const ids=new Set(nodes.map(n=>n.id));if(edges.some(e=>e.endpoints.length!==2||e.endpoints.some(id=>!ids.has(id))))throw Error('实体关系端点不完整');
    const groups=new Map();for(const n of nodes){if(!groups.has(n.component))groups.set(n.component,[]);groups.get(n.component).push(n);}
    const components=[];
    for(const group of groups.values()){
      const members=new Set(group.map(n=>n.id)),relations=edges.filter(e=>members.has(e.endpoints[0])&&members.has(e.endpoints[1]));
      if(!relations.length){for(const n of group)components.push({nodes:[{...n,x:0,y:0}],views:[],width:n.w,height:n.h,crossings:[]});continue;}
      let best=null;
      for(let i=0;i<4;i++){
        const next=candidate(viz,group,relations,i);if(!next)continue;
        const cost=g=>g.width*g.height+Math.max(g.width,g.height)**2*.15;
        if(!best||next.crossings.length<best.crossings.length||next.crossings.length===best.crossings.length&&cost(next)<cost(best))best=next;
      }
      if(!best)throw Error('实体关系无法完整避开卡片与摘要');components.push(best);
    }
    components.sort((a,b)=>b.width*b.height-a.width*a.height);
    const area=components.reduce((s,c)=>s+(c.width+50)*(c.height+50),0),limit=Math.max(900,Math.sqrt(area*1.5),...components.map(c=>c.width)),result={nodes:[],views:[],width:480,height:300};
    let x=40,y=40,rowHeight=0;
    for(const c of components){if(x>40&&x+c.width>limit+40){x=40;y+=rowHeight+50;rowHeight=0;}
      const shift=p=>[p[0]+x,p[1]+y];for(const n of c.nodes){n.x+=x;n.y+=y;result.nodes.push(n);}
      for(const v of c.views){v.label.x+=x;v.label.y+=y;v.curves=v.curves.map(curve=>curve.map(shift));v.routes=v.curves.map(samples);v.points=v.routes.flat();v.path=v.curves.map(path).join(' ');v.ap={point:v.curves[0][0]};v.bp={point:v.curves[1].at(-1)};result.views.push(v);}
      result.width=Math.max(result.width,x+c.width+40);result.height=Math.max(result.height,y+c.height+40);x+=c.width+50;rowHeight=Math.max(rowHeight,c.height);
    }
    // Preserve caller identity/order independently from packing and search order.
    result.nodes.sort((a,b)=>nodes.findIndex(n=>n.id===a.id)-nodes.findIndex(n=>n.id===b.id));result.views.sort((a,b)=>edges.indexOf(a.edge)-edges.indexOf(b.edge));
    if(result.views.length!==edges.length)throw Error('实体关系集合不完整');return result;
  }
  return {layout,samples,path,crossings,valid};
})();
if(typeof module!=='undefined')module.exports=EntityGraphRouting;
