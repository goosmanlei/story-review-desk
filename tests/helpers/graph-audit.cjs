const m=require('./graph-paths.cjs');
const boxOverlap=(a,b)=>a.x<b.x+b.w-.1&&a.x+a.w>b.x+.1&&a.y<b.y+b.h-.1&&a.y+a.h>b.y+.1;
function rectHit(s,b,inset=.3){let lo=0,hi=1;for(const [a,d,min,max] of [[s.a[0],s.b[0]-s.a[0],b.x+inset,b.x+b.w-inset],[s.a[1],s.b[1]-s.a[1],b.y+inset,b.y+b.h-inset]]){if(Math.abs(d)<1e-9){if(a<=min||a>=max)return false;}else{let x=(min-a)/d,y=(max-a)/d;if(x>y)[x,y]=[y,x];lo=Math.max(lo,x);hi=Math.min(hi,y);if(lo>=hi)return false;}}return hi>=0&&lo<=1;}
function near(s,t){const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],len=Math.hypot(dx,dy),tx=t.b[0]-t.a[0],ty=t.b[1]-t.a[1],tl=Math.hypot(tx,ty);if(!len||!tl||Math.abs(dx*ty-dy*tx)/len/tl>.12)return null;const q=p=>((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/len,r=p=>Math.abs(dx*(p[1]-s.a[1])-dy*(p[0]-s.a[0]))/len;if(Math.max(r(t.a),r(t.b))>2)return null;const lo=Math.max(0,Math.min(q(t.a),q(t.b))),hi=Math.min(len,Math.max(q(t.a),q(t.b)));return hi>lo?[lo,hi]:null;}
function audit(g){let issues=[],angles=[],curved=[];const boxes=[...g.nodes,...g.views.map(v=>v.label)],routes=g.views.map(v=>m.paths(v.path)),lines=routes.map(m.segs);for(let i=0;i<boxes.length;i++)for(let j=0;j<i;j++)if(boxOverlap(boxes[i],boxes[j]))issues.push(['boxes',boxes[i].id,boxes[j].id]);
 const ports=new Set();
 const boundary=(p,b)=>p[0]>=b.x-1&&p[0]<=b.x+b.w+1&&p[1]>=b.y-1&&p[1]<=b.y+b.h+1&&Math.min(Math.abs(p[0]-b.x),Math.abs(p[0]-b.x-b.w),Math.abs(p[1]-b.y),Math.abs(p[1]-b.y-b.h))<=1;
 for(const box of boxes)if(box.x<-.1||box.y<-.1||box.x+box.w>g.width+.1||box.y+box.h>g.height+.1)issues.push(['bounds',box.id]);
 for(let i=0;i<g.views.length;i++){const v=g.views[i],ss=lines[i],rs=routes[i];
  for(const [p,box,isEntity] of [[rs[0][0],v.a,true],[rs[0].at(-1),v.label,false],[rs[1][0],v.label,false],[rs[1].at(-1),v.b,true]]){
   if(!boundary(p,box))issues.push(['attachment',v.edge.id,box.id,p]);
   if(isEntity){const key=p.join(',');if(ports.has(key))issues.push(['shared-port',v.edge.id,key]);ports.add(key);}
  }
  for(const p of rs.flat())if(p[0]<-.1||p[1]<-.1||p[0]>g.width+.1||p[1]>g.height+.1)issues.push(['route-bounds',v.edge.id]);for(const b of boxes)if(ss.some(s=>rectHit(s,b)))issues.push(['obstacle',v.edge.id,b.id]);
 for(let j=0;j<ss.length;j++)for(let k=0;k<j-1;k++){const p=m.cross(ss[j],ss[k]);if(p)issues.push(['self',v.edge.id,p]);}
 for(const c of v.curves||[]){for(let j=3;j<c.length-1;j+=3){const a=[c[j][0]-c[j-1][0],c[j][1]-c[j-1][1]],b=[c[j+1][0]-c[j][0],c[j+1][1]-c[j][1]],l=Math.hypot(...a)*Math.hypot(...b);if(l)angles.push(Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/l)))*180/Math.PI);}
 for(let j=1;j<c.length;j+=3){const a=c[j-1],d=c[j+2],length=m.dist(a,d);if(length){const dev=p=>Math.abs((d[0]-a[0])*(p[1]-a[1])-(d[1]-a[1])*(p[0]-a[0]))/length;if(Math.max(dev(c[j]),dev(c[j+1]))>1)curved.push(length);}}}
 for(let j=0;j<i;j++){let intervals=[],offset=0;for(const s of ss){for(const t of lines[j]){const p=near(s,t);if(p)intervals.push(p.map(x=>x+offset));}offset+=m.dist(s.a,s.b);}intervals.sort((a,b)=>a[0]-b[0]);let run=null;for(const span of intervals){if(run&&span[0]<=run[1]+.5)run[1]=Math.max(run[1],span[1]);else run=[...span];if(run[1]-run[0]>=16){issues.push(['near-overlap',v.edge.id,g.views[j].edge.id,run[1]-run[0]]);break;}}}
 }
 if(Math.max(0,...angles)>1)issues.push(['tangent',Math.max(...angles)]);
 return {issues,maxTangent:Math.max(0,...angles),curvedLengths:curved};}
module.exports={audit,rectHit,near};
