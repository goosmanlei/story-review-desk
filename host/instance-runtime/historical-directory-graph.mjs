import {canonicalJson,sha256} from './bytes.mjs';
import {materialProductionPlanGraphClosure} from './material-production-preservation.mjs';
const hash=value=>sha256(canonicalJson(value)),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const one=(rows,id)=>{const matches=(rows||[]).filter(row=>row?.id===id);return matches.length===1?matches[0]:null;};
function decodeBound(record,ref){
 if(!record||record.deleted||record.revisionId!==ref?.revisionId||record.sha256!==ref?.sha256||sha256(record.bytes)!==record.sha256)return null;
 try{return JSON.parse(Buffer.from(record.bytes).toString('utf8'));}catch{return null;}
}
async function graphAt(tx,ref){
 if(typeof ref?.revisionId!=='string'||!/^[a-f0-9]{64}$/.test(ref?.sha256||''))return null;
 const record=await tx.getAux('domain-graph','current',{revisionId:ref.revisionId}),graph=decodeBound(record,ref);
 return graph&&Array.isArray(graph.representations)&&Array.isArray(graph.requirements)&&hash(graph)===ref.sha256?graph:null;
}
/** Resolve the graph paired with an immutable historical directory, not today's
 * graph. Native V1 plans intentionally preserve directory.graphRef; their exact
 * directory revision plus source bytes is the alternate historical anchor. */
export async function historicalDirectoryGraph(tx,view,record){
 const content=decodeBound(record,record);if(!content)return null;
 const plans=(view.snapshot?.productionModel?.materialProductionPlans||[]).filter(plan=>plan.directoryRevisionId===record.revisionId);
 if(plans.length>1)return null;
 if(!plans.length)return graphAt(tx,content.graphRef);
 const plan=plans[0];
 if(plan.directorySha256!==record.sha256||!view.sourceRevisionIds?.includes(plan.sourceRevisionId))return null;
 const document=await tx.readDocumentRevision(plan.sourceRevisionId);
 // Reuse the existing pure source/plan validator. Do not weaken or rewrite the
 // immutable native-plan contract, nor catch repository/transport failures.
 let body;try{({body}=materialProductionPlanGraphClosure({plan,document}));}catch{return null;}
 if(!same(body.directoryBinding.afterContent,content))return null;
 const binding=body.graphBinding,before=await graphAt(tx,binding.before),after=await graphAt(tx,{revisionId:plan.graphRevisionId,sha256:plan.graphSha256});
 if(!before||!after)return null;
 const previous=one(before.representations,plan.representationId),demand=one(before.requirements,plan.requirementId);
 if(!previous||!demand||!same(previous,binding.beforeRepresentation)||!same(demand,binding.requirement))return null;
 const expected={...before,representations:before.representations.map(row=>row.id===plan.representationId?binding.afterRepresentation:row)};
 return same(after,expected)?after:null;
}
