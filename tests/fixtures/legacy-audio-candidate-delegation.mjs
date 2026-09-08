import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonicalJson,sha256} from '../../host/instance-runtime/bytes.mjs';
import {registeredMaterialCandidateProof,registeredCandidateSupport} from '../../host/instance-registered-material-candidates.mjs';
export async function exerciseLegacyAudioDelegation(input,proof,{mediaRoot,mutate}={}){
 const root=await mkdtemp(path.join(tmpdir(),'legacy-audio-delegation-'));
 try{
  const x={...input,compiler:{snapshotBuilderPath:'scripts/build_review_site_data.py',snapshotPath:'generated/snapshot.json',eventDirectory:'events'},documents:[...input.documents]};
  const parent=input.events.find(e=>e.eventKind==='asset-version'&&e.versionId===proof.records[0].parentVersionId),model=JSON.parse(input.baseRelease.snapshotBytes).productionModel,work=model.materialWorkItems.find(w=>w.outputAssetRef===parent.familyId);
  const docs=[['scripts/build_review_site_data.py',await readFile(new URL('./registered-material-candidates/builder-family.py',import.meta.url)),'INSTANCE_EXTENSION'],['scripts/asset_cleanup_contract.py',await readFile(new URL('./registered-material-candidates/asset_cleanup_contract.py',import.meta.url)),'INSTANCE_EXTENSION'],['production/00_control/registries/material_requirements.json',canonicalJson({schema_version:'1.1',requirements:[{requirement_id:work.requirementRef,asset_family_refs:[parent.familyId]}]}),'SOURCE_CURRENT']];
  for(const[alias,bytes,role]of docs)x.documents.push({documentId:'fixture:'+alias,revisionId:'fixture-revision:'+sha256(bytes),aliases:[alias],sha256:sha256(bytes),bytes,metadata:{sourceRole:role}});
  const registered=registeredMaterialCandidateProof(x);
  if(registered.records.length!==1||registered.records[0].versionId!==parent.versionId)throw Error('LA exact selector did not conserve the ordinary legacy parent');
  const write=async(alias,bytes)=>{await mkdir(path.dirname(path.join(root,alias)),{recursive:true});await writeFile(path.join(root,alias),bytes);};
  for(const d of x.documents)for(const alias of d.aliases)await write(alias,d.bytes);
  for(const e of x.events)await write('events/'+e.eventKind+'-'+e.idempotencyKeyHash+'.json',canonicalJson(e));
  for(const r of [registered.records[0],...proof.records]){const media=x.activeMedia.find(m=>m.mediaId===r.familyId&&m.versionId===r.versionId);await write(r.path,await readFile(path.join(mediaRoot,media.relativePath)));}
  await mkdir(path.join(root,'generated'),{recursive:true});
  if(mutate)await mutate({root,input:x,proof});
  const payload={registered,proof,parent,docPins:Object.fromEntries(x.documents.flatMap(d=>d.aliases.map(a=>[a,d.sha256]))),mediaPins:x.pinnedMediaHashes};
  const code=String.raw`import ast,json,sys,types
from pathlib import Path
root=Path(sys.argv[1]);p=json.loads(sys.stdin.read());sys.path.insert(0,str(root/'scripts'))
`+registeredCandidateSupport+String.raw`
tree=ast.parse((root/p['registered']['builder']['path']).read_text())
transform,install,finish=prepare_registered_material_candidates(root,tree,p['registered'],p['docPins'],p['mediaPins'],None,{'builder':'scripts/build_review_site_data.py','snapshot':'generated/snapshot.json'},p['proof'])
module=types.ModuleType('builder');module.__file__=str(root/'scripts/build_review_site_data.py');exec(compile(transform(tree),module.__file__,'exec'),module.__dict__);install(module)
import asset_cleanup_contract as cleanup
result=cleanup.registered_material_candidate_paths(json.loads((root/p['registered']['registry']['path']).read_text()),event_store=root/'events',root=root)
assert set(result)=={p['parent']['path']}
model=module.build_production_model(p['parent']);assert model['assetVersions']==[]
(root/'generated/snapshot.json').write_text(json.dumps({'productionModel':model}))
print(json.dumps(finish()))
`;
  return JSON.parse(execFileSync('python3',['-B','-I','-c',code,root],{input:JSON.stringify(payload),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:30000}));
 }finally{await rm(root,{recursive:true,force:true});}
}
