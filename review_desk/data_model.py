"""Read an instance-owned business model; never encode story facts in the desk."""
import json


def load(root):
    path = root / 'content/data-model.json'
    if not path.exists():
        return None
    value = json.loads(path.read_text())
    if value.get('format') != 'data-model-v1' or not isinstance(value.get('diagrams'), list):
        raise ValueError('数据模型图格式无效')
    ids = set()
    for diagram in value['diagrams']:
        nodes = diagram['nodes']
        names = {node['id'] for node in nodes}
        placed = [name for group in diagram['groups'] for row in group['rows'] for name in row]
        if len(names) != len(nodes) or set(placed) != names or len(placed) != len(names) or names & ids:
            raise ValueError('数据模型节点重复或布局不完整')
        ids.update(names)
        for node in nodes:
            if not all(isinstance(node.get(key), str) and node[key] for key in ('id', 'title', 'text')):
                raise ValueError('数据模型节点缺少正文')
            for key in ('version', 'comments'):
                if key in node and (not isinstance(node[key], str) or not node[key].strip()):
                    raise ValueError('数据模型版本或评论说明无效')
        for edge in diagram['connections']:
            if edge['from'] not in names or edge['to'] not in names or not edge.get('label'):
                raise ValueError('数据模型关系缺少准确端点或含义')
    for diagram in value['diagrams']:
        for node in diagram['nodes']:
            for relation in node.get('related', []):
                if relation.get('to') not in ids or not isinstance(relation.get('label'), str) or not relation['label'].strip():
                    raise ValueError('数据模型跨图关系缺少准确端点或含义')
    for example in value.get('examples', []):
        if not isinstance(example.get('href'), str) or not example['href'].startswith('/?workspace='):
            raise ValueError('数据模型示例须指向本实例业务页面')
    return value
