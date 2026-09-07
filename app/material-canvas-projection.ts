import type {DomainGraph,DomainRepresentation,DomainState} from '../host/instance-runtime/domain-model.mjs';

export type MaterialCanvasRow={id:string;entityId:string;stateId:string;representationId?:string;required:boolean;title:string};
export type MaterialAttribute={name:string;value:string;sourceKind:'STATE'|'REPRESENTATION';sourceId:string;directoryOnly:boolean};
export type MaterialStateSource=DomainState&{directoryOnly?:boolean;appliesTo?:string};
export type MaterialReferenceEdge={id:string;from:string;to:string;label:string;directed:boolean;uncertain:boolean;relationId:string;sourceRepresentationId:string;targetRepresentationId:string;mode:'REGISTERED_REFERENCE_DEFINITION'};

/** Resolve only an explicit, unique requirement binding. Shared families are not identity. */
export function exactMaterialRepresentation(graph:DomainGraph,requirementId:string,boundRepresentationId?:string):DomainRepresentation|undefined{
 const matches=graph.representations.filter(row=>row.requirementIds.includes(requirementId));
 if(matches.length!==1||boundRepresentationId&&matches[0].id!==boundRepresentationId)return undefined;
 return matches[0];
}

/** These are source-preserving presentation attributes, not new domain records. */
export function materialAttributes(graph:DomainGraph,row:MaterialCanvasRow,sourceGraph?:DomainGraph):{attributes:MaterialAttribute[];sourceStates:MaterialStateSource[];representation?:DomainRepresentation}{
 const representation=row.required?exactMaterialRepresentation(graph,row.id,row.representationId):undefined;
 const states=graph.states.filter(state=>state.id===row.stateId&&state.entityId===row.entityId) as MaterialStateSource[];
 const sourceStates=states.length===1?[structuredClone(states[0])]:[];
 const originalRepresentation=sourceGraph&&row.required?exactMaterialRepresentation(sourceGraph,row.id,row.representationId):undefined;
 if(originalRepresentation?.stateId){const originalStates=sourceGraph!.states.filter(state=>state.id===originalRepresentation.stateId&&state.entityId===originalRepresentation.entityId);if(originalStates.length===1&&!sourceStates.some(state=>state.id===originalStates[0].id))sourceStates.push(structuredClone(originalStates[0]));}
 const attributes:MaterialAttribute[]=sourceStates.flatMap(state=>Object.entries(state.dimensions).map(([name,value])=>({name,value,sourceKind:'STATE' as const,sourceId:state.id,directoryOnly:state.directoryOnly===true||state.appliesTo==='DIRECTORY_METADATA_ONLY'})));
 if(representation&&representation.entityId===row.entityId)attributes.push(...Object.entries(representation.dimensions).map(([name,value])=>({name,value,sourceKind:'REPRESENTATION' as const,sourceId:representation.id,directoryOnly:false})));
 return {attributes,sourceStates,representation};
}

/** Both endpoints must be exact visible REQUIRED materials. No STATE expansion,
 * fuzzy IDs, family-based Cartesian products or inferred executed derivation. */
export function materialReferenceEdges(graph:DomainGraph,rows:MaterialCanvasRow[],referenceTypeIds:readonly string[]):MaterialReferenceEdge[]{
 const ids=new Set(rows.map(row=>row.id)),uniqueRows=rows.filter(row=>rows.filter(other=>other.id===row.id).length===1&&row.required);
 const byRepresentation=new Map<string,MaterialCanvasRow[]>();
 for(const row of uniqueRows){const representation=exactMaterialRepresentation(graph,row.id,row.representationId);if(!representation||representation.entityId!==row.entityId)continue;byRepresentation.set(representation.id,[...(byRepresentation.get(representation.id)||[]),row]);}
 return graph.relations.flatMap(relation=>{
  if(relation.historicalOnly||relation.from.kind!=='REPRESENTATION'||relation.to.kind!=='REPRESENTATION'||!referenceTypeIds.includes(relation.type))return [];
  if(graph.relations.filter(row=>row.id===relation.id).length!==1)return [];
  const from=byRepresentation.get(relation.from.id)||[],to=byRepresentation.get(relation.to.id)||[];
  if(from.length!==1||to.length!==1||from[0].id===to[0].id||!ids.has(from[0].id)||!ids.has(to[0].id))return [];
  return [{id:relation.id,from:'material:'+from[0].id,to:'material:'+to[0].id,label:relation.label+' · 参考定义',directed:true,uncertain:relation.status!=='CONFIRMED',relationId:relation.id,sourceRepresentationId:relation.from.id,targetRepresentationId:relation.to.id,mode:'REGISTERED_REFERENCE_DEFINITION' as const}];
 });
}

export type MaterialImageVersion={id:string;familyId:string;path:string|null;sha256:string|null;outputState?:string|null;historyRole?:string|null;lifecycleState?:string|null;mediaRetirement?:{state?:string}|null};
/** Reading columns follow registered reference arrows, never state order or titles.
 * Cyclic/ambiguous residues keep level zero instead of inventing a production order. */
export function materialReferenceLevels(rows:MaterialCanvasRow[],edges:MaterialReferenceEdge[]):Record<string,number>{
 const ids=[...new Set(rows.map(row=>'material:'+row.id))],known=new Set(ids),degree=new Map(ids.map(id=>[id,0])),next=new Map(ids.map(id=>[id,[] as string[]]));
 for(const edge of edges)if(known.has(edge.from)&&known.has(edge.to)){degree.set(edge.to,degree.get(edge.to)!+1);next.get(edge.from)!.push(edge.to);}
 const queue=ids.filter(id=>degree.get(id)===0),levels:Record<string,number>={},seen=new Set<string>();
 for(const id of queue){seen.add(id);levels[id]??=0;for(const to of next.get(id)!){levels[to]=Math.max(levels[to]||0,levels[id]+1);degree.set(to,degree.get(to)!-1);if(degree.get(to)===0)queue.push(to);}}
 for(const id of ids)if(!seen.has(id))levels[id]=0;
 return levels;
}

type ThumbnailFamily={id:string;currentVersionId:string|null;versionRefs:string[]};
/** Representative image only: selection never adopts a version or proves review. */
export function materialRepresentativeImage<T extends MaterialImageVersion>(model:{assetFamilies:ThumbnailFamily[];assetVersions:T[]}|undefined,familyIds:readonly string[]):T|undefined{
 if(!model)return undefined;
 const families=model.assetFamilies.filter(family=>familyIds.includes(family.id)&&model.assetFamilies.filter(row=>row.id===family.id).length===1);
 const eligible=(version:T,family:ThumbnailFamily)=>version.familyId===family.id&&family.versionRefs.includes(version.id)&&model.assetVersions.filter(row=>row.id===version.id).length===1&&version.outputState==='PRESENT'&&typeof version.path==='string'&&/\.(png|jpe?g|webp)$/i.test(version.path)&&typeof version.sha256==='string'&&/^[a-f0-9]{64}$/.test(version.sha256)&&!version.mediaRetirement&& !['EVIDENCE_ONLY','DELETED_AUDIT','DO_NOT_USE','SUPERSEDED'].includes(version.historyRole||'')&&!['DO_NOT_USE','EVIDENCE_ONLY','DELETED'].includes(version.lifecycleState||'');
 const current=families.flatMap(family=>model.assetVersions.filter(version=>version.id===family.currentVersionId&&eligible(version,family)));
 if(current.length)return current[0];
 for(const family of families)for(const id of [...family.versionRefs].reverse()){const version=model.assetVersions.find(row=>row.id===id);if(version&&eligible(version,family))return version;}
 return undefined;
}
