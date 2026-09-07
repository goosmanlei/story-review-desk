import {createHash} from 'node:crypto';
const list=value=>Array.isArray(value)?value:[];
const unique=(rows,id)=>rows.filter(row=>row.id===id).length===1;
const text=value=>typeof value==='string'&&value.trim()?value.trim():'UNKNOWN';

/** Read-only facts and image associations, derived exclusively from registered identities. */
export function readingProjection(snapshot,graph,configuration,live={}){
 const base=snapshot.productionModel||{};
 // Keep ambiguous source identities ambiguous; an overlay must not deduplicate them.
 const merge=(rows,projection,version=false)=>[...list(rows).map(row=>{
  const overlay=projection?.[row.id]||{};
  const identityConflict=version&&['familyId','path','sha256'].some(key=>row[key]&&overlay[key]&&(key==='sha256'?row[key].toLowerCase()!==overlay[key].toLowerCase():row[key]!==overlay[key]));
  return {...row,...overlay,id:row.id,...(identityConflict?{outputState:'IDENTITY_CONFLICT'}:{})};
 }),...Object.entries(projection||{}).filter(([id])=>!list(rows).some(row=>row.id===id)).map(([id,row])=>({...row,id}))];
 const model={...base,assetFamilies:merge(base.assetFamilies,live.assetFamiliesById),assetVersions:merge(base.assetVersions,live.assetVersionsById,true)};
 const entities=graph.entities,requirements=list(model.materialRequirements).filter(row=>row.requirementClass==='REQUIRED');
 const relations=graph.relations.filter(row=>!row.historicalOnly&&row.from.kind==='ENTITY'&&row.to.kind==='ENTITY'&&unique(graph.relations,row.id)&&unique(entities,row.from.id)&&unique(entities,row.to.id));
 const businessFacts=Object.fromEntries(entities.map(entity=>{
  const reps=graph.representations.filter(row=>row.entityId===entity.id&&unique(graph.representations,row.id)),repIds=new Set(reps.map(row=>row.id));
  const requirementIds=new Set([...reps.flatMap(row=>row.requirementIds),...graph.requirements.filter(row=>repIds.has(row.representationId)).map(row=>row.id)]);
  const demands=requirements.filter(row=>(row.entityRef===entity.id||repIds.has(row.representationRef)||requirementIds.has(row.id))&&unique(requirements,row.id));
  return [entity.id,{entityId:entity.id,type:entity.type,summary:text(entity.description),aliases:[...new Set(entity.aliases.filter(alias=>alias!==entity.name&&alias!==entity.id))],stateCount:graph.states.filter(row=>row.entityId===entity.id).length,representationCount:reps.length,requirementCount:demands.length,mediaCounts:Object.fromEntries(['IMAGE','AUDIO','VIDEO','TEXT'].map(type=>[type,demands.filter(row=>(row.mediaType||row.mediaKind)===type).length])),relations:relations.filter(row=>row.from.id===entity.id||row.to.id===entity.id).map(row=>{const id=row.from.id===entity.id?row.to.id:row.from.id;return {id:row.id,label:row.label,entityId:id,name:entities.find(other=>other.id===id).name,status:row.status,authority:row.authority,type:row.type};}),members:relations.filter(row=>row.type==='PART_OF'&&row.to.id===entity.id&&row.status==='CONFIRMED').map(row=>({id:row.from.id,name:entities.find(other=>other.id===row.from.id).name}))}];
 }));
 const versions=model.assetVersions,families=model.assetFamilies;
 const eligible=(version,family)=>unique(versions,version.id)&&version.familyId===family.id&&list(family.versionRefs).includes(version.id)&&version.outputState==='PRESENT'&&typeof version.path==='string'&&/\.(png|jpe?g|webp)$/i.test(version.path)&&/^[a-f0-9]{64}$/i.test(version.sha256||'')&&!version.mediaRetirement&&!['EVIDENCE_ONLY','DELETED_AUDIT','DO_NOT_USE','SUPERSEDED'].includes(version.historyRole||'')&&!['DO_NOT_USE','EVIDENCE_ONLY','DELETED'].includes(version.lifecycleState||'');
 const locationVisuals=Object.fromEntries(entities.filter(entity=>entity.type==='LOCATION').map(entity=>{
  const composites=relations.filter(row=>row.type==='PART_OF'&&row.from.id===entity.id&&row.status==='CONFIRMED'&&entities.find(other=>other.id===row.to.id)?.type==='GROUP');
  const ownerIds=new Set([entity.id,...composites.map(row=>row.to.id)]);
  const cards=graph.representations.filter(row=>ownerIds.has(row.entityId)&&unique(graph.representations,row.id)&&configuration.representationTypes.find(type=>type.id===row.type)?.mediaType==='IMAGE').flatMap(rep=>{
   const state=rep.stateId?graph.states.find(row=>row.id===rep.stateId&&row.entityId===rep.entityId&&unique(graph.states,row.id)):null;
   const base={entityId:entity.id,representationId:rep.id,stateId:state?.id||null,type:rep.type,label:rep.label,dimensions:{...(state?.dimensions||{}),...rep.dimensions},authority:rep.authority,association:rep.entityId===entity.id?'DIRECT':'COMPOSITE_MEMBER',compositeName:rep.entityId===entity.id?null:entities.find(other=>other.id===rep.entityId)?.name||null};
   const matched=families.filter(family=>rep.assetFamilyIds.includes(family.id)&&unique(families,family.id));
   if(!matched.length)return [{...base,familyId:null,version:null}];
   return matched.map(family=>{
    const candidates=versions.filter(version=>eligible(version,family));
    const version=candidates.find(version=>version.id===family.currentVersionId)||[...list(family.versionRefs)].reverse().map(id=>candidates.find(version=>version.id===id)).find(Boolean);
    return {...base,familyId:family.id,version:version?{id:version.id,familyId:family.id,path:version.path,sha256:version.sha256,lifecycleState:version.lifecycleState||'UNKNOWN',outputState:'PRESENT',previewUrl:version.preview||null,imageUrl:'/api/v8/media/m_'+createHash('sha256').update(version.id).digest('base64url').slice(0,28)}:null};
   });
  });
  return [entity.id,cards];
 }));
 return {businessFacts,locationVisuals};
}
