/* The bundled renderer runs off the UI thread, with no remote resources. */
importScripts('vendor/viz-3.31.0.js','entity-graph-routing.js');
const renderer=Viz.instance();
self.onmessage=async ({data:{id,nodes,edges}})=>{
  try{const geometry=EntityGraphRouting.layout(await renderer,nodes,edges);self.postMessage({id,geometry});}
  catch(error){self.postMessage({id,error:error.message||'关系图计算失败'});}
};
