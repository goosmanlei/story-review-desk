"""Deterministic readable projection of immutable method files, for text anchors."""
import re
from urllib.parse import quote

INLINE = re.compile(r"`([^`]+)`|\*\*([^*]+)\*\*|(!?)\[([^\]]+)\]\(([^\s)]+)\)")


def inline(raw):
    parts, pos = [], 0
    for m in INLINE.finditer(raw):
        if m.start() > pos:
            parts.append({'type': 'text', 'text': raw[pos:m.start()]})
        if m[1] is not None:
            parts.append({'type': 'code', 'text': m[1]})
        elif m[2] is not None:
            parts.append({'type': 'strong', 'text': m[2]})
        else:
            parts.append({'type': 'image' if m[3] else 'link', 'text': m[4], 'href': m[5]})
        pos = m.end()
    if pos < len(raw):
        parts.append({'type': 'text', 'text': raw[pos:]})
    return parts


def project(payload, filename=None):
    blocks = []
    for path, body in payload.get('files', {}).items():
        if filename is not None and path != filename:
            continue
        lines = body.splitlines()
        i = 0
        if path.endswith('.md') and lines and lines[0] == '---':
            i = next((j + 1 for j in range(1, len(lines)) if lines[j] == '---'), 0)
        section = None
        while i < len(lines):
            number, raw = i, lines[i]
            i += 1
            anchor = re.fullmatch(r'<!--\s*section:\s*([a-z0-9-]+)\s*-->', raw.strip())
            if anchor:
                section = anchor[1]
                continue
            if not raw.strip() or re.fullmatch(r'<!--.*-->', raw.strip()):
                continue
            kind, level, group = 'paragraph', None, None
            if raw.startswith('```'):
                code = []
                while i < len(lines) and not lines[i].startswith('```'):
                    code.append(lines[i]); i += 1
                i += 1
                raw, kind = '\n'.join(code), 'code'
                parts = [{'type': 'text', 'text': raw}]
            else:
                head = re.match(r'^(#{1,6}) (.+)$', raw)
                if head:
                    level, raw, kind = len(head[1]), head[2], 'heading'
                elif re.match(r'^\s*([-*+] |[0-9]+[.)] )', raw):
                    raw, kind = re.sub(r'^\s*([-*+] |[0-9]+[.)] )', '', raw), 'list-item'
                elif raw.startswith('> '):
                    raw, kind = raw[2:], 'quote'
                elif raw.startswith('|') and raw.rstrip().endswith('|'):
                    cells = [c.strip() for c in raw.strip()[1:-1].split('|')]
                    if all(re.fullmatch(r':?-+:?', c) for c in cells):
                        continue
                    group = 'table'
                    for column, cell in enumerate(cells):
                        parts = inline(cell)
                        blocks.append({'id': '@method/' + quote(path, safe='') + '/' + str(number) + '/' + str(column),
                                       'file': path, 'type': 'table-cell', 'row': number, 'column': column,
                                       'text': ''.join(p['text'] for p in parts), 'parts': parts})
                    continue
                parts = inline(raw)
            blocks.append({'id': '@method/' + quote(path, safe='') + '/' + str(number),
                           'file': path, 'type': kind, 'level': level,
                           'text': ''.join(p['text'] for p in parts), 'parts': parts, 'section': section if kind == 'heading' else None})
            if kind == 'heading':
                section = None
    return blocks


def validate_file_anchor(payload, anchor):
    from .store import Store
    blocks = project(payload)
    Store._validate_blocks(blocks, anchor)
    by_id = {b['id']: b for b in blocks}
    files = {by_id[p['block_id']]['file'] for p in anchor.get('segments', [anchor])}
    files.update(by_id[p['end_block_id']]['file'] for p in anchor.get('segments', [anchor]))
    if len(files) != 1 or anchor.get('file') not in files:
        raise ValueError('意见须属于一个准确文件，不能跨文件圈选')
    return blocks
