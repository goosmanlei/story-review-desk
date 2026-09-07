// Independent semantic QA only: no filesystem predicate, digest, object or ReviewEvent is replaced.
export const retiredSemanticSupport = String.raw`
RETIRED_QA_AST_GUARDS = {
    'versionFileRequirement': '45beebd48684d27c1f413c7fc1a9a484eb0f796332bded8ab77debafe5809d45',
    'versionHashLoop': 'f4bcb8395bc11181adcea1b687487f41ac8c1fc71d77568113d27dca94afbdee',
    'sourceHashLoop': 'cf6c5b42ef2a92af88310d710b763c24a45eb47210387484e1e2fa2dbd8a8e02',
}

def bridge_retired_semantic_ast(tree):
    import ast, hashlib
    def require(ok, message):
        if not ok: raise ValueError('Retired semantic AST: ' + message)
    validators = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'validate']
    require(len(validators) == 1, 'expected one original validator')
    validator = validators[0]
    expected_test = ast.dump(ast.parse('version.get("outputState") != "DELETED"', mode='eval').body, include_attributes=False)
    physical = [n for n in ast.walk(validator) if isinstance(n, ast.If) and ast.dump(n.test, include_attributes=False) == expected_test]
    hashes = [n for n in ast.walk(validator) if isinstance(n, ast.If) and isinstance(n.test, ast.UnaryOp) and isinstance(n.test.op, ast.Not) and isinstance(n.test.operand, ast.Name) and n.test.operand.id == 'skip_hashes']
    require(len(physical) == len(hashes) == 1, 'exact physical and hash branches changed')
    loops = [n for n in hashes[0].body if isinstance(n, ast.For)]
    require(len(loops) == 2 and all(isinstance(n.target, ast.Name) for n in loops), 'hash loop structure changed')
    nodes = {'versionFileRequirement': physical[0], **{n.target.id + 'HashLoop': n for n in loops}}
    require(set(nodes) == set(RETIRED_QA_AST_GUARDS), 'hash loop identities changed')
    for name, node in nodes.items():
        require(hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest() == RETIRED_QA_AST_GUARDS[name], 'original validation AST changed: ' + name)
    # Every non-retired version executes the complete original branch, unchanged.
    old = physical[0]
    old.test = ast.BoolOp(op=ast.And(), values=[ast.UnaryOp(op=ast.Not(), operand=ast.parse('__instance_retired_semantic_row("versions", version)', mode='eval').body), old.test])
    for name, kind in [('versionHashLoop', 'versions'), ('sourceHashLoop', 'sources')]:
        loop = nodes[name]
        loop.body[0:0] = ast.parse('if __instance_retired_semantic_row(' + repr(kind) + ', ' + loop.target.id + '):\n continue').body
    return ast.fix_missing_locations(tree)

def make_retired_semantic_checker(root, evidence, media_pins, reports):
    import copy, hashlib, json, re
    from pathlib import Path
    root = Path(root).resolve()
    def require(ok, message):
        if not ok: raise ValueError('Retired semantic evidence: ' + message)
    def canonical(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    def digest(value): return hashlib.sha256(canonical(value).encode()).hexdigest()
    def sha(value): return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None
    def same(a, b): return canonical(a) == canonical(b)
    def local(alias):
        require(isinstance(alias, str) and alias and '\\' not in alias and '\x00' not in alias, 'invalid relative path')
        p = Path(alias)
        require(not p.is_absolute() and p.as_posix() == alias and all(x not in ('', '.', '..') for x in p.parts), 'unsafe relative path: ' + alias)
        out = root
        for part in p.parts:
            out = out / part
            require(not out.is_symlink(), 'symlink in retired path: ' + alias)
        return out
    def absent(alias):
        require(not local(alias).exists(), 'retired media was materialized: ' + alias)
        require(alias not in media_pins, 'retired alias is also an active materialization pin: ' + alias)
    require(evidence.get('schemaVersion') == '1.0' and isinstance(evidence.get('releaseId'), str) and evidence['releaseId'] and sha(evidence.get('snapshotSha256')) and sha(evidence.get('recipesSha256')), 'missing exact published release anchor')
    proof_by_identity = {}; by_alias = {}
    for proof in evidence.get('media') or []:
        require(isinstance(proof, dict) and set(proof) == {'registration', 'retirement', 'bindingHash'}, 'unknown proof shape')
        reg = proof['registration']; ret = proof['retirement']
        require(isinstance(reg, dict) and isinstance(ret, dict), 'invalid proof records')
        require(set(reg) == {'mediaId','versionId','relativePath','sha256','byteSize','aliases'}, 'registration shape differs')
        require(set(ret) == {'mediaId','versionId','phase','planId','operationId','sequence','originalRelativePath','quarantineRelativePath','sha256','byteSize','manifestHash','targetSetHash'}, 'tombstone shape differs')
        require(proof['bindingHash'] == digest({'registration':reg,'retirement':ret}), 'tombstone binding hash differs')
        require(all(isinstance(reg.get(k), str) and reg[k] for k in ('mediaId','versionId')) and ret['mediaId'] == reg['mediaId'] and ret['versionId'] == reg['versionId'], 'version identity differs')
        require(ret['phase'] in ('PURGED','QUARANTINED') and ret['originalRelativePath'] == reg['relativePath'] and ret['sha256'] == reg['sha256'] and ret['byteSize'] == reg['byteSize'], 'retirement not exact and complete')
        require(sha(reg['sha256']) and sha(ret['manifestHash']) and sha(ret['targetSetHash']) and type(reg['byteSize']) is int and reg['byteSize'] > 0 and type(ret['sequence']) is int and ret['sequence'] > 0, 'invalid digest/size/sequence')
        require(ret['planId'] == 'retirement_' + ret['manifestHash'] and isinstance(ret['operationId'],str) and re.fullmatch(r'retirement_op_[a-f0-9]{64}', ret['operationId']) is not None, 'invalid exact plan/operation identity')
        require(reg['relativePath'].startswith('media/') and ret['quarantineRelativePath'].startswith('media/.retirement/' + ret['planId'] + '/'), 'retirement paths escaped the plan')
        expected_quarantine = 'media/.retirement/' + ret['planId'] + '/' + hashlib.sha256(reg['relativePath'].encode()).hexdigest() + Path(reg['relativePath']).suffix
        require(ret['quarantineRelativePath'] == expected_quarantine, 'quarantine path differs')
        aliases = reg['aliases']
        require(isinstance(aliases, list) and all(isinstance(a,str) and a for a in aliases) and aliases == sorted(set(aliases)), 'alias closure must be sorted and unique')
        identity = (reg['mediaId'],reg['versionId'])
        require(identity not in proof_by_identity, 'duplicate registration proof')
        proof_by_identity[identity] = proof
        absent(reg['relativePath'])
        # Isolated compiler never materializes quarantine bytes, even before purge.
        absent(ret['quarantineRelativePath'])
        for alias in aliases:
            # Absolute /media and /review-audio entries are route identities,
            # not paths to read from the isolated compiler filesystem.
            if '/' in alias and ':' not in alias and not alias.startswith('/'):
                absent(alias)
                by_alias.setdefault(alias, []).append(proof)
    require(proof_by_identity, 'empty retirement proof set')
    def collection(key, identity):
        rows = evidence.get(key)
        require(isinstance(rows,list), 'missing published ' + key)
        result = {}
        for row in rows:
            require(isinstance(row,dict) and isinstance(row.get(identity),str) and row[identity] and row[identity] not in result and 'mediaRetirement' not in row, 'duplicate or marked published ' + key)
            result[row[identity]] = row
        return result
    versions = collection('versions','id'); families = collection('families','id')
    audio = collection('audioAssets','id'); sources = collection('sources','path')
    by_version_path = {}
    for old in versions.values():
        require(old.get('path') not in by_version_path, 'multiple published versions own one retired path')
        by_version_path[old['path']] = old
    require(versions and set(families) == {v.get('familyId') for v in versions.values()} and set(sources) == set(by_version_path), 'published version/family/source closure differs')
    def historical(row, kind):
        require(row.get('historyRole') == 'EVIDENCE_ONLY' and row.get('outputState') == 'EVIDENCE_ONLY' and row.get('lifecycleState') == 'EVIDENCE_ONLY' and row.get('canFlowDownstream') is False, 'not isolated historical ' + kind)
        for key in ('executionAllowed','generationAllowed','countsTowardCurrent','activeInCurrentProduction'):
            require(row.get(key) is not True, 'historical item enabled: ' + key)
    def version_proof(old):
        matches = [p for p in by_alias.get(old['path'],[]) if p['registration']['versionId'] == old['id'] and p['registration']['sha256'] == old['sha256']]
        require(len(matches) == 1, 'missing/ambiguous exact published version tombstone: ' + old['id'])
        return matches[0]
    def marker(proof):
        reg = proof['registration']
        return {'state':proof['retirement']['phase'],'label':'历史媒体已清理','mediaId':reg['mediaId'],'versionId':reg['versionId'],'sha256':reg['sha256'],'bindingHash':proof['bindingHash']}
    for old in versions.values():
        historical(old, 'version'); version_proof(old)
        require(old['id'] in families[old['familyId']].get('versionRefs',[]), 'published family/version relation differs')
    for old in families.values():
        historical(old, 'family')
        require(old.get('currentVersionId') is None and old.get('currentExpectedOutputId') is None and old.get('scopeRole') == 'HISTORICAL' and old.get('activityRole') == 'HISTORICAL_EVIDENCE' and old.get('countsTowardCurrent') is False, 'historical family is current')
    for old in sources.values():
        require(old.get('role') == 'HISTORICAL_EVIDENCE' and old.get('authority') == 'EVIDENCE' and old.get('sha256') == by_version_path[old['path']]['sha256'], 'source no longer historical')
    for old in audio.values():
        historical(old,'audio')
        require(old.get('path') in by_version_path and old.get('sha256') == by_version_path[old['path']]['sha256'], 'audio/version binding differs')
        url = old.get('audio')
        require(isinstance(url,str) and url.startswith('/review-audio/'), 'unknown audio proxy alias')
        alias = 'review-site/public/media/audio/' + url[len('/review-audio/'):]
        matches = [p for p in by_alias.get(alias,[]) if p['registration']['sha256'] == old.get('proxySha256')]
        require(matches and len({(p['registration']['relativePath'],p['registration']['sha256'],p['retirement']['planId'],p['retirement']['phase']) for p in matches}) == 1, 'audio proxy tombstone differs')
    originals = {'versions':versions,'audioAssets':audio,'sources':sources}
    def verify_row(kind, row):
        require(isinstance(row,dict), 'invalid generated row')
        identity = 'path' if kind == 'sources' else 'id'
        old = originals[kind].get(row.get(identity))
        if old is None:
            require('mediaRetirement' not in row and row.get('path') not in by_version_path, 'unbound retirement marker or rebound retired path')
            return False
        value = dict(row); observed = value.pop('mediaRetirement',None)
        require(same(value,old), 'all original fields must remain exact: ' + kind + '/' + old[identity])
        v = by_version_path[old['path']]; proof = version_proof(v)
        require(same(observed,marker(proof)), 'marker not bound to original exact version')
        absent(old['path'])
        return True
    def verify_generated(data, recipes):
        model = data.get('productionModel') or {}
        groups = [('versions',model.get('assetVersions')),('audioAssets',data.get('audioAssets')),('sources',recipes.get('sourceCatalog'))]
        result = []
        for kind, rows in groups:
            require(isinstance(rows,list), 'missing generated collection: '+kind)
            key = 'path' if kind == 'sources' else 'id'; observed = set()
            for row in rows:
                if verify_row(kind,row):
                    require(row[key] not in observed, 'duplicate generated historical row')
                    observed.add(row[key]); old = originals[kind][row[key]]; p = version_proof(by_version_path[old['path']])
                    result.append({'kind':kind,'id':old[key],'path':old['path'],'publishedMetadataSha256':digest(old),'retirementBindingHash':p['bindingHash'],'originalExpectedSha256':old['sha256'],'originalActualSha256':None,'mode':'RETAIN_PUBLISHED_PRODUCTION_METADATA_WITH_RETIRED_MEDIA'})
            require(observed == set(originals[kind]), 'published historical rows disappeared: '+kind)
        generated_families = model.get('assetFamilies') or []
        for fid, old in families.items():
            matches = [row for row in generated_families if row.get('id') == fid]
            require(len(matches) == 1 and same(matches[0],old), 'all family fields/pointers/ExpectedOutput history must remain exact')
        require(all(row.get('currentVersionId') not in versions for row in generated_families), 'retired version became a current family pointer')
        expected_sources = recipes['sourceCatalog']
        for rows in [(data.get('executionRecipeSummary') or {}).get('sourceCatalog'),(model.get('executionRecipeSummary') or {}).get('sourceCatalog'),(model.get('snapshotManifest') or {}).get('sourceCatalog')]:
            require(same(rows,expected_sources), 'snapshot/recipe source catalog copies differ')
        result.sort(key=lambda row:(row['kind'],row['id']))
        if reports: require(same(reports,result), 'independent verification changed during QA')
        else: reports.extend(result)
        return result
    def install(module):
        original = module.validate
        module.__instance_retired_semantic_row = verify_row
        def checked_validate(*args, **kwargs):
            before_data = module.load_json(module.DATA_PATH); before_recipes = module.load_json(module.RECIPES_PATH)
            verify_generated(before_data,before_recipes)
            result = original(*args,**kwargs)
            after_data = module.load_json(module.DATA_PATH); after_recipes = module.load_json(module.RECIPES_PATH)
            require(same(before_data,after_data) and same(before_recipes,after_recipes), 'generated artifacts changed during independent QA')
            verify_generated(after_data,after_recipes)
            result.metrics['retiredHistoricalMetadataVerified'] = len(reports)
            result.metrics['retiredMediaActualHashesComputed'] = 0
            return result
        module.validate = checked_validate
    return verify_row, verify_generated, install
`;
