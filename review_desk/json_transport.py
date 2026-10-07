"""Lossless interned JSON for large review responses, negotiated by the client.

Arrays and objects retain order. Scalars retain type. Repeated immutable text
and equal record trees travel once; consumers reconstruct independent objects.
"""
import gzip
import json

MEDIA_TYPE = 'application/vnd.review-desk.graph+json'


def pack(value):
    nodes, known, records = [], {}, {}

    def wire(item):
        return {'$': item[1]} if item[0] == 'ref' else item[1]

    def walk(item):
        identity = (item.get('id'), item.get('object_id')) if isinstance(item, dict) and 'payload' in item and isinstance(item.get('id'), str) else None
        if identity:
            for original, reference in records.get(identity, []):
                if original == item:
                    return reference
        if isinstance(item, dict):
            data = [(key, walk(child)) for key, child in item.items()]
            key = ('o', tuple(data))
            node = ['o', [[name, wire(child)] for name, child in data]]
        elif isinstance(item, list):
            data = tuple(walk(child) for child in item)
            key = ('a', data)
            node = ['a', [wire(child) for child in data]]
        elif isinstance(item, str) and len(item) >= 64:
            key, node = ('s', item), ['s', item]
        else:
            return (type(item).__name__, item)
        index = known.get(key)
        if index is None:
            index = len(nodes)
            known[key] = index
            nodes.append(node)
        reference = ('ref', index)
        if identity:
            records.setdefault(identity, []).append((item, reference))
        return reference

    return {'format': 'review-graph-v1', 'root': wire(walk(value)), 'nodes': nodes}


def encode(value, graph=False, compressed=False):
    body = json.dumps(pack(value) if graph else value, ensure_ascii=False, separators=(',', ':')).encode()
    return gzip.compress(body, compresslevel=1, mtime=0) if compressed else body
