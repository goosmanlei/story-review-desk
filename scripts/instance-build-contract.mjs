const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function canonicalHostingConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['project_id','id','d1','r2'].includes(key)))throw Error('Unexpected hosting fields');
 const projectId=value.project_id||value.id;
 if(typeof projectId!=='string'||!/^appgprj_[A-Za-z0-9]+$/.test(projectId)||value.project_id&&value.id&&value.project_id!==value.id)throw Error('Hosting project identity differs');
 for(const key of ['d1','r2'])if(value[key]!=null&&(typeof value[key]!=='string'||!/^[$A-Za-z_][$A-Za-z0-9_]*$/.test(value[key])))throw Error('Invalid hosting binding '+key);
 return {project_id:projectId,...('d1'in value?{d1:value.d1}:{}),...('r2'in value?{r2:value.r2}:{})};
}
export function assertProjectBuildRevision(expected,actual,dirty){
 if(!commit(expected)||actual!==expected||typeof dirty!=='string'||dirty.trim())throw Error('Build source must be the exact clean project commit');
 return expected;
}
export function assertHostedPublicationIdentity(remoteVersion,publicProof,expected){
 if(!commit(expected.projectCommit)||!commit(expected.coreCommit)||!sha(expected.exportManifestSha256)||typeof expected.snapshotId!=='string'||typeof expected.siteId!=='string')throw Error('Exact expected deployment binding required');
 if(remoteVersion?.source?.commit_sha!==expected.projectCommit)throw Error('Sites source.commit_sha differs');
 if(publicProof?.kind!=='PROJECT_READ_ONLY_BUILD'||publicProof.canWrite!==false||['projectCommit','coreCommit','exportManifestSha256','snapshotId','siteId'].some(key=>publicProof[key]!==expected[key]))throw Error('Served artifact differs from the expected core/project/export');
 return {state:'SOURCE_AND_ARTIFACT_IDENTITY_MATCH',deploymentReadiness:'VERIFY_SEPARATELY_WITH_SITES_VERSION_STATE'};
}
