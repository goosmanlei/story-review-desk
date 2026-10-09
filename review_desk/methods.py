"""Versioned, portable working methods using the existing revision ledger.

GUIDANCE owns methods/resources/bindings; NOTE owns immutable deliveries and
artifacts. No model execution, private installation path or story import here.
"""
import copy
import json
import re
from pathlib import Path, PurePosixPath

from .store import Conflict, canonical, digest

PREFIX = 'managed-method-'
FORMATS = {name: PREFIX + name + '-v1' for name in
           ('skill', 'resource', 'binding', 'execution', 'artifact', 'activation')}


def checksum(value):
    return digest(canonical(value).encode())


def require(ok, message):
    if not ok:
        raise ValueError(message)


def text(value, name, limit=200000):
    require(isinstance(value, str) and 0 < len(value.strip()) <= limit, name + ' 必须是非空文本')


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,95}', value), '标识仅允许小写字母、数字、点、横线和下划线')
    return value


def file_path(value):
    require(isinstance(value, str) and '\\' not in value and not value.startswith('/'), '包内文件必须使用相对路径')
    path = PurePosixPath(value)
    require(value == str(path) and all(p not in ('.', '..') and not p.startswith('.') for p in path.parts), '包内文件路径无效')
    return value


def read(store, object_id=None, revision_id=None):
    row = store.db.execute('SELECT o.kind,r.* FROM revisions r JOIN objects o ON o.id=r.object_id WHERE ' +
                           ('r.id=?' if revision_id else 'o.id=? AND r.id=o.current_revision'),
                           (revision_id or object_id,)).fetchone()
    require(row is not None, '方法或资料版本不存在；请恢复准确资源包')
    result = dict(row)
    require(object_id is None or result['object_id'] == object_id, '对象与准确修订不匹配')
    result['payload'] = json.loads(result['payload'])
    require(result['payload'].get('format') in FORMATS.values(), '不是受管方法记录')
    result['revision_id'] = result.pop('id')
    return result


def reference(row):
    return {'object_id': row['object_id'], 'revision_id': row['revision_id']}


def catalog(store):
    result = {name: [] for name in ('skill', 'resource', 'binding')}
    for row in store.db.execute("SELECT o.id FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind='GUIDANCE' AND json_extract(r.payload,'$.format') LIKE 'managed-method-%'"):
        item = read(store, row['id'])
        for name in result:
            if item['payload']['format'] == FORMATS[name]:
                result[name].append(item)
    result['referenced'] = {}
    for item in result['skill'] + result['binding']:
        for ref in item['payload'].get('resources', item['payload'].get('rules', [])):
            row = read(store, ref['object_id'], ref['revision_id'])
            result['referenced'][row['revision_id']] = row
    return result


def validate(store, payload):
    kind = next((k for k, v in FORMATS.items() if payload.get('format') == v), None)
    require(kind is not None, '未知方法记录格式')
    if kind in ('skill', 'resource'):
        text(payload.get('title'), '名称', 200)
        files = payload.get('files')
        require(isinstance(files, dict) and 0 < len(files) <= 100, '请提供必要的包内文件')
        for name, content in files.items():
            file_path(name)
            require(PurePosixPath(name).parts[0] not in ('shared', 'execution.json', 'request.json', 'registry.json', 'delivery.json', 'record.json'), '包内文件名与执行交付文件冲突')
            text(content, name)
        require(sum(len(v) for v in files.values()) <= 1000000, '方法包正文过大；请拆分按需资源')
    if kind == 'resource':
        sections = payload.get('sections')
        require(isinstance(sections, dict) and bool(sections), '共用资料需要至少一个具名章节')
        for name, filename in sections.items():
            identifier(name)
            require(filename in payload['files'], '章节文件不存在：' + name)
        source = payload.get('source')
        if source:
            require(source.get('kind') == 'project-markdown' and set(source.get('files', {})) == set(payload['files']), 'Markdown 投影的来源清单不完整')
            for filename, spec in source['files'].items():
                file_path(spec['path'])
                require(spec.get('content_sha256') == digest(payload['files'][filename].encode()), 'Markdown 章节投影与来源摘要不符')
    if kind == 'skill':
        for name in ('purpose', 'applies', 'inputs', 'outputs', 'checks'):
            text(payload.get(name), name, 12000)
        body = payload['files'].get('SKILL.md', '')
        require(re.match(r'^---\nname: [a-z0-9-]+\ndescription: .+\n---\n', body), 'SKILL.md 需要 name、description 的 YAML 头部')
        require(isinstance(payload.get('work_types'), list) and bool(payload['work_types']), '请选择适用工作类型')
        for work in payload['work_types']:
            identifier(work)
        require(isinstance(payload.get('required_inputs'), list) and bool(payload['required_inputs']), '必须声明必要输入字段')
        for field in payload['required_inputs']:
            identifier(field)
        for ref in payload.get('resources', []):
            resource = read(store, ref['object_id'], ref['revision_id'])
            require(resource['payload']['format'] == FORMATS['resource'], '共用引用不是资料')
            require(ref.get('section') in resource['payload']['sections'], '引用章节失效；请重新选择准确章节')
            require(isinstance(ref.get('when', {}), dict), '章节条件必须为字段和值')
        require(isinstance(payload.get('steps'), list) and bool(payload['steps']), '方法需要必要工作步骤')
        require(len(payload['steps']) == len(set(payload['steps'])), '工作步骤不能重复')
        for step in payload['steps']:
            identifier(step)
    if kind == 'binding':
        identifier(payload.get('work_type'))
        require(isinstance(payload.get('rules'), list) and bool(payload['rules']), '环节至少需要一个方法选择')
        seen = set()
        for rule in payload['rules']:
            require(isinstance(rule.get('when'), dict), '适用条件必须为字段和值')
            condition = canonical(rule['when'])
            require(condition not in seen, '不能保存相同条件的两个方法')
            seen.add(condition)
            method = read(store, rule['object_id'], rule['revision_id'])
            require(method['payload']['format'] == FORMATS['skill'] and payload['work_type'] in method['payload']['work_types'], '所选方法不适用此工作环节')
    if kind == 'activation':
        require(payload.get('work_type') == 'media-plan' and isinstance(payload.get('frozen'), list), '启用记录必须含准确冻结范围')
        for ref in payload['frozen']:
            require(set(ref) == {'object_id', 'revision_id', 'payload_sha256'} and all(isinstance(v, str) and v for v in ref.values()), '冻结方案记录无效')
    return kind


def guard_write(store, object_id, kind, payload, expected_version):
    """Also protect the generic object writer from forging execution records."""
    managed = str(payload.get('format', '')).startswith(PREFIX)
    old = store.db.execute('SELECT r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.id=?', (object_id,)).fetchone()
    old_managed = old and str(json.loads(old['payload']).get('format', '')).startswith(PREFIX)
    if not managed and not old_managed:
        return
    require(managed and getattr(store, '_method_write', False), '受管方法必须通过方法保存或执行入口写入')
    category = validate(store, payload)
    require(kind == ('NOTE' if category in ('execution', 'artifact') else 'GUIDANCE'), '方法记录类型不匹配')
    if category in ('execution', 'artifact', 'activation'):
        require(expected_version == 0, '执行依据与产物不可改写；请开始新的步骤')


def _save(store, object_id, payload, expected_version, dependencies=()):
    category = validate(store, payload)
    store._method_write = True
    try:
        result = store.put_object(object_id, 'NOTE' if category in ('execution', 'artifact') else 'GUIDANCE',
                                  payload, expected_version, dependencies)
    finally:
        store._method_write = False
    return read(store, revision_id=result['revision'])


def save(store, value):
    category = value.get('category')
    require(category in ('skill', 'resource', 'binding'), '只可编辑方法、共用资料或工作环节')
    name = identifier(value.get('name'))
    payload = copy.deepcopy(value['payload'])
    payload['format'] = FORMATS[category]
    oid = 'method.' + category + '.' + name
    previous = store.db.execute('SELECT 1 FROM objects WHERE id=?', (oid,)).fetchone()
    if payload.get('source') or (previous and read(store, oid)['payload'].get('source')):
        require(getattr(store, '_method_source_sync', False), '此资料的正文由项目 Markdown 维护；请从准确源文件同步，页面不能另存一份正文')
    if category == 'binding':
        require(payload.get('work_type') == name, '绑定标识必须等于工作类型')
    refs = payload.get('resources', []) if category == 'skill' else payload.get('rules', []) if category == 'binding' else []
    dependencies = [{'revision_id': ref['revision_id'], 'role': 'method-resource' if category == 'skill' else 'selected-method'} for ref in refs]
    # A method may use two sections of one resource; the ledger relation is unique.
    dependencies = list({canonical(ref): ref for ref in dependencies}.values())
    try:
        return _save(store, oid, payload, value.get('expected_version'), dependencies)
    except Conflict:
        raise Conflict('此项已被更新；请核对已保存版本，再合并当前修改') from None


def resolve(store, work_type, conditions=None, binding_ref=None):
    conditions = conditions or {}
    if binding_ref:
        require(binding_ref.get('object_id') == 'method.binding.' + work_type, '冻结绑定属于其他工作类型')
    binding = read(store, 'method.binding.' + identifier(work_type), (binding_ref or {}).get('revision_id'))
    matches = [rule for rule in binding['payload']['rules'] if all(conditions.get(k) == v for k, v in rule['when'].items())]
    require(bool(matches), '没有适用方法；请在系统配置中补全此环节的适用条件')
    rank = max(len(rule['when']) for rule in matches)
    matches = [rule for rule in matches if len(rule['when']) == rank]
    require(len(matches) == 1, '方法选择存在歧义；请修正重叠条件')
    rule = matches[0]
    method = read(store, rule['object_id'], rule['revision_id'])
    validate(store, method['payload'])
    require(work_type in method['payload']['work_types'], '方法不适用此工作类型')
    resources = []
    for ref in method['payload'].get('resources', []):
        # Validate even inactive references: a missing chapter cannot disappear silently.
        resource = read(store, ref['object_id'], ref['revision_id'])
        filename = resource['payload']['sections'].get(ref['section'])
        require(filename in resource['payload']['files'], '共用章节失效；请恢复准确资源或保存修正的方法版本')
        if all(conditions.get(k) == v for k, v in ref.get('when', {}).items()):
            resources.append({'reference': {**reference(resource), 'section': ref['section']},
                              'title': resource['payload']['title'], 'file': filename,
                              'content': resource['payload']['files'][filename]})
    result = {'binding': reference(binding), 'method': reference(method), 'version': method['version'],
              'title': method['payload']['title'], 'work_type': work_type, 'conditions': conditions,
              'files': method['payload']['files'], 'resources': resources,
              'required_inputs': method['payload']['required_inputs'], 'steps': method['payload']['steps']}
    result['sha256'] = checksum(result)
    return result


def instructions(package):
    return package['files']['SKILL.md'] + ''.join('\n\n## 包内文件：' + name + '\n' + body for name, body in package['files'].items() if name != 'SKILL.md') + ''.join('\n\n## 共用资料：' + r['title'] + ' / ' + r['reference']['section'] + '\n' + r['content'] for r in package['resources'])


def prepare(store, request):
    """Deliver a full exact method and inputs, idempotently per run/step/target."""
    for key in ('work_type', 'run_id', 'step_id', 'target'):
        text(request.get(key), key, 300)
    inputs = request.get('inputs')
    require(isinstance(inputs, dict), '准确输入必须为对象')
    identity = {k: request[k] for k in ('work_type', 'run_id', 'step_id', 'target')}
    object_id = 'method.execution.' + checksum(identity)
    existing = store.db.execute('SELECT 1 FROM objects WHERE id=?', (object_id,)).fetchone()
    if existing:
        execution = read(store, object_id)
        if execution['payload']['inputs'] != inputs or execution['payload'].get('private', False) != (request.get('private') is True) or execution['payload']['conditions'] != request.get('conditions', {}) or (request.get('binding') is not None and execution['payload']['package']['binding'] != request['binding']):
            raise Conflict('恢复输入与冻结执行冲突；沿原输入恢复，换法或换输入须新建步骤')
        verify_execution(store, reference(execution), identity, inputs)
        verify_dependencies(store, execution)
        require(resolve(store, request['work_type'], execution['payload']['conditions'], execution['payload']['package']['binding']) == execution['payload']['package'], '冻结方法或共用资料不可用；请恢复准确资源包')
        return execution
    package = resolve(store, request['work_type'], request.get('conditions'), request.get('binding'))
    missing = [key for key in package['required_inputs'] if inputs.get(key) in (None, '', [], {})]
    require(not missing, '缺少必要输入：' + '、'.join(missing))
    payload = {'format': FORMATS['execution'], **identity, 'inputs': inputs, 'inputs_sha256': checksum(inputs),
               'conditions': request.get('conditions', {}), 'package': package, 'private': request.get('private') is True}
    return _save(store, object_id, payload, 0,
                 [{'revision_id': package['method']['revision_id'], 'role': 'executed-method'},
                  {'revision_id': package['binding']['revision_id'], 'role': 'execution-binding'}])


def verify_execution(store, ref, identity, inputs=None):
    execution = read(store, ref['object_id'], ref['revision_id'])
    value = execution['payload']
    require(value.get('format') == FORMATS['execution'], '不是方法执行依据')
    require(execution['version'] == 1 and execution['object_id'] == 'method.execution.' + checksum(
        {k: value[k] for k in ('work_type', 'run_id', 'step_id', 'target')}), '方法执行身份损坏')
    require(all(value.get(k) == v for k, v in identity.items()), '方法依据属于其他工作类型、目标、运行或步骤；请取得本步骤方法')
    if inputs is not None:
        require(value['inputs'] == inputs and value['inputs_sha256'] == checksum(inputs), '准确工作输入与方法依据不一致')
    package = copy.deepcopy(value['package'])
    sha = package.pop('sha256')
    require(checksum(package) == sha, '方法快照损坏；请恢复准确执行包')
    return execution


def verify_dependencies(store, row):
    """Verify the complete lineage when restoring or publishing raw rows."""
    payload = row['payload']
    category = validate(store, payload)
    expected = []
    if category in ('skill', 'binding'):
        expected = [{'revision_id': ref['revision_id'], 'role': 'method-resource' if category == 'skill' else 'selected-method'}
                    for ref in payload.get('resources' if category == 'skill' else 'rules', [])]
    elif category == 'execution':
        expected = [{'revision_id': payload['package'][key]['revision_id'], 'role': role}
                    for key, role in (('method', 'executed-method'), ('binding', 'execution-binding'))]
    elif category == 'artifact':
        execution = read(store, **payload['execution'])
        require(row['version'] == 1 and row['object_id'] == 'method.artifact.' + checksum(
            {'execution': reference(execution), 'stage': payload['stage']}), '方法产物身份损坏')
        steps = execution['payload']['package']['steps']
        require(payload['stage'] in steps, '产物步骤不属于此方法')
        expected = [{'revision_id': execution['revision_id'], 'role': 'artifact-execution'}]
        for step in steps[:steps.index(payload['stage'])]:
            previous = read(store, 'method.artifact.' + checksum({'execution': reference(execution), 'stage': step}))
            expected.append({'revision_id': previous['revision_id'], 'role': 'previous-step'})
    actual = [{'revision_id': d['to_revision'], 'role': d['role']} for d in
              store.db.execute('SELECT * FROM dependencies WHERE from_revision=?', (row['revision_id'],))]
    require(set(map(canonical, actual)) == set(map(canonical, expected)), '方法包缺少或混入步骤依赖')


def artifact(store, value):
    identity = {k: value[k] for k in ('work_type', 'run_id', 'step_id', 'target')}
    execution = verify_execution(store, value['execution'], identity, value['inputs'])
    stage = value['stage']
    stages = execution['payload']['package']['steps']
    require(stage in stages, '不是该方法的必要步骤')
    output = value['output']
    require(isinstance(output, (dict, str)) and bool(output), '步骤产物不能为空')
    prior = []
    for previous in stages[:stages.index(stage)]:
        row = read(store, 'method.artifact.' + checksum({'execution': reference(execution), 'stage': previous}))
        prior.append({'revision_id': row['revision_id'], 'role': 'previous-step'})
    payload = {'format': FORMATS['artifact'], 'execution': reference(execution), 'stage': stage,
               'output': output, 'output_sha256': checksum(output), 'private': execution['payload'].get('private', False), **identity}
    oid = 'method.artifact.' + checksum({'execution': reference(execution), 'stage': stage})
    if store.db.execute('SELECT 1 FROM objects WHERE id=?', (oid,)).fetchone():
        old = read(store, oid)
        require(old['payload'] == payload, '步骤产物已经冻结；修订须创建新步骤及依据')
        return old
    if identity['work_type'] == 'media-plan':
        from .method_media import validate_stage
        validate_stage(store, execution, stage, output)
    return _save(store, oid, payload, 0, prior + [{'revision_id': execution['revision_id'], 'role': 'artifact-execution'}])


def export_execution(store, ref, destination):
    execution = read(store, ref['object_id'], ref['revision_id'])
    value = execution['payload']
    verify_execution(store, ref, {k: value[k] for k in ('work_type', 'run_id', 'step_id', 'target')}, value['inputs'])
    folder = Path(destination)
    require(not folder.exists(), '导出目录已存在；请使用新目录')
    folder.mkdir(parents=True)
    for name, content in value['package']['files'].items():
        path = folder / file_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for index, resource in enumerate(value['package']['resources']):
        path = folder / 'shared' / (str(index) + '.md')
        path.parent.mkdir(exist_ok=True)
        path.write_text(resource['content'])
    (folder / 'execution.json').write_text(json.dumps(execution, ensure_ascii=False, indent=2) + '\n')
    (folder / 'request.json').write_text(json.dumps(value['inputs'], ensure_ascii=False, indent=2) + '\n')
    (folder / 'registry.json').write_text(json.dumps(export_registry(store, executions=[execution['object_id']]), ensure_ascii=False, indent=2) + '\n')
    return {'execution': reference(execution), 'directory': str(folder)}


def sync_source(store, root, value):
    """Read-only projections from project-owned Markdown; never write the source."""
    root = Path(root).resolve(strict=True)
    payload = {'title': value['title'], 'files': {}, 'sections': {}, 'source': {'kind': 'project-markdown', 'files': {}}}
    for section, spec in value['sections'].items():
        identifier(section)
        relative = file_path(spec['path'])
        path = (root / relative).resolve(strict=True)
        require(root in path.parents and path.suffix == '.md', '资料源必须是项目内 Markdown 文件')
        body = path.read_text(encoding='utf-8')
        content = body
        if spec.get('section'):
            parts = re.split(r'<!--\s*section:\s*([a-z0-9-]+)\s*-->', body)
            matches = [parts[i+1] for i in range(1, len(parts), 2) if parts[i] == spec['section']]
            require(len(matches) == 1, 'Markdown 章节不存在或重复：' + spec['section'])
            content = matches[0].strip() + '\n'
        filename = 'references/' + section + '.md'
        payload['files'][filename] = content
        payload['sections'][section] = filename
        payload['source']['files'][filename] = {**spec, 'sha256': digest(body.encode()), 'content_sha256': digest(content.encode())}
    oid = 'method.resource.' + identifier(value['name'])
    if store.db.execute('SELECT 1 FROM objects WHERE id=?', (oid,)).fetchone():
        old = read(store, oid)
        if old['payload'] == {**payload, 'format': FORMATS['resource']}:
            return old
    store._method_source_sync = True
    try:
        return save(store, {'category': 'resource', 'name': value['name'], 'expected_version': value['expected_version'], 'payload': payload})
    finally:
        store._method_source_sync = False


def export_registry(store, executions=()):
    """Portable definition history; private work is included only by exact ID."""
    selected = set(executions)
    for oid in selected:
        require(read(store, oid)['payload']['format'] == FORMATS['execution'], '只可指定准确执行对象')
    records = []
    for row in store.db.execute("SELECT o.kind,r.* FROM revisions r JOIN objects o ON o.id=r.object_id WHERE json_extract(r.payload,'$.format') LIKE 'managed-method-%' ORDER BY r.object_id,r.version"):
        payload = json.loads(row['payload'])
        if payload['format'] in (FORMATS['execution'], FORMATS['artifact']):
            if row['object_id'] not in selected and payload.get('execution', {}).get('object_id') not in selected:
                continue
        records.append({'object_id': row['object_id'], 'kind': row['kind'], 'version': row['version'],
                        'revision_id': row['id'], 'payload': payload, 'created_at': row['created_at'],
                        'dependencies': [{'revision_id': d['to_revision'], 'role': d['role']} for d in store.db.execute('SELECT * FROM dependencies WHERE from_revision=? ORDER BY to_revision,role', (row['id'],))]})
    result = {'format': 'managed-method-registry-v1', 'records': records}
    result['sha256'] = checksum(result)
    return result


def restore_registry(store, archive):
    """Atomic append-only restoration, with exact history and optimistic heads."""
    body = copy.deepcopy(archive)
    sha = body.pop('sha256', None)
    require(body.get('format') == 'managed-method-registry-v1' and checksum(body) == sha, '方法包摘要不匹配')
    rows = body['records']
    require(isinstance(rows, list) and len(rows) == len({r['revision_id'] for r in rows}), '方法包有重复版本')
    ids = {r['revision_id'] for r in rows}
    for row in rows:
        require(row['payload'].get('format') in FORMATS.values(), '方法包含有其他业务数据')
        require(row['revision_id'] == checksum({k: row[k] for k in ('object_id', 'version', 'payload')}), '方法版本身份损坏')
        require(all(d['revision_id'] in ids for d in row['dependencies']), '方法包缺少准确依赖')
    inserted = 0
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        for oid in {r['object_id'] for r in rows}:
            current = store.db.execute('SELECT version FROM objects WHERE id=?', (oid,)).fetchone()
            require(not current or current[0] <= max(r['version'] for r in rows if r['object_id'] == oid), '目标已更新；不能用旧方法包覆盖当前版本')
        remaining = list(rows)
        while remaining:
            progress = False
            for row in list(remaining):
                old = store.db.execute('SELECT * FROM revisions WHERE id=?', (row['revision_id'],)).fetchone()
                if old:
                    require(old['object_id'] == row['object_id'] and old['version'] == row['version'] and json.loads(old['payload']) == row['payload'], '已有方法历史不同')
                    deps = [{'revision_id': d['to_revision'], 'role': d['role']} for d in store.db.execute('SELECT * FROM dependencies WHERE from_revision=? ORDER BY to_revision,role', (old['id'],))]
                    require(deps == row['dependencies'], '已有方法依赖不同')
                    remaining.remove(row); progress = True; continue
                current = store.db.execute('SELECT version FROM objects WHERE id=?', (row['object_id'],)).fetchone()
                version = current[0] if current else 0
                require(version < row['version'], '目标同版方法不同；请人工合并为新版本')
                if version + 1 != row['version'] or any(not store.db.execute('SELECT 1 FROM revisions WHERE id=?', (d['revision_id'],)).fetchone() for d in row['dependencies']):
                    continue
                store._method_write = True
                try:
                    result = store._put_object(row['object_id'], row['kind'], row['payload'], version, row['dependencies'])
                finally:
                    store._method_write = False
                require(result['revision'] == row['revision_id'], '恢复版本身份不一致')
                store.db.execute('UPDATE revisions SET created_at=? WHERE id=?', (row['created_at'], row['revision_id']))
                if version == 0:
                    store.db.execute('UPDATE objects SET created_at=? WHERE id=?', (row['created_at'], row['object_id']))
                store.db.execute('UPDATE objects SET updated_at=? WHERE id=?', (row['created_at'], row['object_id']))
                inserted += 1; remaining.remove(row); progress = True
            require(progress, '方法包缺少连续历史或存在循环依赖')
        for row in rows:
            payload = row['payload']
            verify_dependencies(store, row)
            if payload['format'] == FORMATS['execution']:
                verify_execution(store, reference(row), {k: payload[k] for k in ('work_type', 'run_id', 'step_id', 'target')}, payload['inputs'])
                require(resolve(store, payload['work_type'], payload['conditions'], payload['package']['binding']) == payload['package'], '执行快照与准确方法不同')
            elif payload['format'] == FORMATS['artifact']:
                execution = read(store, **payload['execution'])
                # artifact() would start a nested transaction only for a missing
                # row; every imported artifact already exists here.
                artifact(store, {**payload, 'inputs': execution['payload']['inputs']})
    return {'sha256': sha, 'inserted': inserted, 'revisions': len(rows)}
