import {criteriaForReviewScope} from '../../web/presentation/review-criteria.mjs';
import {hash} from '../shared/contracts.mjs';
export function productionReviewSpec(output,scene,shot,configuration){
 const context={episode:{reviewQuestion:{class:'U',text:'本集审阅问题尚未绑定，保持 UNKNOWN'}},scopeType:output.scopeType,scopeId:output.scopeId,shot:{purpose:{class:shot?.content.narrativeBeat?'A':'U',text:shot?.content.narrativeBeat||'UNKNOWN'},storyEvent:{class:'A',text:shot?.content.actionIntent||'UNKNOWN'},mustShow:[],mustNotImply:[]},scene:{route:'UNKNOWN',keyPropsAndState:'UNKNOWN',continuity:'UNKNOWN',primaryLocation:scene.revision.content.slugline?.place||'UNKNOWN'},sequence:{structuralRole:{text:'UNKNOWN'},title:{text:'UNKNOWN'}},neighbours:{next:{id:'UNKNOWN',title:'UNKNOWN'}},judgment:{purpose:{text:scene.revision.content.purpose||'UNKNOWN'},audienceTakeaway:{text:scene.revision.content.audienceKnown||'UNKNOWN'}}};
 const configured=configuration.reviewProfiles.filter(p=>p.subjectKind==='WORK_PRODUCT'&&(p.deliverableKey===output.deliverableKey||p.id===output.deliverableKey));
 const criteria=(configured.length===1?configured[0].criteria:criteriaForReviewScope(output,context,context)).map(c=>({...c,required:c.required!==false,allowNA:c.allowNA===true,noteRequiredOnFail:true}));
 const spec={id:'production:'+output.deliverableKey,label:output.label+'验收',subjectKind:'WORK_PRODUCT',criteria};return {...spec,hash:hash(spec)};
}
