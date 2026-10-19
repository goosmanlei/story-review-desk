"""Read optional instance editorial content; no business ledger or migration."""
import json
import re
import hashlib
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit, parse_qs


def validate_workflow(diagram, tab_ids=None):
    """A bounded reading graph: local navigation and text, no arbitrary markup."""
    def require(condition):
        if not condition:
            raise ValueError('invalid production approach workflow diagram')
    def text(value):
        return isinstance(value, str) and bool(value.strip())
    def identifier(value):
        return isinstance(value, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value)
    def navigation(value):
        require(isinstance(value, str) and value.startswith('/?') and '\\' not in value)
        url = urlsplit(value)
        require(not url.scheme and not url.netloc and url.path == '/')
        query = parse_qs(url.query, keep_blank_values=True)
        require(all(len(values) == 1 and text(values[0]) for values in query.values()))
        workspace = query.get('workspace', [''])[0]
        allowed = {
            'story.sources': {'source'}, 'story.novel': {'source','source_chapter'}, 'story.outline': set(),
            'story.script': {'script', 'episode', 'scene'},
            'settings.workspace': {'production_tab'},
            'production.approach': {'tab'},
        }
        require(workspace in allowed and set(query) <= allowed[workspace] | {'workspace'})
        if workspace == 'settings.workspace':
            require(query.get('production_tab', [''])[0] in ('breakdown', 'entities', 'materials'))
        if workspace == 'production.approach':
            require(identifier(query.get('tab', [''])[0]))
            require(tab_ids is None or query['tab'][0] in tab_ids)
        require(not url.fragment or re.fullmatch(r'approach-[a-z0-9]+(?:-[a-z0-9]+)*', url.fragment))

    require(isinstance(diagram, dict) and set(diagram) == {
        'type', 'description', 'nodes', 'groups', 'connections', 'feedback', 'note', 'methods'})
    require(diagram['type'] == 'workflow' and text(diagram['description']) and isinstance(diagram['note'], str))
    nodes = diagram['nodes']
    require(isinstance(nodes, list) and 2 <= len(nodes) <= 24)
    for node in nodes:
        require(isinstance(node, dict) and {'id', 'title', 'text', 'icon'} <= set(node)
                and set(node) <= {'id', 'title', 'text', 'icon', 'href', 'items', 'cycle', 'shape'})
        require(identifier(node['id']) and text(node['title']) and text(node['text']))
        require(node['icon'] in ('document', 'direction', 'model', 'book', 'film', 'image', 'process'))
        require(node.get('shape', 'card') in ('card', 'paper', 'snapshot'))
        for key in ('items', 'cycle'):
            if key in node:
                require(isinstance(node[key], list) and 2 <= len(node[key]) <= 6 and all(text(v) for v in node[key]))
        if 'href' in node:
            navigation(node['href'])
    ids = [node['id'] for node in nodes]
    require(len(set(ids)) == len(ids))
    groups = diagram['groups']
    require(isinstance(groups, list) and 2 <= len(groups) <= 5)
    placed = []
    positions = {}
    group_ids = []
    for group_index, group in enumerate(groups):
        require(isinstance(group, dict) and set(group) == {'id', 'title', 'rows'})
        require(identifier(group['id']) and isinstance(group['title'], str))
        group_ids.append(group['id'])
        require(isinstance(group['rows'], list) and 1 <= len(group['rows']) <= 6)
        for row_index, row in enumerate(group['rows']):
            require(isinstance(row, list) and 1 <= len(row) <= 2)
            require(all(isinstance(v, str) and v in ids for v in row))
            placed.extend(row)
            positions.update({id: (group_index, row_index) for id in row})
    require(len(set(group_ids)) == len(group_ids) and not set(group_ids) & set(ids))
    require(len(placed) == len(ids) and set(placed) == set(ids))
    connections = diagram['connections']
    require(isinstance(connections, list) and 1 <= len(connections) <= 36)
    pairs = set()
    for edge in connections:
        require(isinstance(edge, dict) and set(edge) == {'from', 'to', 'label', 'direction'})
        require(isinstance(edge['from'], str) and isinstance(edge['to'], str))
        require(edge['from'] in ids and edge['to'] in ids and edge['from'] != edge['to'])
        start, end = positions[edge['from']], positions[edge['to']]
        require(end[0] == start[0] + 1 or (end[0] == start[0] and end[1] == start[1] + 1))
        require(edge['direction'] in ('forward', 'both') and isinstance(edge['label'], str))
        pair = (edge['from'], edge['to'])
        require(pair not in pairs)
        pairs.add(pair)
    require(set(ids) == {v for pair in pairs for v in pair})
    feedback = diagram['feedback']
    require(isinstance(feedback, dict) and set(feedback) == {'steps', 'targets', 'label'})
    require(isinstance(feedback['label'], str) and isinstance(feedback['steps'], list) and 2 <= len(feedback['steps']) <= 4)
    require(all(text(v) for v in feedback['steps']))
    require(isinstance(feedback['targets'], list) and 1 <= len(feedback['targets']) <= 4)
    require(all(isinstance(v, str) and v in ids for v in feedback['targets']))
    require(len(set(feedback['targets'])) == len(feedback['targets']))
    require(isinstance(diagram['methods'], list) and len(diagram['methods']) <= 3)
    for link in diagram['methods']:
        require(isinstance(link, dict) and set(link) == {'label', 'href'} and text(link['label']))
        navigation(link['href'])

MEDIA_TYPES = {'.png': ('image', 'image/png'), '.jpg': ('image', 'image/jpeg'),
               '.jpeg': ('image', 'image/jpeg'), '.webp': ('image', 'image/webp'),
               '.mp4': ('video', 'video/mp4'), '.webm': ('video', 'video/webm'),
               '.mp3': ('audio', 'audio/mpeg'), '.wav': ('audio', 'audio/wav'),
               '.svg': ('image', 'image/svg+xml')}


def validate_diagram(raw):
    """Method diagrams are passive shapes/text, never executable SVG documents."""
    try:
        source = raw.decode('utf-8')
        if '<!' in source or '<?' in source or '\x00' in source:
            raise ValueError('method diagram declarations and processing instructions are forbidden')
        root = ET.fromstring(source)
    except (UnicodeDecodeError, ET.ParseError) as error:
        raise ValueError('invalid method diagram') from error
    allowed = {'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
               'polygon', 'text', 'tspan', 'title', 'desc', 'defs', 'marker'}
    attributes = {'id', 'class', 'role', 'aria-labelledby', 'aria-label', 'viewBox',
                  'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy',
                  'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity',
                  'fill-rule', 'stroke', 'stroke-width', 'stroke-dasharray',
                  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity',
                  'font-family', 'font-size', 'font-weight', 'text-anchor',
                  'dominant-baseline', 'dx', 'dy', 'marker-start', 'marker-mid',
                  'marker-end', 'markerHeight', 'markerWidth', 'markerUnits',
                  'orient', 'refX', 'refY', 'preserveAspectRatio'}
    namespace = '{http://www.w3.org/2000/svg}'
    require_root = root.tag == namespace + 'svg'
    for element in root.iter():
        if not require_root or element.tag not in {namespace + tag for tag in allowed}:
            raise ValueError('unsupported method diagram element')
        for key, value in element.attrib.items():
            if key not in attributes or '://' in value or '\\' in value:
                raise ValueError('method diagram external or executable attribute')
            if 'url' in value.lower() and not re.fullmatch(r'url\(#[A-Za-z0-9_-]+\)', value):
                raise ValueError('method diagram external style reference')


def media_type(filename):
    if not isinstance(filename, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]*', filename):
        return None
    return MEDIA_TYPES.get('.' + filename.rsplit('.', 1)[-1])


def media_reference(root, filename):
    """Resolve declared identity without reading remote bytes during HTTP routing."""
    if not media_type(filename):
        raise ValueError('invalid method media filename')
    document = read_document(root)
    declared = [block for tab in (document or {}).get('tabs', []) for section in tab['sections']
                for block in section.get('blocks', [])
                if block['type'] == 'media' and block['file'] == filename]
    if not declared:
        raise FileNotFoundError(filename)
    hashes = {block['sha256'] for block in declared}
    if len(hashes) != 1:
        raise ValueError('conflicting exact method media declarations')
    return 'content/production-approach-assets/' + filename, media_type(filename)[1], hashes.pop()


def media_file(root, filename):
    relative, mime, expected = media_reference(root, filename)
    from .resources import materialize, hash_file
    path = materialize(root, relative)
    if not path.is_file() or hash_file(path) != expected:
        raise ValueError('method media differs from declared content')
    if path.suffix == '.svg':
        validate_diagram(path.read_bytes())
    return path, mime


def validate_collaboration(diagram):
    """Validate passive role/feedback/workflow data, independent of instance prose."""
    def require(condition):
        if not condition:
            raise ValueError('invalid production approach collaboration diagram')
    def text(value):
        return isinstance(value, str) and bool(value.strip())
    require(isinstance(diagram, dict))
    if diagram.get('type') == 'workflow':
        validate_workflow(diagram)
        return
    if diagram.get('type') == 'supported-collaboration':
        require(set(diagram) == {'type', 'roles', 'outcome', 'foundation', 'support', 'description'})
        require(all(text(diagram[key]) for key in ('outcome', 'support', 'description')))
        foundation = diagram['foundation']
        require(isinstance(foundation, dict) and set(foundation) == {'title', 'pillars'} and text(foundation['title']))
        for nodes, icons in ((diagram['roles'], {'human', 'ai'}), (foundation['pillars'], {'model', 'process'})):
            require(isinstance(nodes, list) and len(nodes) == 2)
            for node in nodes:
                require(isinstance(node, dict) and set(node) == {'title', 'icon'})
                require(text(node['title']) and isinstance(node['icon'], str) and node['icon'] in icons)
            require({node['icon'] for node in nodes} == icons)
        return
    fields = {'type', 'roles', 'exchanges', 'workflow'}
    require(set(diagram) in (fields | {'constraint'}, fields | {'support'}))
    require(diagram['type'] == 'collaboration')
    if 'support' in diagram:
        support = diagram['support']
        require(isinstance(support, dict) and set(support) == {'title', 'value', 'text'})
        require(all(text(support[key]) for key in support))
    else:
        require(text(diagram['constraint']))
    roles = diagram['roles']
    require(isinstance(roles, list) and 2 <= len(roles) <= 6)
    for role in roles:
        require(isinstance(role, dict) and set(role) == {'id', 'title', 'value'})
        require(text(role['title']) and text(role['value']))
        require(isinstance(role['id'], str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', role['id']))
    ids = [role['id'] for role in roles]
    require(len(set(ids)) == len(ids))
    exchanges = diagram['exchanges']
    require(isinstance(exchanges, list) and len(exchanges) == len(roles) - 1)
    for index, edge in enumerate(exchanges):
        require(isinstance(edge, dict) and set(edge) == {'from', 'to', 'label'})
        require(edge['from'] == ids[index] and edge['to'] == ids[index + 1] and text(edge['label']))
    workflow = diagram['workflow']
    require(isinstance(workflow, dict) and set(workflow) == {'label', 'stages'})
    require(text(workflow['label']) and isinstance(workflow['stages'], list))
    require(2 <= len(workflow['stages']) <= 12 and all(text(stage) for stage in workflow['stages']))


def read_document(root):
    path = root / "content" / "production-approach.json"
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    def require(condition):
        if not condition:
            raise ValueError("invalid production approach document")

    def strings(items):
        return isinstance(items, list) and all(isinstance(item, str) for item in items)

    def identifier(item):
        return isinstance(item, str) and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item)

    def table(content):
        require(strings(content["columns"]) and bool(content["columns"]))
        require(isinstance(content["rows"], list))
        require(all(strings(row) and len(row) == len(content["columns"]) for row in content["rows"]))

    def blocks(items, ids):
        require(isinstance(items, list))
        for block in items:
            kind = block["type"]
            require(kind in ("paragraph", "heading", "list", "code", "table", "media"))
            if kind == 'media':
                media = media_type(block['file'])
                require(media is not None and block['kind'] == media[0])
                fields = {'type', 'kind', 'file', 'caption', 'sha256'}
                if block['kind'] in ('image', 'video'):
                    fields.update(('width', 'height'))
                    require(all(type(block.get(key)) is int and 0 < block[key] <= 32768 for key in ('width', 'height')))
                require(set(block) == fields)
                require(isinstance(block['caption'], str) and bool(block['caption'].strip()))
                require(isinstance(block['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', block['sha256']))
            if kind in ("paragraph", "heading", "code"):
                require(isinstance(block["text"], str))
            if kind == "heading":
                require(type(block["level"]) is int and block["level"] in (3, 4))
                if 'id' in block:
                    require(identifier(block['id']) and block['id'] not in ids)
                    ids.add(block['id'])
            if kind == "code":
                require(isinstance(block.get("language", ""), str))
            if kind == "list":
                require(strings(block["items"]) and type(block["ordered"]) is bool)
            if kind == "table":
                table(block)

    try:
        require(type(value["schema_version"]) is int and value["schema_version"] in (1, 2))
        require(isinstance(value["tabs"], list))
        tab_ids = [tab["id"] for tab in value["tabs"]]
        require(all(identifier(item) for item in tab_ids) and len(set(tab_ids)) == len(tab_ids))
        if value["schema_version"] == 1:
            require(tab_ids == ["story", "materials"])
        else:
            require({"story", "materials"}.issubset(tab_ids))
        routes = value.get('reading_routes', {})
        require(isinstance(routes, dict) and set(routes) <= {'filmcraft', 'video-handbook'})
        for legacy, route in routes.items():
            require(isinstance(route, dict) and set(route) == {'default', 'anchors'})
            require(isinstance(route['anchors'], dict) and len(route['anchors']) <= 500)
            require(all(key.startswith('approach-'+legacy+'-') and identifier(key) for key in route['anchors']))
            for entry in [route['default'], *route['anchors'].values()]:
                require(isinstance(entry, dict) and set(entry) == {'category','object','node','file','section'})
                require(entry['category'] == 'resource')
                require(isinstance(entry['object'],str) and re.fullmatch(r'method\.resource\.[a-z0-9-]+',entry['object']))
                require(isinstance(entry['node'],str) and re.fullmatch(r'method\.skill\.[a-z0-9-]+',entry['node']))
                from .methods import file_path
                file_path(entry['file'])
                require(isinstance(entry['section'],str) and len(entry['section']) <= 300 and not any(c in entry['section'] for c in ('<','>',chr(0))))
        for tab in value["tabs"]:
            require(all(isinstance(tab[key], str) for key in ("label", "title", "lead")))
            require(isinstance(tab["sections"], list))
            if 'layout' in tab:
                layout = tab['layout']
                require(value['schema_version'] == 2 and isinstance(layout, dict))
                if layout.get('type') == 'diagram':
                    require(set(layout) == {'type', 'anchors'} and isinstance(layout['anchors'], dict))
                    require(len(tab['sections']) == 1 and tab['sections'][0].get('blocks') == [] and 'diagram' in tab['sections'][0])
                    diagram = tab['sections'][0]['diagram']
                    targets = {tab['sections'][0]['id']}
                    if isinstance(diagram, dict) and diagram.get('type') == 'workflow':
                        validate_workflow(diagram, tab_ids)
                        node_ids = {node['id'] for node in diagram['nodes']}
                        require(tab['sections'][0]['id'] not in node_ids)
                        targets.update(node_ids)
                    require(all(identifier(key) and target in targets and key != target and key not in targets for key, target in layout['anchors'].items()))
                else:
                    require(set(layout) == {'type', 'return_label'} and layout['type'] == 'cycle')
                    require(isinstance(layout['return_label'], str) and bool(layout['return_label'].strip()))
                    require(len(tab['sections']) >= 2)
                    require(all('blocks' in section and all(block.get('type') == 'paragraph' for block in section['blocks']) for section in tab['sections']))
            ids = set()
            section_ids = [section['id'] for section in tab['sections']]
            require(all(isinstance(id, str) for id in section_ids))
            require(len(set(section_ids)) == len(section_ids))
            ids.update(section_ids)
            for section in tab["sections"]:
                require(isinstance(section["id"], str) and section["id"].isascii())
                require(section["id"].replace("-", "").isalnum())
                require(isinstance(section["title"], str))
                if "diagram" in section:
                    require(tab.get("layout", {}).get("type") in ("cycle", "diagram"))
                    if isinstance(section['diagram'], dict) and section['diagram'].get('type') == 'workflow':
                        require(tab.get('layout', {}).get('type') == 'diagram')
                        validate_workflow(section['diagram'], tab_ids)
                    validate_collaboration(section["diagram"])
                if "blocks" in section:
                    require(value["schema_version"] == 2)
                    require(not any(key in section for key in ("paragraphs", "flow", "table", "note", "links")))
                    blocks(section["blocks"], ids)
                require(strings(section.get("paragraphs", [])))
                if "note" in section:
                    require(isinstance(section["note"], str))
                for step in section.get("flow", []):
                    require(isinstance(step["title"], str) and isinstance(step["text"], str))
                if "table" in section:
                    table(section["table"])
                for link in section.get("links", []):
                    require(isinstance(link["label"], str) and isinstance(link["href"], str))
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("invalid production approach document") from error
    return value
