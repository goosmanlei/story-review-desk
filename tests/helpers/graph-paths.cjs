const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),mix=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
function flat(a,b,c,d,out,depth=0){const l=dist(a,d), deviation=p=>l?Math.abs((d[0]-a[0])*(a[1]-p[1])-(a[0]-p[0])*(d[1]-a[1]))/l:dist(a,p);if(depth>=16||Math.max(deviation(b),deviation(c))<=.15){out.push(d);return;}const ab=mix(a,b),bc=mix(b,c),cd=mix(c,d),abc=mix(ab,bc),bcd=mix(bc,cd),mid=mix(abc,bcd);flat(a,ab,abc,mid,out,depth+1);flat(mid,bcd,cd,d,out,depth+1);}
function paths(d){const ts=d.match(/[MLC]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);let i=0,cur,p,result=[];const read=()=>[+ts[i++],+ts[i++]];while(i<ts.length){let op=ts[i++];if(op==='M'){p=read();cur=[p];result.push(cur);}else if(op==='L'){p=read();cur.push(p);}else if(op==='C'){let a=read(),b=read(),c=read();flat(p,a,b,c,cur);p=c;}else throw Error('Unsupported '+op);}return result;}
const segs=routes=>routes.flatMap(p=>p.slice(1).map((b,i)=>({a:p[i],b,minX:Math.min(p[i][0],b[0]),maxX:Math.max(p[i][0],b[0]),minY:Math.min(p[i][1],b[1]),maxY:Math.max(p[i][1],b[1])})));
function cross(s,t){if(s.maxX<t.minX||t.maxX<s.minX||s.maxY<t.minY||t.maxY<s.minY)return null;const [a,b,c,d]=[s.a,s.b,t.a,t.b],x=b[0]-a[0],y=b[1]-a[1],xx=d[0]-c[0],yy=d[1]-c[1],den=x*yy-y*xx;if(Math.abs(den)<1e-7)return null;const u=((c[0]-a[0])*yy-(c[1]-a[1])*xx)/den,v=((c[0]-a[0])*y-(c[1]-a[1])*x)/den;return u>=-1e-8&&u<=1+1e-8&&v>=-1e-8&&v<=1+1e-8?[a[0]+u*x,a[1]+u*y]:null;}
function sharedEndpoint(p,a,b){
 for(const id of a.edge.endpoints.filter(id=>b.edge.endpoints.includes(id))){
  const endpoint=v=>{const routes=paths(v.path);return id===v.edge.endpoints[v.edge.direction==='reverse'?1:0]?routes[0][0]:routes.at(-1).at(-1);};
  const x=endpoint(a),y=endpoint(b);
  if(x&&y&&dist(x,y)<.2&&dist(p,x)<.2&&dist(p,y)<.2)return true;
 }
 return false;
}
function inspect(g){const pathsBy=g.views.map(v=>paths(v.path)),lines=pathsBy.map(segs),crossings=[];for(let i=0;i<lines.length;i++)for(let j=0;j<i;j++){let hits=[];for(const a of lines[i])for(const b of lines[j]){let p=cross(a,b);if(p&&!sharedEndpoint(p,g.views[i],g.views[j])&&!hits.some(q=>dist(p,q)<.7))hits.push(p);}for(const p of hits)crossings.push({edges:[g.views[j].edge.id,g.views[i].edge.id],point:p});}return {crossings:crossings.length,details:crossings};}
module.exports={paths,flat,inspect,segs,cross,dist};
