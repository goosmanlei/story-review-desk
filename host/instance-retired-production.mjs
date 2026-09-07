// Exact historical metadata bridge. No filesystem predicate/hash is monkey-patched.
export function normalizeRetiredProductionEvidence(evidence, {canonicalJson, sha256, requireSource}) {
  const result = structuredClone(evidence);
  result.publishedObjectHashes = [];
  for (const kind of ['versions', 'audioAssets', 'sources']) for (const row of result[kind]) {
    const id = kind === 'sources' ? row.path : row.id;
    result.publishedObjectHashes.push({kind, id, sha256: sha256(canonicalJson(row))});
    if (!Object.hasOwn(row, 'mediaRetirement')) continue;
    const versions = result.versions.filter(v => v.path === row.path && v.sha256 === row.sha256);
    requireSource(versions.length === 1, 'SOURCE_RETIRED_HISTORY', 'Existing retired metadata requires one exact published version');
    const proofs = result.media.filter(p => p.registration.versionId === versions[0].id && p.registration.sha256 === row.sha256 && p.registration.aliases.includes(row.path));
    requireSource(proofs.length === 1, 'SOURCE_RETIRED_HISTORY', 'Existing retired metadata requires one exact completed proof');
    const p = proofs[0], r = p.registration;
    const marker = {state: p.retirement.phase, label: '历史媒体已清理', mediaId: r.mediaId, versionId: r.versionId, sha256: r.sha256, bindingHash: p.bindingHash};
    requireSource(canonicalJson(row.mediaRetirement) === canonicalJson(marker), 'SOURCE_RETIRED_HISTORY', 'Published media-retirement marker differs from its exact frozen proof');
    delete row.mediaRetirement;
  }
  return result;
}
export const retiredProductionSupport = String.raw`
def make_retired_production_support(root, evidence, document_pins, reports):
    import ast, copy, hashlib, json, re, sys
    from pathlib import Path
    def require(ok, message):
        if not ok: raise ValueError('Retired production evidence: ' + message)
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    def sha(value): return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None
    def local(alias):
        p = Path(alias)
        require(isinstance(alias, str) and not p.is_absolute() and p.as_posix() == alias and all(x not in ('', '.', '..') for x in p.parts), 'unsafe alias')
        out = root
        for part in p.parts:
            out = out / part
            require(not out.is_symlink(), 'symlink input: ' + alias)
        return out
    def pinned(alias):
        p = local(alias)
        require(p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == document_pins.get(alias), 'document not pinned: ' + alias)
        return p
    def raw(old):
        value = copy.deepcopy(old)
        value.update(copy.deepcopy(old.get('legacyState') or {}))
        return value
    media = evidence.get('media') or []
    versions = {r['path']:r for r in evidence.get('versions') or []}
    families = {r['id']:r for r in evidence.get('families') or []}
    sources = {r['path']:r for r in evidence.get('sources') or []}
    audio = {r['path']:r for r in evidence.get('audioAssets') or []}
    proofs = {}
    if media:
        require(evidence.get('schemaVersion') == '1.0' and evidence.get('releaseId') and sha(evidence.get('snapshotSha256')) and sha(evidence.get('recipesSha256')), 'missing exact release binding')
    for row in media:
        reg, ret = row.get('registration') or {}, row.get('retirement') or {}
        require(row.get('bindingHash') == digest({'registration':reg, 'retirement':ret}), 'proof hash differs')
        require(ret.get('phase') in ('PURGED', 'QUARANTINED') and ret.get('mediaId') == reg.get('mediaId') and ret.get('versionId') == reg.get('versionId') and reg.get('mediaId') and reg.get('versionId'), 'completed exact version required')
        require(reg.get('relativePath') == ret.get('originalRelativePath') and reg.get('sha256') == ret.get('sha256') and reg.get('byteSize') == ret.get('byteSize') and sha(reg.get('sha256')) and sha(ret.get('manifestHash')) and sha(ret.get('targetSetHash')), 'retirement identity differs')
        for alias in reg.get('aliases') or []:
            if '/' not in alias or ':' in alias or alias.startswith('/'): continue
            require(not local(alias).exists(), 'retired alias was rematerialized: ' + alias)
            proofs.setdefault(alias, []).append(row)
    def proof(alias, expected_sha, version_id=None):
        rows = [r for r in proofs.get(alias, []) if r['registration']['sha256'] == expected_sha and (version_id is None or r['registration']['versionId'] == version_id)]
        # Prefer the exact original AssetVersion registration over source-artifact aliases.
        if version_id is None and len(rows) > 1:
            identities = {(r['registration']['relativePath'], r['registration']['sha256'], r['retirement']['planId'], r['retirement']['phase']) for r in rows}
            require(len(identities) == 1, 'ambiguous retired alias')
            rows = sorted(rows, key=lambda r:(r['registration']['mediaId'], r['registration']['versionId']))[:1]
        require(len(rows) == 1, 'missing exact path/version/SHA tombstone: ' + alias)
        require(not local(alias).exists(), 'retired original/proxy was rematerialized: ' + alias)
        return rows[0]
    def marker(p):
        r = p['registration']
        return {'state':p['retirement']['phase'], 'label':'历史媒体已清理', 'mediaId':r['mediaId'], 'versionId':r['versionId'], 'sha256':r['sha256'], 'bindingHash':p['bindingHash']}
    def historical(old):
        require(old.get('historyRole') == 'EVIDENCE_ONLY' and old.get('canFlowDownstream') is False and old.get('lifecycleState') == 'EVIDENCE_ONLY', 'not immutable non-downstream history')
    for alias, old in versions.items():
        historical(old)
        require(old.get('familyId') in families and old.get('id') in families[old['familyId']].get('versionRefs', []), 'published family/version closure differs')
        proof(alias, old['sha256'], old['id'])
    for family in families.values():
        historical(family)
        require(family.get('currentVersionId') is None and family.get('currentExpectedOutputId') is None, 'retired family cannot own a current production pointer')
    def raw_version(version):
        old = versions.get(version.get('path'))
        if old is None: return False
        proof(old['path'], old['sha256'], old['id'])
        require(version.get('id') == old['id'] and version.get('familyId') == old['familyId'] and version.get('sha256') == old['sha256'] and version.get('materializationState') == 'EVIDENCE_ONLY' and version.get('historyStatus') == 'EVIDENCE_ONLY', 'raw historical version binding changed')
        return True
    def historical_invalidation_versions(current_ids, output_families, invalidation_source):
        # Reconstruct only the historical audit set, never an adoption pointer.
        ids = set(current_ids)
        retired_ids = set()
        for family in output_families:
            old = families.get(family['id'])
            if old is None or old.get('subtype') != 'STORYBOARD': continue
            if (old.get('legacyState') or {}).get('materializationState') != 'GENERATED': continue
            historical(old)
            require(old.get('currentVersionId') is None and old.get('currentExpectedOutputId') is None, 'historical invalidation has a current pointer')
            require(old.get('invalidationReason') == 'CHARACTER_PERFORMANCE_REWRITE' and old.get('invalidationSource') == invalidation_source, 'historical invalidation source changed')
            vid = old.get('projectionEvidenceVersionId')
            matches = [v for v in versions.values() if v['id'] == vid and v['familyId'] == old['id'] and v['id'] in old.get('versionRefs', [])]
            require(len(matches) == 1, 'historical invalidation requires exact published evidence version')
            v = matches[0];historical(v)
            require(v.get('invalidationReason') == old['invalidationReason'] and v.get('invalidationSource') == invalidation_source, 'historical version invalidation differs')
            require((v.get('legacyState') or {}).get('materializationState') == 'EVIDENCE_ONLY' and (v.get('legacyState') or {}).get('historyStatus') == 'EVIDENCE_ONLY', 'historical version has not been invalidated')
            proof(v['path'], v['sha256'], v['id'])
            require(vid not in retired_ids and vid not in ids, 'historical version counted as current or duplicated')
            retired_ids.add(vid)
        if retired_ids:
            count = (evidence.get('historicalInvalidationCounts') or {}).get('previouslyCurrentP07AssetVersions')
            require(isinstance(count, int) and not isinstance(count, bool) and count == 11 and len(ids | retired_ids) == count, 'published historical invalidation cardinality differs')
        return ids | retired_ids
    def seed(family_map, version_map, exact_paths):
        require(not family_map and not version_map and not exact_paths, 'seed must precede all production object construction')
        for fid, old in families.items():
            value = raw(old)
            # Existing historical expected-output records are rebuilt by their original source declarations.
            value['expectedOutputRefs'] = []
            value['versionDeepLinkAliases'] = []
            family_map[fid] = value
        for alias, old in versions.items():
            value = raw(old); value['mediaRetirement'] = marker(proof(alias,old['sha256'],old['id']))
            version_map[old['id']] = value; exact_paths[alias] = old['familyId']
    def retain_family(alias, family_id, explicit_version_id, preserve_expected_output, sha_value):
        old = versions.get(alias)
        if old is None: return False
        proof(alias, old['sha256'], old['id'])
        require(old['familyId'] == family_id and (explicit_version_id is None or explicit_version_id == old['id']) and (sha_value is None or sha_value == old['sha256']) and not preserve_expected_output, 'attempted reinterpretation of a retired production artifact')
        return True
    def retired_audio(item, evidence_only):
        data=item['data'];alias=data.get('FORMAL_OUTPUT') or data.get('FINAL_OUTPUT_INTENDED');old=audio.get(alias)
        if old is None:
            require(alias not in proofs, 'retired audio lacks exact published metadata')
            return None
        historical(old)
        require(evidence_only is True and old['id'] == item['id'] and data.get('OUTPUT_SHA256') == old['sha256'], 'retired audio definition differs')
        sidecar=item['sidecar'].relative_to(root).as_posix();pinned(sidecar)
        require(json.loads(local(sidecar).read_bytes()) == data, 'sidecar fields differ')
        old_version=versions.get(alias);require(old_version is not None, 'audio has no published AssetVersion')
        p=proof(alias,old['sha256'],old_version['id'])
        # Published audio URL is intentionally retained as history, never treated as an actual playable proxy.
        url=old.get('audio') or '';require(url.startswith('/review-audio/'), 'unknown historical audio proxy route')
        proxy_alias='review-site/public/media/audio/'+url.removeprefix('/review-audio/')
        proof(proxy_alias,old.get('proxySha256'))
        value=raw(old);value['mediaRetirement']=marker(p)
        return value
    def add_sources(source_catalog, catalog_paths):
        for alias, old in sources.items():
            require(old.get('role') == 'HISTORICAL_EVIDENCE' and old.get('authority') == 'EVIDENCE', 'retired source is not historical evidence')
            v=versions.get(alias);require(v and old.get('sha256') == v['sha256'], 'source/version binding differs')
            require(alias not in catalog_paths, 'retired source duplicated by live IO')
            value=copy.deepcopy(old);value['mediaRetirement']=marker(proof(alias,v['sha256'],v['id']))
            source_catalog.append(value);catalog_paths.add(alias)
    def validate_final(payload, recipes):
        model=payload['productionModel']
        for key, olds, rows, identity in [('versions',versions.values(),model['assetVersions'],'id'),('audioAssets',audio.values(),payload['audioAssets'],'id'),('sources',sources.values(),recipes['sourceCatalog'],'path')]:
            current={r[identity]:r for r in rows}
            for old in olds:
                value=copy.deepcopy(current.get(old[identity]));require(value is not None, 'published history disappeared: '+old[identity])
                observed_marker=value.pop('mediaRetirement',None)
                v=versions[old['path']];p=proof(old['path'],old['sha256'],v['id'])
                changed=sorted(k for k in set(value)|set(old) if value.get(k) != old.get(k) or (k in value)!=(k in old))
                require(observed_marker == marker(p) and value == old, 'published historical fields changed: '+old[identity]+' fields='+','.join(changed))
                reports.append({'kind':key,'id':old[identity],'path':old['path'],'publishedMetadataSha256':digest(old),'retirementBindingHash':p['bindingHash'],'originalExpectedSha256':old['sha256'],'originalActualSha256':None,'mode':'RETAIN_PUBLISHED_PRODUCTION_METADATA_WITH_RETIRED_MEDIA'})
        current_families={r['id']:r for r in model['assetFamilies']}
        for fid, old in families.items():
            observed=current_families.get(fid) or {}
            changed=sorted(k for k in set(observed)|set(old) if observed.get(k) != old.get(k) or (k in observed)!=(k in old))
            require(observed == old, 'published historical family fields changed: '+fid+' fields='+','.join(changed))
    guards={'build_audio_assets':'2ed1baf5e41c6f90e500f62d69ccdd696baa8e0dbd65d01a14296303da9366db','build_production_model':'14c3d75df278b765c15658794a72319d99273dd2bcacaf2ea19fb5543ded585a','main':'fc8ab082ebbcdacdbdfe29cc9b33cddec337d2909bcd8d856fba476228ade16e','build_execution_catalog':'e178c3b6c34113de8c1bf62a5bfa942e8c59708f49df52e60a5cb23713a2f6a8'}
    def function(tree,name):
        found=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name]
        require(len(found)==1 and hashlib.sha256(ast.dump(found[0],include_attributes=False).encode()).hexdigest()==guards[name], 'guarded function AST changed: '+name)
        return found[0]
    def insert_before(body, match, extra):
        expected=ast.dump(ast.parse(match).body[0],include_attributes=False)
        found=[i for i,n in enumerate(body) if ast.dump(n,include_attributes=False)==expected]
        require(len(found)==1,'guarded insertion statement changed: '+match)
        body[found[0]:found[0]]=ast.parse(extra).body
    def transform_builder(tree):
        if not versions:return tree
        af=function(tree,'build_audio_assets');pf=function(tree,'build_production_model');main=function(tree,'main')
        loops=[n for n in ast.walk(af) if isinstance(n,ast.For) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='review_id' for t in x.targets) for x in n.body)]
        # The formal-sidecar preparation loop also binds review_id, but only this loop has a source statement.
        loops=[n for n in loops if any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='source' for t in x.targets) for x in n.body)]
        require(len(loops)==1,'exact formal audio loop missing')
        insert_before(loops[0].body,'source = ROOT / output_path','retired = __instance_retired_audio(item, evidence_only)\nif retired is not None:\n assets.append(retired)\n continue')
        add=[n for n in pf.body if isinstance(n,ast.FunctionDef) and n.name=='add_family'];require(len(add)==1,'exact family constructor missing')
        add[0].body[0:0]=ast.parse('if __instance_retain_retired_family(path, family_id, explicit_version_id, preserve_expected_output, sha_value):\n return family_id').body
        at=pf.body.index(add[0]);pf.body[at:at]=ast.parse('__instance_seed_retired_production(families, versions, exact_path_to_family)').body
        targets=[n for n in ast.walk(pf) if isinstance(n,ast.GeneratorExp) and isinstance(n.elt,ast.BoolOp) and any(isinstance(x,ast.Constant) and x.value=='PLANNED' for x in ast.walk(n.elt)) and any(isinstance(x,ast.Name) and x.id=='versions' for x in ast.walk(n))]
        require(len(targets)==1,'exact AssetVersion physical integrity generator changed')
        targets[0].elt=ast.BoolOp(op=ast.And(),values=[ast.UnaryOp(op=ast.Not(),operand=ast.parse('__instance_retired_raw_version(version)',mode='eval').body),targets[0].elt])
        insert_before(main.body,'serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\\n"','__instance_validate_retired_production(payload, execution_catalog)')
        return ast.fix_missing_locations(tree)
    def install(module):
        if not versions:return
        module.__instance_retired_audio=retired_audio;module.__instance_retain_retired_family=retain_family;module.__instance_seed_retired_production=seed;module.__instance_retired_raw_version=raw_version;module.__instance_validate_retired_production=validate_final
        import asset_cleanup_contract as cleanup
        cleanup_path=pinned('scripts/asset_cleanup_contract.py')
        require(hashlib.sha256(cleanup_path.read_bytes()).hexdigest() == '536bcbe7946bce27adf5fc68ce9013aea436acc333082b32633d67ac60731235', 'guarded legacy registry/physical fingerprint implementation changed')
        original_loader=module.load_legacy_managed_media_registry
        def checked_legacy_registry(path=cleanup.DEFAULT_LEGACY_MANAGED_MEDIA_REGISTRY, *, root=root, verify_files=True):
            pinned(path.relative_to(root).as_posix())
            result=original_loader(path,root=root,verify_files=False)
            for row in result['versions']:
                if verify_files:
                    old=versions.get(row['path'])
                    if old is not None:
                        require(row['versionId']==old['id'] and row['familyId']==old['familyId'] and row['sha256']==old['sha256'],'legacy registry differs from published history')
                        p=proof(row['path'],row['sha256'],row['versionId'])
                        row['file']=cleanup.file_fingerprint(root,row['path'],row['sha256'])
                        require(row['file']['exists'] is False and row['file']['hashMatches'] is None,'retired legacy file was observed')
                        row['file']['mediaRetirement']=marker(p)
                    else:
                        row['file']=cleanup.file_fingerprint(root,row['path'],row['sha256'])
                        require(row['file']['exists'] and row['file']['hashMatches'] is True,'nonretired legacy media file/hash binding is stale: '+row['path'])
            return result
        module.load_legacy_managed_media_registry=checked_legacy_registry
        import review_execution_v8 as execution
        alias='scripts/review_execution_v8.py';ep=pinned(alias);et=ast.parse(ep.read_text());ef=function(et,'build_execution_catalog')
        invalidation = [n for n in ast.walk(ef) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'current_p07_version_ids_before_invalidation' for t in n.targets)]
        require(len(invalidation) == 1 and isinstance(invalidation[0].value, ast.SetComp), 'exact historical invalidation set changed')
        invalidation[0].value = ast.Call(func=ast.Name(id='__instance_historical_invalidation_versions', ctx=ast.Load()), args=[invalidation[0].value, ast.Name(id='p07_output_families', ctx=ast.Load()), ast.parse('relative(STORY_REWRITE)', mode='eval').body], keywords=[])
        execution.__instance_historical_invalidation_versions = historical_invalidation_versions
        insert_before(ef.body,'source_catalog.sort(key=lambda item: (item["path"], item["role"]))','__instance_add_retired_sources(source_catalog, catalog_paths)')
        # Source sidecar rows remain physical evidence and must still be catalogued.
        for n in ast.walk(ef):
            if isinstance(n,ast.For) and ast.dump(n.iter,include_attributes=False)==ast.dump(ast.parse('production_model["assetVersions"]',mode='eval').body,include_attributes=False):
                checks=[x for x in n.body if isinstance(x,ast.If) and 'version_path' in ast.unparse(x.test) and '.is_file()' in ast.unparse(x.test)]
                if checks:
                    require(len(checks)==1,'version source loop changed')
                    checks[0].body[0:0]=ast.parse('if version_path and __instance_retired_raw_version(version):\n append_source(ROOT / f"{version_path}.metadata.json", "ASSET_METADATA_EVIDENCE", "EVIDENCE")').body
        matches=[n for n in ast.walk(ef) if isinstance(n,ast.FunctionDef) and n.name=='artifact_binding_resolved'];require(len(matches)==1,'artifact resolver changed')
        target=ast.parse('(ROOT / str(version.get("path"))).is_file()',mode='eval').body
        class Binding(ast.NodeTransformer):
            count=0
            def visit_Call(self,n):
                if ast.dump(n,include_attributes=False)==ast.dump(target,include_attributes=False):
                    self.count+=1;return ast.BoolOp(op=ast.Or(),values=[n,ast.parse('__instance_retired_raw_version(version)',mode='eval').body])
                return self.generic_visit(n)
        tr=Binding();tr.visit(matches[0]);require(tr.count==1,'exact artifact physical check changed')
        execution.__instance_add_retired_sources=add_sources;execution.__instance_retired_raw_version=raw_version
        exec(compile(ast.fix_missing_locations(ast.Module(body=[ef],type_ignores=[])),str(ep),'exec'),execution.__dict__)
        module.build_execution_catalog=execution.build_execution_catalog
    return transform_builder, install
`;
