from test_methods import seed as seed_methods
import copy
import json
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.polish import build_context
from review_desk.screenplay import import_screenplay, snapshot
from review_desk.store import Conflict, Store
from review_desk.structure import import_structure, select_direction, snapshot as structure_snapshot
from test_structure import direction, document


class ScreenplayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        assets = self.root / 'export' / 'assets'; assets.mkdir(parents=True)
        (assets / 'relation.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.store = Store(self.root / '.runtime' / 'review.sqlite3')
        self.store.put_source(direction('novel', '小说待审阅'))
        selected = select_direction(self.store, 'novel', 0)
        self.structure = import_structure(self.store, document(selected['revision']), 0)
        self.source = next(o for o in self.store.objects() if o['id'] == 'novel')

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def edition(self, id='script-one'):
        episodes = []
        for n in (1, 2):
            episodes.append({'id': f'{id}-e{n}', 'number': n, 'title': f'第{n}集', 'estimated_seconds': 240,
                             'blocks': [{'id': 'a', 'text': '李寄：我来试试。🌙'}, {'id': 'b', 'text': '父亲核看门闩。'}],
                             'scenes': [{'id': 's1', 'heading': '场一', 'location': '外景·庙后', 'time': '日',
                                         'estimated_seconds': 240, 'block_ids': ['a', 'b']}]})
        return {'format': 'screenplay-edition-v1', 'id': id, 'title': id, 'notes': '测试待审阅稿',
                'review_status': 'pending', 'duration_kind': 'estimate',
                'basis': {'story': {'object_id': 'novel', 'revision_id': self.source['current_revision']},
                          'structure': {'object_id': 'story-structure', 'revision_id': self.structure['revision']}},
                'episodes': episodes}

    def test_comment_isolation_unicode_history_and_restore(self):
        before = self.store.configurations()
        first = import_screenplay(self.store, self.edition())
        second = import_screenplay(self.store, self.edition('script-two'))
        ep = first['episodes'][0]
        anchor = {'block_id': 'a', 'end_block_id': 'b', 'start': 3, 'end': 4, 'quote': '我来试试。🌙\n父亲核看'}
        c = self.store.create_comment({'target_object_id': ep['object_id'], 'target_revision_id': ep['revision_id'], 'anchor': anchor, 'body': '请补动作'})
        with self.assertRaises(ValueError):
            self.store.create_comment({'target_object_id': second['episodes'][0]['object_id'], 'target_revision_id': ep['revision_id'], 'anchor': anchor, 'body': '错误归属'})
        self.assertEqual(self.store.comments(target_object_id=first['episodes'][1]['object_id']), [])
        self.assertEqual(self.store.comments(target_object_id=second['episodes'][0]['object_id']), [])
        self.store.change_comment(c['id'], 'EDIT', 1, '请把动作写得更清楚')
        self.store.change_comment(c['id'], 'CLOSE', 2)
        self.store.change_comment(c['id'], 'REOPEN', 3)
        self.assertEqual(self.store.comment(c['id'])['target_revision_id'], ep['revision_id'])
        self.assertEqual(before, self.store.configurations())
        self.assertEqual(structure_snapshot(self.store)['confirmations'], [])
        export(self.store, self.root / 'export')
        restored = Store(self.root / 'restore' / '.runtime' / 'review.sqlite3')
        try:
            restore(restored, self.root / 'export')
            self.assertEqual(snapshot(restored), snapshot(self.store))
            self.assertEqual(restored.comments(), self.store.comments())
            self.assertEqual(restored.events(), self.store.events())
        finally:
            restored.close()

    def test_immutable_idempotent_and_atomic(self):
        value = self.edition(); first = import_screenplay(self.store, value)
        self.assertTrue(import_screenplay(self.store, value)['unchanged'])
        value['episodes'][0]['blocks'][0]['text'] += '改'
        with self.assertRaises(Conflict):
            import_screenplay(self.store, value)
        # Collision discovered after the first episode was inserted rolls back all.
        self.store.put_object('bad-edition-e2', 'NOTE', {'body': 'existing'})
        before = self.store.objects()
        with self.assertRaises(Conflict):
            import_screenplay(self.store, self.edition('bad-edition'))
        self.assertEqual(before, self.store.objects())
        self.assertEqual(len(snapshot(self.store)['versions']), 1)

    def test_directory_preserves_exact_links_and_scene_metadata_without_body_text(self):
        import_screenplay(self.store,self.edition());import_screenplay(self.store,self.edition('script-two'))
        full=snapshot(self.store);expected=copy.deepcopy(full)
        for version in expected['versions']:
            version['payload'].pop('blocks',None)
            for episode in version['episodes']:episode['payload'].pop('blocks',None)
        self.assertEqual(snapshot(self.store,metadata=True),expected)
        self.assertEqual(snapshot(self.store),full)
        self.assertEqual(self.store.sources(metadata=True),[{'id':'novel','title':'小说待审阅'}])

    def test_invalid_contracts_do_not_write(self):
        changes = [lambda d: d['basis']['story'].update(object_id=[]),
                   lambda d: d['basis']['story'].update(revision_id={}),
                   lambda d: d['episodes'][0].update(estimated_seconds=1),
                   lambda d: d['episodes'][0]['scenes'][0].update(block_ids=['a']),
                   lambda d: d['basis']['story'].update(revision_id=self.structure['revision']),
                   lambda d: d.update(review_status='accepted'),
                   lambda d: d['episodes'][1].update(id=d['episodes'][0]['id'])]
        before = self.store.objects()
        for change in changes:
            value = self.edition(); change(value)
            with self.assertRaises(ValueError):
                import_screenplay(self.store, value)
            self.assertEqual(before, self.store.objects())

    def test_polish_uses_exact_episode_and_original_basis_after_new_structure(self):
        seed_methods(self.store)
        first = import_screenplay(self.store, self.edition())
        old = self.structure['revision']
        selection = structure_snapshot(self.store)['selection']['id']
        import_structure(self.store, document(selection, old, second=True), 1)
        ep = first['episodes'][0]
        preview = build_context(self.store, None, {'block_id': 'a', 'end_block_id': 'a', 'start': 0, 'end': 2, 'quote': '李寄'}, '请补动作', ep['object_id'], ep['revision_id'])
        context = preview['context']
        self.assertEqual(context['basis']['structure']['revision_id'], old)
        self.assertEqual(context['target_revision_id'], ep['revision_id'])
        self.assertEqual(context['creative_stage']['id'], 'SCRIPT_DRAFT')
        self.assertEqual(len(context['source_documents']), 3)
        self.assertTrue(context['source_documents'][0]['text'])
        self.assertTrue(all(d['identity_only'] and not d['text'] for d in context['source_documents'][1:]))
        self.assertFalse(preview['saved'])


if __name__ == '__main__':
    unittest.main()
