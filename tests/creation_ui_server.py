"""Disposable navigation/count fixture. Run with PYTHONPATH=.:tests.
Only the deliberately historical SOURCE fixture uses SQL to model a retained revision.
No real instance, secrets, paid APIs or production data are used.
"""
import argparse
from pathlib import Path
from review_desk.server import ReviewServer
from review_desk.screenplay import import_screenplay
from review_desk.structure import import_structure, snapshot
from review_desk.store import digest
from screenplay_server import Handler as BaseHandler
from test_screenplay import ScreenplayTest
from test_structure import direction, document

class Handler(BaseHandler):
    def do_GET(self):
        if self.path == '/creation-ui-tests':
            return self._file(Path(__file__).with_name('creation-ui.html'), 'text/html; charset=utf-8')
        super().do_GET()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8803)
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    fixture = ScreenplayTest(); fixture.setUp()
    store = fixture.store
    for id in ('script-one', 'script-two'):
        import_screenplay(store, fixture.edition(id))
    for id, group in [('plain', None), ('folk-zero', 'folk-tales'), ('folk-many', 'folk-tales'),
                      ('refine-zero', 'story-refinements'), ('refine-many', 'story-refinements')]:
        src = direction(id, '故事精修一：用于验证很长的完整标题与计数及展开收起' if id == 'refine-many' else id)
        src['group'] = group
        if group == 'story-refinements':
            src['blocks'] = [{'id': 'a', 'text': '第一章 提灯\n' + '李寄主动判断。\n' * 40}, {'id': 'b', 'text': '第二章 归家\n' + '乡亲一起帮忙。\n' * 40}]
        store.put_source(src)
    for id in ('plain', 'folk-many', 'refine-many', 'novel'):
        quote = store.source(id)['blocks'][0]['text'][:2]
        anchor = {'block_id': store.source(id)['blocks'][0]['id'], 'end_block_id': store.source(id)['blocks'][0]['id'], 'start': 0, 'end': 2, 'quote': quote}
        for n in range(2):
            c = store.create_comment({'source_id': id, 'anchor': anchor, 'body': f'{id}意见{n}'})
            if n: store.change_comment(c['id'], 'CLOSE', 1)
    deleted = store.create_comment({'source_id': 'folk-zero', 'anchor': {'block_id': 'summary', 'end_block_id': 'summary', 'start': 0, 'end': 2, 'quote': '李寄'}, 'body': '已删除的测试评论'})
    # Remove the disposable record and its audit rows, as source deletion does.
    with store.db:
        store.db.execute('DELETE FROM comment_events WHERE comment_id=?', (deleted['id'],))
        store.db.execute('DELETE FROM comments WHERE id=?', (deleted['id'],))
    # Model a retained historical SOURCE revision with a comment; the source API
    # must expose the current object's revision rather than guess from comments.
    source_obj = next(o for o in store.objects() if o['id'] == 'folk-many')
    old = next(r for r in store.revisions() if r['id'] == source_obj['current_revision'])
    old_id = digest(b'creation-ui-historical-source')
    with store.db:
        store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)',
                         (old_id, 'folk-many', 0, old['payload'], old['created_at']))
    store.create_comment({'target_object_id': 'folk-many', 'target_revision_id': old_id,
                          'anchor': {'block_id': 'summary', 'end_block_id': 'summary', 'start': 0, 'end': 2, 'quote': '李寄'}, 'body': '历史修订意见，不能计入当前资料'})
    first = fixture.structure['revision']
    anchors = [{'type': 'text', 'block_id': 'theme-one', 'end_block_id': 'theme-one', 'start': 0, 'end': 2, 'quote': '主题'},
               {'type': 'global'}, {'type': 'visual', 'visual_id': 'relation-graph', 'asset_file': 'relation.svg'},
               {'type': 'region', 'visual_id': 'relation-graph', 'asset_file': 'relation.svg',
                'points': [{'x': .1, 'y': .1}, {'x': .8, 'y': .1}, {'x': .8, 'y': .8}, {'x': .1, 'y': .8}]}]
    for n, anchor in enumerate(anchors):
        c = store.create_comment({'target_object_id': 'story-structure', 'target_revision_id': first, 'anchor': anchor, 'body': f'第一稿意见{n}'})
        if n == 1: store.change_comment(c['id'], 'CLOSE', 1)
    selection = snapshot(store)['selection']['id']
    import_structure(store, document(selection, first, second=True), 1)
    store.close()
    try:
        with ReviewServer(('127.0.0.1', args.port), fixture.root, {'id': 'creation-ui-test', 'title': '故事创作隔离验收'}) as server:
            server.RequestHandlerClass = Handler; server.evidence = args.evidence
            print(f'http://127.0.0.1:{args.port}/creation-ui-tests', flush=True)
            server.serve_forever()
    finally:
        fixture.temp.cleanup()

if __name__ == '__main__': main()
