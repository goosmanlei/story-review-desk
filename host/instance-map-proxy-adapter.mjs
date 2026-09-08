import { registeredCandidateSupport } from './instance-registered-material-candidates.mjs';
import { retiredContactSupport } from './instance-retired-contact.mjs';
import { historicalGuidanceSupport } from './instance-historical-guidance.mjs';
import { retiredProductionSupport } from './instance-retired-production.mjs';
// Host-only cache materialization adapter; it never changes the pinned Python document.
import { canonicalJson } from './instance-runtime/index.mjs';
import { requireSource } from './instance-source-proof.mjs';
export function assertMapProxyAdapterParity(baseline, proposed) {
  requireSource(canonicalJson(baseline ?? null) === canonicalJson(proposed ?? null), 'EXTENSION_MAP_PROXY_ADAPTER_DRIFT', 'Published evidence reuse changed its source mapping, original function AST or exact release binding');
}
export const referenceProjectionSupport = String.raw`
def preserve_reference_domain_context(model, published_references):
    # This field belongs to the confirmed relationship projection, not the
    # legacy story compiler. Restore only an absent exact published field.
    prior = {row['id']: row for row in published_references['families']}
    references = [row for row in model['assetFamilies'] if row.get('assetRole') == 'PRODUCTION_REFERENCE']
    current = {row['id']: row for row in references}
    if len(prior) != len(published_references['families']) or len(current) != len(references):
        raise ValueError('Duplicate production-reference identities in domain projection')
    if set(current) != set(prior):
        raise ValueError('Production-reference identities changed before domain projection preservation')
    for identity, row in current.items():
        expected = prior[identity]
        if 'domainContext' in row:
            if row != expected:
                raise ValueError('Production-reference existing domain context or metadata changed: ' + identity)
            continue
        without_context = {key: value for key, value in expected.items() if key != 'domainContext'}
        if row != without_context:
            raise ValueError('Production-reference compiler-owned metadata changed: ' + identity)
        if 'domainContext' in expected:
            row['domainContext'] = json.loads(json.dumps(expected['domainContext']))
    return model
`;
export const invokePinnedMapProxyReuse = String.raw`"""Host wrapper only; never save transformed instance source bytes.
argv: BUILDER PROXY_PINS_JSON ADAPTER_REPORT_JSON [ordinary builder arguments...]
PROXY_PINS_JSON is produced by Node from checked media, published documents and the pinned release.
"""
import ast
import hashlib
import json
import re
import runpy
import subprocess
import sys
import types
from pathlib import Path

p = Path(sys.argv[1]).resolve()
pins_path = Path(sys.argv[2]).resolve()
report_path = Path(sys.argv[3]).resolve()
builder_args = sys.argv[4:]
root = Path.cwd().resolve()
source = p.read_text(encoding="utf-8")
tree = ast.parse(source, filename=str(p))
sys.path.insert(0, str(p.parent))
sys.argv = [str(p), *builder_args]
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_map_proxies"]
${retiredContactSupport}
${historicalGuidanceSupport}
${retiredProductionSupport}
${referenceProjectionSupport}
${registeredCandidateSupport}

# No adaptation for compiler fixtures/extensions that have no map cache builder.
if not functions:
    runpy.run_path(str(p), run_name="__main__")
    report = None
else:
    if len(functions) != 1:
        raise ValueError("map proxy adapter requires one exact cache builder")
    expected_entry = ast.parse('if __name__ == "__main__":\n    main()').body[0]
    if ast.dump(tree.body[-1], include_attributes=False) != ast.dump(expected_entry, include_attributes=False):
        raise ValueError("map proxy adapter requires the exact normal main entry point")
    guarded = [functions[0], tree.body[-1]]
    for name in ("MAP_PROXY_SOURCES", "ROOT", "SITE_ROOT"):
        nodes = [node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
        if len(nodes) != 1:
            raise ValueError(f"map proxy adapter requires one exact {name} declaration")
        guarded.append(nodes[0])
    ast_sha = hashlib.sha256("\n".join(ast.dump(node, include_attributes=False) for node in guarded).encode()).hexdigest()
    cache_functions = []
    for name in ("build_visual_proxy", "build_width_proxy", "build_audio_proxy", "build_map_proxies"):
        matches = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name]
        if len(matches) > 1:
            raise ValueError(f"proxy cache requires at most one exact {name} function")
        cache_functions.extend(matches)
    cache_guard_sha = hashlib.sha256("\n".join(ast.dump(node, include_attributes=False) for node in cache_functions).encode()).hexdigest()
    pins = json.loads(pins_path.read_text(encoding="utf-8"))
    document_pins = pins.pop("__documentHashes", {})
    published_evidence = pins.pop("__historicalEvidence", {})
    published_references = pins.pop("__productionReferences", {})
    retired_contact_evidence = pins.pop("__retiredContactEvidence", {})
    retired_production_evidence = pins.pop("__retiredProductionEvidence", {})
    registered_candidate_proof = pins.pop('__registeredMaterialCandidates', None)
    native_candidate_proof = pins.pop('__nativeMaterialCandidates', None)
    candidate_snapshot_path = pins.pop('__candidateSnapshotPath', None)
    registered_transform, registered_install, registered_finish = prepare_registered_material_candidates(root, tree, registered_candidate_proof, document_pins, pins, native_candidate_proof, {'builder':p.relative_to(root).as_posix(),'snapshot':candidate_snapshot_path})
    retired_production_reports = []
    projection_function = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main']
    projection_guard_sha = hashlib.sha256(ast.dump(projection_function[0], include_attributes=False).encode()).hexdigest() if len(projection_function) == 1 else None
    transform_retired_production, install_retired_production = make_retired_production_support(root, retired_production_evidence, document_pins, retired_production_reports)
    tree = transform_retired_production(tree)
    tree = registered_transform(tree)
    retired_contact_reports = []
    retired_contact_metadata = {}
    retired_contact_proof, build_retired_contact = make_retired_contact_support(root, retired_contact_evidence, retired_contact_reports)
    reference_reports = []
    reference_resolved_paths = set()
    historical_evidence_reports = {}
    read_historical_guidance = make_historical_guidance_reader(root, published_evidence, document_pins)
    contact_reports = []
    contact_guard_sha = None
    contact_functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_p07_storyboards"]
    if contact_functions:
        if len(contact_functions) != 1:
            raise ValueError("historical contact adapter requires one exact storyboard builder")
        contact_function = contact_functions[0]
        width_functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_width_proxy"]
        if len(width_functions) != 1:
            raise ValueError("historical contact adapter requires one exact width proxy builder")
        contact_guarded = [contact_function, width_functions[0]]
        for name in ("P07_QA_REPORT", "STORY_REWRITE", "P07_CONTACT_PROXY_ROOT"):
            nodes = [node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
            if len(nodes) != 1:
                raise ValueError(f"historical contact adapter requires exact {name} declaration")
            contact_guarded.append(nodes[0])
        contact_guard_sha = hashlib.sha256("\n".join(ast.dump(node, include_attributes=False) for node in contact_guarded).encode()).hexdigest()
        expected_iter = ast.parse('qa_report["contact_sheets"].items()', mode="eval").body
        contact_loops = [node for node in ast.walk(contact_function) if isinstance(node, ast.For) and ast.dump(node.iter, include_attributes=False) == ast.dump(expected_iter, include_attributes=False)]
        if len(contact_loops) != 1:
            raise ValueError("historical contact adapter requires one exact contact loop")
        loop = contact_loops[0]
        expected_check = ast.parse('if not source.exists() or sha256(source) != item["sha256"]:\n    raise ValueError(f"P07 contact sheet {key} no longer matches QA report")').body[0]
        expected_build = ast.parse('build_width_proxy(source, proxy_path, write=write_proxies)').body[0]
        checks = [index for index,node in enumerate(loop.body) if ast.dump(node, include_attributes=False) == ast.dump(expected_check, include_attributes=False)]
        builds = [index for index,node in enumerate(loop.body) if ast.dump(node, include_attributes=False) == ast.dump(expected_build, include_attributes=False)]
        if checks != [1] or builds != [5]:
            raise ValueError("historical contact validation/cache statements changed")
        replacement = ast.parse('__instance_prepare_contact_proxy(key, item, source, proxy_path, write=write_proxies, p07_invalidated=p07_invalidated, current_report_items=current_report_items, qa_report=qa_report, story_rewrite=story_rewrite, production_contract=production_contract)').body[0]
        # Only these two exact statements are adapted; preserve the entire remaining business function.
        expected_contact = ast.parse('contacts[key] = {**item, "reviewProxy": f"/media/storyboard-contact-sheets/{proxy_name}", "proxySha256": sha256(proxy_path), "historyRole": "CURRENT_REVIEW_EVIDENCE" if key != "overview" and any(current["scene_id"] == key for current in current_report_items) else "EVIDENCE_ONLY"}').body[0]
        if len(loop.body) != 7 or ast.dump(loop.body[6], include_attributes=False) != ast.dump(expected_contact, include_attributes=False):
            raise ValueError("historical contact metadata statement changed")
        retired_assignment = ast.parse('if key in __instance_retired_contact_metadata:\n contacts[key] = __instance_retired_contact_metadata[key]').body[0]
        retired_assignment.orelse = [loop.body[6]]
        loop.body[6] = ast.copy_location(retired_assignment, loop.body[6])
        loop.body[5] = ast.copy_location(replacement, loop.body[5])
        del loop.body[1]
        tree = ast.fix_missing_locations(tree)
    evidence_functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_review_context_evidence_catalog"]
    evidence_guard_sha = None
    if evidence_functions:
        if len(evidence_functions) != 1:
            raise ValueError("historical evidence adapter requires one exact resolver")
        evidence_guarded = [evidence_functions[0]]
        for name in ("SCRIPT_SOURCE", "STORY_REWRITE", "CHARACTER_PERFORMANCE", "ROOT"):
            nodes = [node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
            if len(nodes) != 1:
                raise ValueError(f"historical evidence adapter requires exact {name} declaration")
            evidence_guarded.append(nodes[0])
        evidence_guard_sha = hashlib.sha256("\n".join(ast.dump(node, include_attributes=False) for node in evidence_guarded).encode()).hexdigest()
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
            require(current_families == published_families and current_versions == published_versions, 'all family/version fields must equal the published snapshot')
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
    reference_functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "production_reference_provenance"]
    reference_guard_sha = None
    if reference_functions:
        if len(reference_functions) != 1:
            raise ValueError("production reference preservation requires one exact provenance function")
        reference_guarded = [reference_functions[0]]
        for name in ("PRODUCTION_REFERENCE_PATHS", "PRODUCTION_REFERENCE_MANIFEST", "PRODUCTION_MAP_BUILDER", "PRODUCTION_MAP", "ROOT"):
            nodes = [node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
            if len(nodes) != 1:
                raise ValueError(f"production reference preservation requires exact {name} declaration")
            reference_guarded.append(nodes[0])
        reference_guard_sha = hashlib.sha256("\n".join(ast.dump(node, include_attributes=False) for node in reference_guarded).encode()).hexdigest()
    if reference_functions and published_references.get('families') and not (root / MANIFEST_ALIAS).exists():
        if projection_guard_sha != 'fc8ab082ebbcdacdbdfe29cc9b33cddec337d2909bcd8d856fba476228ade16e':
            raise ValueError('Production-reference domain projection requires the exact legacy main AST')
        main_body = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main').body
        serialized_statement = ast.dump(ast.parse('serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\\n"').body[0], include_attributes=False)
        insertion = [index for index, node in enumerate(main_body) if ast.dump(node, include_attributes=False) == serialized_statement]
        if len(insertion) != 1:
            raise ValueError('Production-reference projection must precede exact final snapshot serialization')
        main_body[insertion[0]:insertion[0]] = ast.parse('__instance_preserve_reference_domain_context(payload["productionModel"])').body
        ast.fix_missing_locations(tree)
    module = types.ModuleType("instance_snapshot_builder")
    module.__file__ = str(p)
    sys.modules[module.__name__] = module
    exec(compile(tree, str(p), "exec"), module.__dict__)
    install_retired_production(module)
    registered_install(module)
    original = module.build_map_proxies
    reports = []

    def relative(candidate):
        resolved = candidate.resolve()
        value = resolved.relative_to(root).as_posix()
        # The source paths may be absent, but proxy paths must stay regular and linked to exact media pins.
        if candidate.is_symlink():
            raise ValueError(f"map proxy adapter rejects a symlink: {value}")
        return value

    def reuse_pinned_proxy(*, write=True):
        original_mapping = module.MAP_PROXY_SOURCES
        missing = {}
        proof = []
        for filename, original_path in original_mapping.items():
            if original_path.exists():
                continue
            if Path(filename).name != filename:
                raise ValueError("map proxy adapter requires a flat proxy filename")
            original_alias = relative(original_path)
            proxy = module.SITE_ROOT / "public/media" / filename
            proxy_alias = relative(proxy)
            expected_sha = pins.get(proxy_alias)
            if not expected_sha or not proxy.is_file():
                raise ValueError(f"missing original has no exact published proxy: {original_alias}")
            actual_sha = hashlib.sha256(proxy.read_bytes()).hexdigest()
            if actual_sha != expected_sha:
                raise ValueError(f"published map proxy SHA differs: {proxy_alias}")
            probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "default=nw=1:nk=1", str(proxy)], check=True, capture_output=True, text=True)
            if int(probe.stdout.strip()) != 1600:
                raise ValueError(f"published map proxy width differs: {proxy_alias}")
            missing[filename] = original_path
            proof.append({"sourcePath": original_alias, "sourceState": "MISSING", "sourceSha256": None, "proxyPath": proxy_alias, "proxySha256": actual_sha, "proxyWidth": 1600, "mode": "REUSE_PUBLISHED_PROXY_ONLY"})
        # Only suppress cache regeneration for proven existing proxies whose originals remain absent.
        module.MAP_PROXY_SOURCES = {key: value for key, value in original_mapping.items() if key not in missing}
        try:
            original(write=write)
        finally:
            module.MAP_PROXY_SOURCES = original_mapping
        reports.append(sorted(proof, key=lambda row: row["sourcePath"]))

    def pinned_json_document(document_path, value):
        alias = relative(document_path)
        content = document_path.read_bytes()
        actual_sha = hashlib.sha256(content).hexdigest()
        if document_pins.get(alias) != actual_sha or json.loads(content) != value:
            raise ValueError(f"historical contact evidence document is not an exact published input: {alias}")
        return alias, actual_sha

    def prepare_contact_proxy(key, item, original_path, proxy_path, *, write, p07_invalidated, current_report_items, qa_report, story_rewrite, production_contract):
        if retired_contact_proof(proxy_path) is not None:
            if p07_invalidated is not True or current_report_items:
                raise ValueError("retired contact media cannot be current review evidence")
            if "P07_STORYBOARD" not in ((story_rewrite.get("asset_invalidation") or {}).get("invalidated_asset_types") or []) or list(story_rewrite.get("scene_ids") or []) != list(production_contract.scene_ids) or not production_contract.scene_ids:
                raise ValueError("retired contact media requires complete current-scene invalidation")
            pinned_json_document(module.P07_QA_REPORT, qa_report)
            pinned_json_document(module.STORY_REWRITE, story_rewrite)
            if qa_report.get("contact_sheets", {}).get(key) != item:
                raise ValueError("retired contact evidence differs from its exact QA report")
            retired_contact_metadata[key] = build_retired_contact(key, item, original_path, proxy_path)
            return
        if original_path.exists():
            if hashlib.sha256(original_path.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError(f"P07 contact sheet {key} no longer matches QA report")
            module.build_width_proxy(original_path, proxy_path, write=write)
            return
        if p07_invalidated is not True or current_report_items:
            raise ValueError("missing contact original may only reuse fully invalidated historical evidence")
        if "P07_STORYBOARD" not in ((story_rewrite.get("asset_invalidation") or {}).get("invalidated_asset_types") or []) or list(story_rewrite.get("scene_ids") or []) != list(production_contract.scene_ids) or not production_contract.scene_ids:
            raise ValueError("missing contact original requires complete current-scene invalidation")
        qa_alias, qa_sha = pinned_json_document(module.P07_QA_REPORT, qa_report)
        rewrite_alias, rewrite_sha = pinned_json_document(module.STORY_REWRITE, story_rewrite)
        if key not in qa_report["contact_sheets"] or qa_report["contact_sheets"][key] != item:
            raise ValueError("contact evidence differs from its exact QA report item")
        original_alias = relative(original_path)
        if original_alias != item["path"] or len(item["sha256"]) != 64 or any(char not in "0123456789abcdef" for char in item["sha256"]):
            raise ValueError("contact original path/expected SHA is invalid")
        proxy_alias = relative(proxy_path)
        stem = "overview" if key == "overview" else f"{key.lower()}-contact"
        expected_proxy = module.P07_CONTACT_PROXY_ROOT / f"{stem}-{item['sha256'][:8]}.jpg"
        if proxy_path != expected_proxy or not proxy_path.is_file() or not pins.get(proxy_alias):
            raise ValueError("missing historical contact original has no exact published proxy")
        actual_proxy_sha = hashlib.sha256(proxy_path.read_bytes()).hexdigest()
        if actual_proxy_sha != pins[proxy_alias]:
            raise ValueError("historical contact proxy SHA differs from its published binding")
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "default=nw=1:nk=1", str(proxy_path)], check=True, capture_output=True, text=True)
        if int(probe.stdout.strip()) != 1600:
            raise ValueError("historical contact proxy width must remain 1600")
        contact_reports.append({"key": key, "sourcePath": original_alias, "sourceState": "MISSING", "originalExpectedSha": item["sha256"], "originalActualSha": None, "proxyPath": proxy_alias, "proxySha256": actual_proxy_sha, "proxyWidth": 1600, "qaReportPath": qa_alias, "qaReportSha256": qa_sha, "invalidationPath": rewrite_alias, "invalidationSha256": rewrite_sha, "historyRole": "EVIDENCE_ONLY", "currentReportItemCount": 0, "invalidationSceneCount": len(production_contract.scene_ids), "mode": "REUSE_PUBLISHED_HISTORICAL_CONTACT_PROXY_ONLY"})

    if evidence_functions:
        original_evidence_resolver = module.build_review_context_evidence_catalog

        def reuse_published_historical_evidence(references):
            live = []
            cached = {}
            source_bindings = published_evidence.get("priorBindings") or {}
            evidence_catalog = published_evidence.get("catalog") or {}
            for ref in dict.fromkeys(references):
                guidance = read_historical_guidance(ref)
                if guidance is not None:
                    cached[ref], historical_evidence_reports[ref] = guidance
                    continue
                record = evidence_catalog.get(ref)
                # Unknown refs/current sources continue through every original resolver check.
                if not isinstance(record, dict) or not isinstance(record.get("path"), str) or (root / record["path"]).exists():
                    live.append(ref)
                    continue
                path_alias = relative(root / record["path"])
                declared = source_bindings.get("storyRewrite")
                if not isinstance(declared, dict) or declared != source_bindings.get("characterPerformance") or declared.get("role") != "EVIDENCE_ONLY" or declared.get("path") != path_alias or declared.get("sha256") != record.get("sourceSha256"):
                    live.append(ref)
                    continue
                if path_alias == relative(module.SCRIPT_SOURCE) or path_alias in document_pins or path_alias in pins:
                    raise ValueError("a current source cannot use a historical excerpt cache")
                rewrite = json.loads(module.STORY_REWRITE.read_bytes())
                performance = json.loads(module.CHARACTER_PERFORMANCE.read_bytes())
                rewrite_alias, rewrite_sha = pinned_json_document(module.STORY_REWRITE, rewrite)
                performance_alias, performance_sha = pinned_json_document(module.CHARACTER_PERFORMANCE, performance)
                if rewrite.get("prior_script_evidence") != declared or performance.get("prior_script_evidence") != declared:
                    raise ValueError("historical excerpt role or source binding changed after the published cache")
                matched = re.fullmatch(r"(.+\.md):(\d+)(?:-(\d+))?", ref)
                if not matched or matched.group(1) != path_alias or record.get("ref") != ref or record.get("sourceKind") != "MARKDOWN_LINE":
                    raise ValueError("historical excerpt cache requires its exact published Markdown line ref")
                start = int(matched.group(2)); end = int(matched.group(3) or matched.group(2))
                excerpt = record.get("excerpt")
                if start < 1 or end < start or record.get("lineStart") != start or record.get("lineEnd") != end or not isinstance(excerpt, str) or not excerpt.strip() or len(excerpt.split("\n")) != end - start + 1 or hashlib.sha256(excerpt.encode("utf-8")).hexdigest() != record.get("excerptSha256"):
                    raise ValueError("historical excerpt cache range or excerpt SHA differs")
                if not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sourceSha256") or "")) or not re.fullmatch(r"[a-f0-9]{64}", str(published_evidence.get("snapshotSha256") or "")) or not published_evidence.get("releaseId"):
                    raise ValueError("historical excerpt cache lacks a pinned release/source digest")
                cached[ref] = json.loads(json.dumps(record))
                historical_evidence_reports[ref] = {"ref": ref, "sourcePath": path_alias, "sourceState": "MISSING", "sourceExpectedSha256": record["sourceSha256"], "sourceActualSha256": None, "excerptSha256": record["excerptSha256"], "cacheRecordSha256": hashlib.sha256(json.dumps(record,sort_keys=True,ensure_ascii=False,separators=(",", ":")).encode()).hexdigest(), "lineStart": start, "lineEnd": end, "historyRole": "EVIDENCE_ONLY", "cacheReleaseId": published_evidence["releaseId"], "cacheSnapshotSha256": published_evidence["snapshotSha256"], "storyRewritePath": rewrite_alias, "storyRewriteSha256": rewrite_sha, "characterPerformancePath": performance_alias, "characterPerformanceSha256": performance_sha, "mode": "REUSE_EXACT_PUBLISHED_HISTORICAL_EXCERPT_ONLY"}
            result = original_evidence_resolver(live)
            if set(result) != set(live) or set(result) & set(cached):
                raise ValueError("live evidence resolver did not retain the exact unresolved subset")
            result.update(cached)
            if set(result) != set(references) or any(not row.get("excerpt") for row in result.values()):
                raise ValueError("historical/live evidence closure differs from all requested refs")
            return result

        module.build_review_context_evidence_catalog = reuse_published_historical_evidence

    if reference_functions:
        original_reference_provenance = module.production_reference_provenance
        reference_by_path = {}
        expected_reference_paths = set()
        class PreservationWarningSink:
            def warn(self, condition, message):
                pass  # The independently verified report retains the explicit missing-manifest facts.

        def preserve_published_reference_provenance(relative_path):
            actual = original_reference_provenance(relative_path)
            if module.PRODUCTION_REFERENCE_MANIFEST.exists():
                return actual
            if not reference_reports:
                expected_references = {family_id: alias for alias, family_id in module.PRODUCTION_REFERENCE_PATHS.items()}
                if len(expected_references) != len(module.PRODUCTION_REFERENCE_PATHS):
                    raise ValueError("production reference instance declaration has duplicate family identities")
                expected_reference_paths.update(module.PRODUCTION_REFERENCE_PATHS)
                families = {row["id"]: row for row in published_references.get("families", [])}
                versions = {row["id"]: row for row in published_references.get("versions", [])}
                checker = make_preserved_reference_checker(pins, document_pins, published_references, reference_reports)
                checker(PreservationWarningSink(), families, versions, expected_references, root)
                for version in versions.values():
                    reference_by_path[version["path"]] = version
            if relative_path not in expected_reference_paths or relative_path not in reference_by_path:
                raise ValueError("only the exact published production-reference path set may preserve provenance")
            version = reference_by_path[relative_path]
            provenance = version["provenance"]
            expected_missing = {"class": "DETERMINISTIC_LOCAL_BUILD", "manifestRef": relative(module.PRODUCTION_REFERENCE_MANIFEST), "manifestSha256": None, "builderRef": relative(module.PRODUCTION_MAP_BUILDER), "builderSha256": None, "currentBuilderSha256": document_pins.get(relative(module.PRODUCTION_MAP_BUILDER)), "sourceSpecRef": relative(module.PRODUCTION_MAP), "sourceSpecSha256": None, "currentSourceSpecSha256": document_pins.get(relative(module.PRODUCTION_MAP)), "outputSha256": None, "bindingStatus": "STALE", "bindingFailures": ["MANIFEST_MISSING", "OUTPUT_SET_MISMATCH", "BUILDER_SHA_STALE", "SOURCE_SPEC_SHA_STALE", "OUTPUT_SHA_STALE"]}
            if actual != expected_missing:
                raise ValueError("production reference provenance differs for a reason beyond its missing original manifest")
            output_path = root / relative_path
            if not output_path.is_file() or hashlib.sha256(output_path.read_bytes()).hexdigest() != version["sha256"]:
                raise ValueError("production reference output changed after initial preservation verification")
            reference_resolved_paths.add(relative_path)
            # Preserve the prior published provenance fact; never synthesize/read a nonexistent manifest.
            return json.loads(json.dumps(provenance))

        module.production_reference_provenance = preserve_published_reference_provenance
        if published_references.get('families') and not module.PRODUCTION_REFERENCE_MANIFEST.exists():
            module.__instance_preserve_reference_domain_context = lambda model: preserve_reference_domain_context(model, published_references)

    module.__instance_prepare_contact_proxy = prepare_contact_proxy
    module.__instance_retired_contact_metadata = retired_contact_metadata
    module.build_map_proxies = reuse_pinned_proxy
    module.main()
    if len(reports) != 1:
        raise ValueError("map proxy adapter expected exactly one normal cache-generation call")
    for row in contact_reports:
        if (root / row["sourcePath"]).exists() or hashlib.sha256((root / row["proxyPath"]).read_bytes()).hexdigest() != row["proxySha256"]:
            raise ValueError("historical contact source/proxy changed after evidence validation")
    for row in retired_contact_reports:
        if (root / row["sourcePath"]).exists() or (root / row["proxyPath"]).exists():
            raise ValueError("retired contact media was unexpectedly materialized")
    if len({row["key"] for row in retired_contact_reports}) != len(retired_contact_reports):
        raise ValueError("retired contact metadata cannot be recorded twice")
    if len({row["key"] for row in contact_reports}) != len(contact_reports):
        raise ValueError("historical contact adapter cannot reuse an item twice")
    for row in historical_evidence_reports.values():
        if row.get('mode') == 'REUSE_EXACT_PUBLISHED_GUIDANCE_EXCERPT_ONLY':
            checked = read_historical_guidance(row['ref'])
            if checked is None or checked[1] != row:
                raise ValueError('Historical guidance binding changed after snapshot construction')
            continue
        if (root / row["sourcePath"]).exists():
            raise ValueError("historical excerpt adapter must never materialize a missing full source")
    if reference_reports and reference_resolved_paths != expected_reference_paths:
        raise ValueError("production reference preservation did not resolve every exact declared path")
    report = {"adapterVersion": "PINNED_REVIEW_EVIDENCE_REUSE_1.5", "materializationPolicy": "HASH_PINNED_EQUAL_MTIME_2000_01_01", "cacheFunctionsGuardAstSha256": cache_guard_sha, "guardAstSha256": ast_sha, "missingOriginals": reports[0], "contactGuardAstSha256": contact_guard_sha if (contact_reports or retired_contact_reports) else None, "historicalContacts": sorted(contact_reports, key=lambda row: row["key"]), "retiredContacts": sorted(retired_contact_reports, key=lambda row: row["key"]), "evidenceGuardAstSha256": evidence_guard_sha if historical_evidence_reports else None, "historicalEvidence": [historical_evidence_reports[ref] for ref in sorted(historical_evidence_reports)], "productionReferences": {"guardAstSha256": reference_guard_sha, "report": reference_reports[0], "resolvedPaths": sorted(reference_resolved_paths)} if reference_reports else None}

    if registered_candidate_proof or native_candidate_proof:
        candidate_report = registered_finish()
        if native_candidate_proof:
            report['nativeMaterialCandidates'] = candidate_report.pop('nativeCandidateDelegation')
        if registered_candidate_proof:
            report['registeredMaterialCandidates'] = candidate_report
    report['retiredProduction'] = sorted(retired_production_reports, key=lambda row:(row['kind'],row['id']))

# Build and --check must report the same bindings; do not quietly overwrite drift.
encoded = json.dumps(report, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
if report_path.exists() and report_path.read_text(encoding="utf-8") != encoded:
    raise ValueError("map proxy reuse proof changed between build and check")
report_path.write_text(encoded, encoding="utf-8")
`;
