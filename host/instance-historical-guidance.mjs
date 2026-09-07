// Historical review excerpts and the live authoring guidance are separate byte identities.
export const historicalGuidanceSupport = String.raw`
def make_historical_guidance_reader(root, published, document_pins):
    import copy, hashlib, json, re
    from pathlib import Path
    def require(ok, message):
        if not ok: raise ValueError('Historical guidance excerpt: ' + message)
    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    def sha(value): return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None
    roles={'README.md':'INSTANCE_GUIDANCE','AGENTS.md':'PROJECT_RULE_SOURCE','STATE.md':'MACHINE_MODEL_SOURCE'}
    bindings=published.get('guidanceBindings') or []
    def read(ref):
        record=(published.get('catalog') or {}).get(ref)
        if not isinstance(record,dict) or record.get('path') not in roles:return None
        alias=record['path']
        matches=[b for b in bindings if b.get('aliases')==[alias]]
        if not matches:return None
        require(len(matches)==1,'ambiguous guidance document binding')
        b=matches[0];meta=b.get('metadata') or {}
        # Only the explicit migration role permits old snapshot evidence to coexist
        # with new GUIDANCE_UPDATE bytes. Arbitrary source changes never enter here.
        if meta.get('migrationRebase')!='GUIDANCE_REBASE_TO_ACTUAL_BYTES' or meta.get('legacyExpectedSha256')!=record.get('sourceSha256'):return None
        require(meta.get('sourceRole')==roles[alias] and meta.get('path')==alias and meta.get('sha256')==meta.get('legacyExpectedSha256'),'original guidance source identity changed')
        require(b.get('documentId') and b.get('revisionId') and sha(b.get('sha256')) and sha(meta.get('legacyExpectedSha256')) and b['sha256']!=meta['legacyExpectedSha256'],'missing distinct current/historical source identity')
        require(meta.get('actualSha256')==b['sha256'] and meta.get('guidanceChangeOnly') is True and meta.get('authoringEntry')=='GUIDANCE_UPDATE' and re.fullmatch(r'guidance_[a-f0-9-]{36}',str(meta.get('guidanceUpdateId') or '')),'not a pinned controlled guidance update')
        require(b.get('bindingHash')==digest({k:b[k] for k in ('documentId','revisionId','sha256','aliases','metadata')}),'document binding hash changed')
        p=root/alias
        require(not p.is_symlink() and p.is_file() and document_pins.get(alias)==b['sha256'] and hashlib.sha256(p.read_bytes()).hexdigest()==b['sha256'],'current guidance bytes are not exactly pinned')
        require(published.get('releaseId') and sha(published.get('snapshotSha256')),'missing immutable published snapshot anchor')
        require(record.get('ref')==ref and sha(record.get('sourceSha256')) and sha(record.get('excerptSha256')),'cached source/ref hash differs')
        start,end,excerpt=record.get('lineStart'),record.get('lineEnd'),record.get('excerpt')
        require(type(start) is int and type(end) is int and start>=1 and end>=start and isinstance(excerpt,str) and excerpt.strip() and len(excerpt.split('\n'))==end-start+1 and hashlib.sha256(excerpt.encode()).hexdigest()==record['excerptSha256'],'exact old excerpt range/hash differs')
        section=re.fullmatch(r'(README\.md|AGENTS\.md|STATE\.md)#(.+)',ref)
        lines=re.fullmatch(r'(README\.md|AGENTS\.md|STATE\.md):(\d+)(?:-(\d+))?',ref)
        if section:
            heading=re.fullmatch(r'#{1,6}\s+(.+?)\s*',excerpt.split('\n')[0])
            token=section.group(2).removesuffix('规则')
            # The original resolver has two explicit section grammars: heading
            # containment, or an exact one-line rule-token locator. The frozen
            # excerpt does not pretend to revalidate an unavailable full source.
            locator_matches=bool(heading and section.group(2) in heading.group(1)) or bool(start==end and token and token in excerpt)
            require(section.group(1)==alias and record.get('sourceKind')=='MARKDOWN_SECTION' and locator_matches,'old heading/rule locator differs')
        elif lines:
            require(lines.group(1)==alias and record.get('sourceKind')=='MARKDOWN_LINE' and int(lines.group(2))==start and int(lines.group(3) or lines.group(2))==end,'old line locator differs')
        else:raise ValueError('Historical guidance excerpt: unsupported exact guidance locator')
        proof={'ref':ref,'sourcePath':alias,'sourceState':'SUPERSEDED_GUIDANCE','sourceExpectedSha256':record['sourceSha256'],'sourceActualSha256':None,'excerptSha256':record['excerptSha256'],'cacheRecordSha256':digest(record),'lineStart':start,'lineEnd':end,'historyRole':'EVIDENCE_ONLY','cacheReleaseId':published['releaseId'],'cacheSnapshotSha256':published['snapshotSha256'],'currentDocumentId':b['documentId'],'currentDocumentRevisionId':b['revisionId'],'currentDocumentSha256':b['sha256'],'currentDocumentBindingHash':b['bindingHash'],'guidanceUpdateId':meta['guidanceUpdateId'],'mode':'REUSE_EXACT_PUBLISHED_GUIDANCE_EXCERPT_ONLY'}
        return copy.deepcopy(record),proof
    return read
`;
