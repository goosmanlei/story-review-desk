// Host-only semantic bridge; all unadapted QA checks still execute.
import { historicalGuidanceSupport } from './instance-historical-guidance.mjs';
import { canonicalJson } from './instance-runtime/index.mjs';
import { requireSource } from './instance-source-proof.mjs';
import { retiredSemanticSupport } from './instance-retired-semantic.mjs';
import { modernEventSemanticSupport } from './instance-modern-event-bridge.mjs';
export function assertSemanticQaAdapterParity(baseline, proposed) {
  requireSource(canonicalJson(baseline ?? null) === canonicalJson(proposed ?? null), 'EXTENSION_SEMANTIC_QA_ADAPTER_DRIFT', 'Independent semantic QA exception bindings or original validation AST changed');
}
export const invokeInstanceSemanticQa = String.raw`"""Host adapter: verify exact published historical excerpts without inventing source files.
argv: QA_SCRIPT PINS_JSON BUILDER_ADAPTER_REPORT SEMANTIC_ADAPTER_REPORT [QA flags...]
"""
import sys, ast, json, hashlib, re, types
${historicalGuidanceSupport}
from pathlib import Path
p=Path(sys.argv[1]).resolve(); pins_path=Path(sys.argv[2]).resolve(); builder_report_path=Path(sys.argv[3]).resolve(); report_path=Path(sys.argv[4]).resolve(); args=sys.argv[5:]
root=Path.cwd().resolve(); sys.path.insert(0,str(p.parent)); sys.argv=[str(p),*args]
pins=json.loads(pins_path.read_text(encoding='utf-8')); document_pins=pins.get('__documentHashes',{}); published=pins.get('__historicalEvidence',{})
read_historical_guidance=make_historical_guidance_reader(root,published,document_pins)
builder_report=json.loads(builder_report_path.read_text(encoding='utf-8')) or {}
builder_evidence={row['ref']:row for row in builder_report.get('historicalEvidence',[])}
tree=ast.parse(p.read_text(encoding='utf-8'),filename=str(p)); evidence_guard=None; verifications={}; expected_objects={}
${modernEventSemanticSupport}
modern_install=None;modern_finish=None;modern_report=None
if pins.get('__modernEvents'):
 guard_modern_event_delegation_ast(tree)
 modern_install,modern_finish=prepare_modern_event_delegation(root,pins['__modernEvents'],published)
class InstanceProofMode(ast.NodeTransformer):
 def visit_Compare(self,node):
  self.generic_visit(node)
  if len(node.ops)==1 and isinstance(node.ops[0],ast.Eq) and len(node.comparators)==1 and isinstance(node.comparators[0],ast.Constant) and node.comparators[0].value=='HOST_FILESYSTEM_AND_FORMAL_RUNTIME_FILES':
   node.ops=[ast.In()];node.comparators=[ast.Tuple(elts=[ast.Constant('HOST_FILESYSTEM_AND_FORMAL_RUNTIME_FILES'),ast.Constant('INSTANCE_SQLITE_RELEASE_AND_SOURCE_RECORDS')],ctx=ast.Load())]
  return node
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='resolve_review_context_reference']
if functions:
 if len(functions)!=1:raise ValueError('semantic historical adapter requires one exact resolver')
 hash_functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='sha256_file']
 loops=[node for node in ast.walk(tree) if isinstance(node,ast.For) and isinstance(node.iter,ast.Name) and node.iter.id=='unique_review_evidence_references']
 if len(hash_functions)!=1 or len(loops)!=1:raise ValueError('semantic historical adapter requires the exact hash function and evidence validation loop')
 loop=loops[0];guarded=[functions[0],hash_functions[0],loop]
 for name in ('PROJECT_ROOT','SCRIPT_SOURCE_PATH','STORY_REWRITE_PATH','CHARACTER_PERFORMANCE_PATH'):
  matches=[node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id==name for target in node.targets)]
  if len(matches)!=1:raise ValueError(f'semantic historical adapter requires exact {name} declaration')
  guarded.append(matches[0])
 evidence_guard=hashlib.sha256('\n'.join(ast.dump(node,include_attributes=False) for node in guarded).encode()).hexdigest()
 expected_resolve=ast.parse('expected = resolve_review_context_reference(ref)').body[0]
 expected_hash=ast.parse('source_hash = sha256_file(source_path)').body[0]
 class ExactEvidenceCalls(ast.NodeTransformer):
  def __init__(self):self.resolve_count=0;self.hash_count=0
  def visit_Assign(self,node):
   if ast.dump(node,include_attributes=False)==ast.dump(expected_resolve,include_attributes=False):
    self.resolve_count+=1;return ast.copy_location(ast.parse('expected = __instance_resolve_historical_evidence(ref, item)').body[0],node)
   if ast.dump(node,include_attributes=False)==ast.dump(expected_hash,include_attributes=False):
    self.hash_count+=1;return ast.copy_location(ast.parse('source_hash = __instance_evidence_expected_hash(ref, expected, item)').body[0],node)
   return self.generic_visit(node)
 transform=ExactEvidenceCalls();transform.visit(loop)
 if transform.resolve_count!=1 or transform.hash_count!=1:raise ValueError('semantic evidence re-resolution/hash validation statements changed')

def relative(value):
 if value.is_symlink():raise ValueError('semantic evidence cannot use symlink sources')
 return value.resolve().relative_to(root).as_posix()
def pinned_document(filename):
 alias=relative(filename);content=filename.read_bytes();digest=hashlib.sha256(content).hexdigest()
 if document_pins.get(alias)!=digest:raise ValueError(f'semantic evidence role document is not release pinned: {alias}')
 return alias,digest,json.loads(content)

"""Proposal helper for the narrow missing-manifest branch of semantic QA.
The host must derive publishedReferences from the same pinned base release as
media/document pins and preserve that evidence in the plan/CAS. No DB access,
manifest synthesis, file writes, hash override, or production-reference adoption.
"""
import ast
import hashlib
import json
import re
from pathlib import Path

REFERENCE_QA_AST_SHA256 = '355c4e0064167a7304a275b220ee0038f9b82a610fbb30b685434d81be406e00'
MANIFEST_ALIAS = 'output/production_maps/production_reference_manifest.v1.json'
BUILDER_ALIAS = 'scripts/build_production_maps.py'
SPEC_ALIAS = 'data/production_map_spec.json'
REGISTRY_ALIAS = 'production/00_control/registries/production_references.v1.json'

def bridge_production_reference_ast(tree):
    """Retain every original check when the original manifest is present."""
    validators = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'validate']
    if len(validators) != 1:
        raise ValueError('Expected exactly one semantic validate function')
    body = validators[0].body
    starts = [i for i, node in enumerate(body) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'production_reference_manifest' for target in node.targets)]
    if len(starts) != 1:
        raise ValueError('Expected exact production-reference manifest QA section')
    start = starts[0]
    old = body[start:start + 4]
    fingerprint = hashlib.sha256('\n'.join(ast.dump(node, include_attributes=False) for node in old).encode()).hexdigest()
    if fingerprint != REFERENCE_QA_AST_SHA256:
        raise ValueError('Production-reference QA section changed; bridge requires review')
    invocation = ast.parse('_verify_preserved_production_refs(qa, family_by_id, version_by_id, EXPECTED_PRODUCTION_REFERENCES, PROJECT_ROOT)').body
    replacement = ast.If(test=ast.parse('PRODUCTION_REFERENCE_MANIFEST_PATH.is_file()', mode='eval').body, body=old, orelse=invocation)
    ast.copy_location(replacement, old[0])
    body[start:start + 4] = [replacement]
    ast.fix_missing_locations(tree)
    return tree

def make_preserved_reference_checker(media_pins, document_pins, published_references, reports):
    """published_references = {releaseId, snapshotSha256, families, versions}.
    Only object/byte preservation is accepted. If source sync changes any of
    these references, this branch must fail until original evidence is restored.
    """
    def require(condition, message):
        if not condition: raise ValueError('Preserved production references: ' + message)
    def stable_hash(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    def sha(value): return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None
    def checker(qa, family_by_id, version_by_id, expected_references, project_root):
        root = Path(project_root).resolve()
        def local(alias):
            path = Path(alias)
            require(not path.is_absolute() and bool(path.parts) and all(part not in ('', '.', '..') for part in path.parts), 'unsafe evidence alias')
            resolved = root
            for part in path.parts:
                resolved = resolved / part
                require(not resolved.is_symlink(), 'symlink evidence is not allowed: ' + alias)
            return resolved
        def actual_hash(alias, expected):
            path = local(alias)
            require(sha(expected) and path.is_file(), 'missing pinned regular evidence: ' + alias)
            result = hashlib.sha256(path.read_bytes()).hexdigest()
            require(result == expected, 'evidence byte hash differs: ' + alias)
            return result
        manifest_path = local(MANIFEST_ALIAS)
        require(not manifest_path.exists(), 'bridge only applies to an absent original manifest')
        require(MANIFEST_ALIAS not in media_pins and MANIFEST_ALIAS not in document_pins, 'pinned original manifest must be materialized and checked normally')
        cache = published_references
        require(isinstance(cache, dict) and cache.get('releaseId') and sha(cache.get('snapshotSha256')), 'missing base-release snapshot anchor')
        families = cache.get('families'); versions = cache.get('versions')
        require(isinstance(families, list) and isinstance(versions, list) and len(families) == len(versions) == len(expected_references) and len(expected_references) > 0, 'exact published pair cardinality required')
        published_families = {item['id']: item for item in families}
        published_versions = {item['id']: item for item in versions}
        require(len(published_families) == len(published_versions) == len(expected_references) and set(published_families) == set(expected_references), 'duplicate/mismatched published identities')
        current_families = {key: item for key, item in family_by_id.items() if item.get('assetRole') == 'PRODUCTION_REFERENCE'}
        current_versions = {key: item for key, item in version_by_id.items() if item.get('assetRole') == 'PRODUCTION_REFERENCE'}
        differences = []
        for kind, current, published in [('family', current_families, published_families), ('version', current_versions, published_versions)]:
            for identity in sorted(set(current) | set(published)):
                if identity not in current or identity not in published:
                    differences.append(kind + ':' + identity + ':identity')
                else:
                    for field in sorted(set(current[identity]) | set(published[identity])):
                        if current[identity].get(field) != published[identity].get(field):
                            differences.append(kind + ':' + identity + ':' + field)
        require(current_families == published_families and current_versions == published_versions, 'all family/version fields must equal the published snapshot; changed fields: ' + ', '.join(differences))
        builder_actual = actual_hash(BUILDER_ALIAS, document_pins.get(BUILDER_ALIAS))
        spec_actual = actual_hash(SPEC_ALIAS, document_pins.get(SPEC_ALIAS))
        registry_actual = actual_hash(REGISTRY_ALIAS, document_pins.get(REGISTRY_ALIAS))
        manifest_hashes = set()
        pair_reports = []
        for family_id, expected_path in expected_references.items():
            family = published_families[family_id]
            version = published_versions.get(family.get('currentVersionId'))
            require(version is not None and version.get('familyId') == family_id, 'exact family/current-version binding required')
            require(family.get('provenance') == version.get('provenance'), 'family and version provenance differ')
            provenance = version.get('provenance') or {}
            require(family.get('kind') == 'REFERENCE' and family.get('subtype') == 'PRODUCTION_REFERENCE' and family.get('lifecycleState') == 'SATISFIED_BY_EXISTING' and family.get('canFlowDownstream') is True, 'published family contract invalid')
            require(version.get('path') == expected_path and version.get('outputState') == 'PRESENT' and version.get('reviewDecision') == 'NOT_APPLICABLE' and version.get('projectRightsGate') == 'NOT_APPLICABLE' and version.get('lifecycleState') == 'SATISFIED_BY_EXISTING' and version.get('canFlowDownstream') is True, 'published version contract invalid')
            require(provenance.get('class') == 'DETERMINISTIC_LOCAL_BUILD' and provenance.get('manifestRef') == MANIFEST_ALIAS and sha(provenance.get('manifestSha256')) and provenance.get('bindingStatus') == 'CURRENT' and not provenance.get('bindingFailures'), 'published provenance contract invalid')
            require(provenance.get('builderRef') == BUILDER_ALIAS and provenance.get('sourceSpecRef') == SPEC_ALIAS and provenance.get('builderSha256') == provenance.get('currentBuilderSha256') == builder_actual and provenance.get('sourceSpecSha256') == provenance.get('currentSourceSpecSha256') == spec_actual, 'builder/spec differs from published provenance')
            output_sha = version.get('sha256')
            require(output_sha == provenance.get('outputSha256') == media_pins.get(expected_path) and sha(output_sha), 'media alias/SHA does not match the exact published version')
            actual = actual_hash(expected_path, output_sha)
            manifest_hashes.add(provenance['manifestSha256'])
            pair_reports.append({'familyId': family_id, 'versionId': version['id'], 'familyCanonicalSha256': stable_hash(family), 'versionCanonicalSha256': stable_hash(version), 'provenanceCanonicalSha256': stable_hash(provenance), 'outputPath': expected_path, 'outputExpectedSha256': output_sha, 'outputActualSha256': actual})
        require(len(manifest_hashes) == 1, 'published manifest expected hashes disagree')
        report = {'mode': 'RELEASE_BOUND_REFERENCE_PARITY', 'releaseId': cache['releaseId'], 'snapshotSha256': cache['snapshotSha256'], 'manifestPath': MANIFEST_ALIAS, 'manifestState': 'MISSING', 'manifestExpectedSha256': next(iter(manifest_hashes)), 'manifestActualSha256': None, 'manifestFullContentVerified': False, 'historicalMapBuildRevalidated': False, 'publishedObjectsUnchanged': True, 'builderActualSha256': builder_actual, 'specActualSha256': spec_actual, 'registryActualSha256': registry_actual, 'pairs': sorted(pair_reports, key=lambda row: row['familyId'])}
        reports.append(report)
        qa.warn(False, 'Production-reference manifest is MISSING; published objects and current evidence bytes are preserved, historical map build was not revalidated')
    return checker

published_references=pins.get('__productionReferences',{})
reference_reports=[]
reference_bridge_active=bool(published_references.get('families')) and not (root/MANIFEST_ALIAS).exists()
if reference_bridge_active:tree=bridge_production_reference_ast(tree)


${retiredSemanticSupport}
retired_evidence=pins.get('__retiredProductionEvidence') or {}
retired_reports=[]
retired_install=None
if retired_evidence.get('media'):
 retired_row,retired_generated,retired_install=make_retired_semantic_checker(root,retired_evidence,pins,retired_reports)
 tree=bridge_retired_semantic_ast(tree)
 if not functions:raise ValueError('retired semantic QA requires the exact normal module/main bridge')

module=types.ModuleType('instance_semantic_qa');module.__file__=str(p);sys.modules[module.__name__]=module
if functions:
 expected_entry=ast.parse('if __name__ == "__main__":\n sys.exit(main())').body[0]
 if ast.dump(tree.body[-1],include_attributes=False)!=ast.dump(expected_entry,include_attributes=False):raise ValueError('semantic adapter requires the exact normal main entry point')
 tree=ast.fix_missing_locations(InstanceProofMode().visit(tree));exec(compile(tree,str(p),'exec'),module.__dict__)
 def resolve_evidence(ref,item):
  guidance=read_historical_guidance(ref)
  if guidance is not None:
   cached,proof=guidance
   if item!=cached or builder_evidence.get(ref)!=proof:raise ValueError('Independent historical guidance object/proof differs')
   expected={key:cached[key] for key in ('path','sourceKind','locator','excerpt','lineStart','lineEnd')};expected['sourcePath']=root/cached['path']
   expected_objects[id(expected)]=(expected,ref,proof,cached);return expected
  cached=(published.get('catalog') or {}).get(ref)
  if not isinstance(cached,dict) or not isinstance(cached.get('path'),str) or (root/cached['path']).exists():return module.resolve_review_context_reference(ref)
  alias=relative(root/cached['path']);bindings=published.get('priorBindings') or {};declared=bindings.get('storyRewrite')
  if not isinstance(declared,dict) or declared!=bindings.get('characterPerformance') or declared.get('role')!='EVIDENCE_ONLY' or declared.get('path')!=alias or declared.get('sha256')!=cached.get('sourceSha256'):return module.resolve_review_context_reference(ref)
  if alias==relative(module.SCRIPT_SOURCE_PATH) or alias in document_pins or alias in pins:raise ValueError('current evidence source cannot use historical cache')
  rewrite_alias,rewrite_sha,rewrite=pinned_document(module.STORY_REWRITE_PATH);performance_alias,performance_sha,performance=pinned_document(module.CHARACTER_PERFORMANCE_PATH)
  if rewrite.get('prior_script_evidence')!=declared or performance.get('prior_script_evidence')!=declared:raise ValueError('semantic historical role/source binding changed')
  matched=re.fullmatch(r'(.+\.md):(\d+)(?:-(\d+))?',ref)
  if not matched or matched.group(1)!=alias or cached.get('ref')!=ref or cached.get('sourceKind')!='MARKDOWN_LINE':raise ValueError('semantic cache ref does not match its exact historical range')
  start=int(matched.group(2));end=int(matched.group(3) or matched.group(2));excerpt=cached.get('excerpt')
  if start<1 or end<start or cached.get('lineStart')!=start or cached.get('lineEnd')!=end or not isinstance(excerpt,str) or not excerpt.strip() or len(excerpt.split('\n'))!=end-start+1 or hashlib.sha256(excerpt.encode()).hexdigest()!=cached.get('excerptSha256'):raise ValueError('semantic cache excerpt range/hash differs')
  if not re.fullmatch(r'[a-f0-9]{64}',str(cached.get('sourceSha256') or '')) or not re.fullmatch(r'[a-f0-9]{64}',str(published.get('snapshotSha256') or '')) or not published.get('releaseId'):raise ValueError('semantic cache release/source digest is invalid')
  if item!=cached:raise ValueError('generated historical evidence is not the complete exact published cache record')
  proof={'ref':ref,'sourcePath':alias,'sourceState':'MISSING','sourceExpectedSha256':cached['sourceSha256'],'sourceActualSha256':None,'excerptSha256':cached['excerptSha256'],'cacheRecordSha256':hashlib.sha256(json.dumps(cached,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'lineStart':start,'lineEnd':end,'historyRole':'EVIDENCE_ONLY','cacheReleaseId':published['releaseId'],'cacheSnapshotSha256':published['snapshotSha256'],'storyRewritePath':rewrite_alias,'storyRewriteSha256':rewrite_sha,'characterPerformancePath':performance_alias,'characterPerformanceSha256':performance_sha,'mode':'REUSE_EXACT_PUBLISHED_HISTORICAL_EXCERPT_ONLY'}
  if builder_evidence.get(ref)!=proof:raise ValueError('semantic and builder historical evidence proofs differ')
  expected={key:cached[key] for key in ('path','sourceKind','locator','excerpt','lineStart','lineEnd')};expected['sourcePath']=root/alias
  expected_objects[id(expected)]=(expected,ref,proof,cached);return expected
 def expected_source_hash(ref,expected,item):
  bound=expected_objects.get(id(expected))
  if bound is None:return module.sha256_file(expected['sourcePath'])
  bound_object,bound_ref,proof,cached=bound
  if bound_object is not expected:raise ValueError('semantic expected object identity changed')
  if proof.get('mode')=='REUSE_EXACT_PUBLISHED_GUIDANCE_EXCERPT_ONLY':
   checked=read_historical_guidance(ref)
   if bound_ref!=ref or item!=cached or checked is None or checked[0]!=cached or checked[1]!=proof:raise ValueError('Current guidance or original historical excerpt changed during semantic verification')
   verifications[ref]=proof
   return proof['sourceExpectedSha256']
  if bound_ref!=ref or item!=cached or expected['sourcePath'].exists():raise ValueError('historical evidence changed during independent semantic validation')
  verifications[ref]=proof
  # This value is an independently checked published expectation, never an actual missing-file digest.
  return proof['sourceExpectedSha256']
 module.__instance_resolve_historical_evidence=resolve_evidence;module.__instance_evidence_expected_hash=expected_source_hash
 if reference_bridge_active:module._verify_preserved_production_refs=make_preserved_reference_checker(pins,document_pins,published_references,reference_reports)
 if retired_install:retired_install(module)
 if modern_install:modern_install(module)
 exit_code=module.main()
 if modern_finish:modern_report=modern_finish()
 if set(verifications)!=set(builder_evidence):raise ValueError('semantic QA did not independently verify every and only builder-reused historical excerpt')
 if reference_reports:
  if len(reference_reports)!=1 or (builder_report.get('productionReferences') or {}).get('report')!=reference_reports[0]:raise ValueError('semantic and builder production-reference preservation proofs differ')
 elif builder_report.get('productionReferences'):raise ValueError('semantic QA did not independently verify builder-preserved production references')
else:
 tree=ast.fix_missing_locations(InstanceProofMode().visit(tree));exec(compile(tree,str(p),'exec'),{'__name__':'__main__','__file__':str(p)})
 exit_code=0
if any(row.get('mode')!='REUSE_EXACT_PUBLISHED_GUIDANCE_EXCERPT_ONLY' and (root/row['sourcePath']).exists() for row in verifications.values()):raise ValueError('semantic adapter must not create historical full sources')
report={'adapterVersion':'INSTANCE_SEMANTIC_RELEASE_BOUND_EVIDENCE_1.0','historicalEvidence':{'guardAstSha256':evidence_guard,'verifications':[verifications[ref] for ref in sorted(verifications)]} if verifications else None,'productionReferences':{'guardAstSha256':REFERENCE_QA_AST_SHA256,'reports':reference_reports} if reference_reports else None} if verifications or reference_reports else None
if retired_install:
 if sorted(builder_report.get('retiredProduction') or [],key=lambda row:(row['kind'],row['id']))!=retired_reports:raise ValueError('semantic and builder retired production metadata proofs differ')
 report=report or {'adapterVersion':'INSTANCE_SEMANTIC_RELEASE_BOUND_EVIDENCE_1.0','historicalEvidence':None,'productionReferences':None}
 report['retiredProduction']={'guardAstSha256':RETIRED_QA_AST_GUARDS,'releaseId':retired_evidence['releaseId'],'snapshotSha256':retired_evidence['snapshotSha256'],'recipesSha256':retired_evidence['recipesSha256'],'verifications':retired_reports}
elif builder_report.get('retiredProduction'):raise ValueError('builder retired production evidence was not independently verified')
if modern_finish:
 if modern_report is None:raise ValueError('modern immutable event validation did not finish')
 report=report or {'adapterVersion':'INSTANCE_SEMANTIC_RELEASE_BOUND_EVIDENCE_1.0','historicalEvidence':None,'productionReferences':None}
 report['modernEvents']=modern_report
report_path.write_text(json.dumps(report,sort_keys=True,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
if exit_code:raise SystemExit(exit_code)
`;
