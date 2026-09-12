// Preserve the original reader contract without changing the stored call definition.
export function presentRecipe(row) {
  const c=row.revision.content,author=c.authorContent||c;
  const prompt=typeof c.prompt==='object'&&c.prompt?c.prompt:{main:author.prompt||'',negative:author.negativePrompt||''};
  const model=typeof c.model==='object'&&c.model?c.model:{branch:author.model||null};
  const items=c.upload?.items||c.inputBindings?.map((i,index)=>({...i,order:index+1,assetFamilyRef:i.familyId,assetVersionRef:i.versionId}))||[];
  return {...c,id:row.id,title:row.title,revisionId:row.revision.id,currentRevisionId:row.revision.id,objectVersion:row.version,
    definitionHash:c.definitionHash||row.revision.sha256,
    upload:{rawText:c.upload?.rawText||'',items:items.map((i,index)=>({...i,order:i.order||index+1,path:i.path||'',sha256:i.sha256||null}))},
    model:{rawRule:'',resolution:'',...model},prompt:{negativeApplication:'',...prompt},
    output:{path:'',mediaType:'UNKNOWN',...c.output},parametersRaw:c.parametersRaw||JSON.stringify(author.parameters||{},null,2),
    declaredGate:c.declaredGate||'INPUT_LOCK_REQUIRED',executorKind:c.executorKind||'MODEL',rawSourceBlock:c.rawSourceBlock||JSON.stringify(c,null,2),
    ...(c.materialSettings?{materialProductionPlanId:'material-production:'+row.id}:{}),
  };
}
