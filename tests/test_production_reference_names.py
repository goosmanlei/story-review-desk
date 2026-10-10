"""Accurate dependency names are a read projection, never a history rewrite."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from review_desk import production
from review_desk.bundle import export
from review_desk.store import Store


class ProductionReferenceNamesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def put(self, oid, kind, title, expected_version=0, **fields):
        payload = {'format': 'production-' + production.KINDS[kind] + '-v1',
                   'title': title, 'blocks': [{'id': 'note', 'text': 'Technical names fixture'}], **fields}
        result = production.import_records(self.store, {'format': 'production-import-v1', 'records': [
            {'object_id': oid, 'kind': kind, 'expected_version': expected_version, 'payload': payload}]})
        return {'object_id': oid, 'revision_id': result['records'][0]['revision']}

    def entity(self, title, expected_version=0):
        return self.put('entity', 'ENTITY', title, expected_version, entity_type='prop', subtype='technical',
                        aliases=[], facts=[], choices=[], unknowns=[], sources=[])

    def representation(self, oid, entities, sources=None):
        return self.put(oid, 'ENTITY', oid, entity_type='prop', subtype='fixture', aliases=[], facts=[], entities=entities, sources=sources or [], choices=[], unknowns=[])

    def test_old_and_current_names_are_exact_and_deduplicated_without_payload_or_export_changes(self):
        old = self.entity('Original exact name')
        old_detail = self.representation('old-detail', [old, old])
        new = self.entity('Renamed current head', 1)
        self.representation('mixed-detail', [old, new])
        before = '\n'.join(self.store.db.iterdump())
        original_payload = copy.deepcopy(production.record(self.store, revision_id=old_detail['revision_id'])['payload'])
        before_manifest = export(self.store, self.root / 'export')
        exact = production.snapshot(self.store, object_id='old-detail')
        self.assertEqual(exact['reference_titles'], [{**old, 'title': 'Original exact name'}])
        mixed = production.snapshot(self.store, object_id='mixed-detail')
        self.assertEqual({row['revision_id']: row['title'] for row in mixed['reference_titles']},
                         {old['revision_id']: 'Original exact name', new['revision_id']: 'Renamed current head'})
        self.assertTrue(all(set(row) == {'object_id', 'revision_id', 'title'} for row in mixed['reference_titles']))
        self.assertEqual(exact['record']['payload'], original_payload)
        self.assertEqual('\n'.join(self.store.db.iterdump()), before)
        self.assertEqual(export(self.store, self.root / 'export'), before_manifest)
        stored = json.loads((self.root / 'export/objects.json').read_text())
        self.assertNotIn('reference_titles', json.dumps(stored))
        self.assertNotIn('reference_titles', production.snapshot(self.store))

    def test_source_document_and_old_episode_names_preserve_exact_reference_paths(self):
        source = {'id': 'source', 'title': 'Exact source title', 'version_type': 'technical',
                  'origin': 'fixture', 'source_url': 'https://example.com/fixture',
                  'collected_at': '2026-01-01', 'blocks': [{'id': 'a', 'text': 'Technical source'}],
                  'notes': 'Technical fixture', 'assets': []}
        self.store.put_source(source)
        source_ref = {'object_id': 'source', 'revision_id': production.record(self.store, 'source')['id']}
        old_episode = self.store.put_object('episode', 'EPISODE', {'title': 'Episode original', 'blocks': [{'id': 'a', 'text': 'Scene text'}], 'scenes': [{'id': 'scene', 'block_ids': ['a']}]})
        episode_ref = {'object_id': 'episode', 'revision_id': old_episode['revision'], 'scene_id': 'scene', 'block_ids': ['a']}
        self.representation('source-detail', [], [source_ref, episode_ref])
        self.store.put_object('episode', 'EPISODE', {'title': 'Episode renamed', 'blocks': [{'id': 'a', 'text': 'Scene text'}], 'scenes': [{'id': 'scene', 'block_ids': ['a']}]}, expected_version=1)
        detail = production.snapshot(self.store, object_id='source-detail')
        self.assertEqual({row['object_id']: row['title'] for row in detail['reference_titles']},
                         {'source': 'Exact source title', 'episode': 'Episode original'})
        self.assertEqual(detail['record']['payload']['sources'], [source_ref, episode_ref])
        self.assertEqual(production.record(self.store, revision_id=source_ref['revision_id'])['payload'],
                         {'source_revision': self.store.db.execute('SELECT revision FROM sources WHERE id=?', ('source',)).fetchone()[0]})

    def test_same_title_different_objects_and_revisions_do_not_collapse_identity(self):
        old = self.entity('Same visible title')
        other = self.put('other', 'ENTITY', 'Other visible title', entity_type='prop', subtype='technical', aliases=[], facts=[], choices=[], unknowns=[], sources=[])
        # Distinct stable entities have an existing alias uniqueness contract;
        # equal titles here are successive revisions of the same entity.
        new = self.entity('Same visible title', 1)
        self.representation('detail', [old, new, other])
        detail = production.snapshot(self.store, object_id='detail')
        titles = detail['reference_titles']
        self.assertEqual(len(titles), 3)
        self.assertEqual({(row['object_id'], row['revision_id']) for row in titles},
                         {(ref['object_id'], ref['revision_id']) for ref in [old, new, other]})
        self.assertEqual(len({row['revision_id'] for row in titles}), 3)


if __name__ == '__main__':
    unittest.main()
