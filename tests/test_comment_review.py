"""Exact evidence, immutable originals and comment-state boundaries."""
import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from review_desk.bundle import export, restore
from review_desk.comment_review import content, import_evidence, snapshot
from review_desk.store import Store, Conflict, canonical, digest
from review_desk.structure import import_structure, select_direction
from test_structure import direction, document


class CommentReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / 'export/assets'
        self.assets.mkdir(parents=True)
        (self.assets / 'relation.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.store = Store(self.root / '.runtime/review.sqlite3')
        self.store.put_source(direction('a', 'Original direction'))
        selected = select_direction(self.store, 'a', 0)
        self.first = import_structure(self.store, document(selected['revision']), 0)
        self.comment = self.store.create_comment({
            'target_object_id': 'story-structure', 'target_revision_id': self.first['revision'],
            'anchor': {'type': 'region', 'visual_id': 'relation-graph', 'asset_file': 'relation.svg',
                       'points': [{'x': .1, 'y': .1}, {'x': .8, 'y': .1}, {'x': .8, 'y': .8}]},
            'body': 'Keep the original region'})
        self.second = import_structure(self.store, document(selected['revision'], self.first['revision'],
            [{'comment_id': self.comment['id'], 'explanation': 'Only partially adopted'}], True), 1)
        self.third = import_structure(self.store, document(selected['revision'], self.second['revision']), 2)
        self.evidence = {
            'id': 'comment-handling-region', 'format': 'comment-handling-v1', 'comment_id': self.comment['id'],
            'original': {'object_id': 'story-structure', 'revision_id': self.first['revision'],
                         'anchor_sha256': digest(canonical(self.comment['anchor']).encode())},
            'response': {'object_id': 'story-structure', 'revision_id': self.second['revision']},
            'provenance': {'file': 'author.json', 'sha256': 'a' * 64},
            'evidence': [{'object_id': 'story-structure', 'revision_id': self.second['revision'],
                          'anchor': {'type': 'visual', 'visual_id': 'relation-graph', 'asset_file': 'relation.svg'},
                          'label': 'Changed image'}]}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_response_without_current_evidence_never_becomes_resolved(self):
        before = self.store.comment(self.comment['id'])
        events = self.store.events()
        self.assertEqual(import_evidence(self.store, [self.evidence])['added'], 1)
        self.assertEqual(import_evidence(self.store, [self.evidence])['added'], 0)
        row = snapshot(self.store, 'story-structure', self.third['revision'])['reviews'][0]
        self.assertEqual(row['comment']['status'], 'OPEN')
        self.assertEqual(row['current_evidence'], [])
        self.assertEqual(row['responses'][0]['response']['revision_id'], self.second['revision'])
        self.assertEqual(row['comment']['anchor'], before['anchor'])
        self.assertEqual(self.store.comment(self.comment['id']), before)
        self.assertEqual(self.store.events(), events)
        self.assertEqual(len(snapshot(self.store, 'story-structure', self.first['revision'])['reviews']), 1)

    def test_validation_is_atomic_and_refuses_wrong_comment_anchor_revision_and_response(self):
        for mutate in [lambda r: r['original'].update(anchor_sha256='b' * 64),
                       lambda r: r['evidence'][0].update(revision_id='missing'),
                       lambda r: r.update(explanation='Invented author acceptance')]:
            invalid = copy.deepcopy(self.evidence); invalid['id'] = 'comment-handling-invalid'; mutate(invalid)
            before = self.store.objects()
            with self.assertRaises((ValueError, Conflict)):
                import_evidence(self.store, [self.evidence, invalid])
            self.assertEqual(self.store.objects(), before)
        import_evidence(self.store, [self.evidence])
        changed = copy.deepcopy(self.evidence); changed['provenance']['file'] = 'other.json'
        with self.assertRaises(Conflict): import_evidence(self.store, [changed])

    def test_exact_source_unicode_quotes_state_conflict_and_export_restore(self):
        old = {**direction('old', 'Old novel'), 'group': 'story-refinements',
               'blocks': [{'id': 'one', 'text': '🙂下午多添'}]}
        new = {**direction('new', 'New novel'), 'group': 'story-refinements',
               'blocks': [{'id': 'one', 'text': '🙂先前多添'}]}
        self.store.put_source(old); self.store.put_source(new)
        old_id = self.store.db.execute("SELECT current_revision FROM objects WHERE id='old'").fetchone()[0]
        new_id = self.store.db.execute("SELECT current_revision FROM objects WHERE id='new'").fetchone()[0]
        anchor = {'type': 'text', 'block_id': 'one', 'end_block_id': 'one', 'start': 1, 'end': 5, 'quote': '下午多添'}
        comment = self.store.create_comment({'source_id': 'old', 'anchor': anchor, 'body': 'Time reference'})
        evidence = copy.deepcopy(self.evidence)
        evidence.update(id='comment-handling-source', comment_id=comment['id'], decision='Partial adoption', explanation='Original author choice')
        evidence['original'] = {'object_id': 'old', 'revision_id': old_id, 'anchor_sha256': digest(canonical(anchor).encode())}
        evidence['response'] = {'object_id': 'new', 'revision_id': new_id}
        evidence['evidence'] = [{'object_id': 'new', 'revision_id': new_id,
                                'anchor': {**anchor, 'quote': '先前多添'}, 'label': 'Actual change'}]
        import_evidence(self.store, [evidence])
        row = snapshot(self.store, 'new', new_id)['reviews'][0]
        self.assertEqual(row['current_evidence'][0]['anchor']['quote'], '先前多添')
        self.assertEqual(content(self.store, 'old', old_id)['record']['payload']['blocks'], old['blocks'])
        with self.assertRaises(ValueError): content(self.store, 'old', new_id)
        self.store.change_comment(comment['id'], 'CLOSE', 1)
        with self.assertRaises(Conflict): self.store.change_comment(comment['id'], 'REOPEN', 1)
        self.assertEqual(snapshot(self.store, 'new', new_id)['reviews'][0]['comment']['status'], 'CLOSED')
        self.store.change_comment(comment['id'], 'REOPEN', 2)
        export(self.store, self.root / 'export')
        recovered = Store(self.root / 'recovered/.runtime/review.sqlite3')
        try:
            shutil.copytree(self.assets, self.root / 'recovered/export/assets')
            restore(recovered, self.root / 'export')
            result = snapshot(recovered, 'new', new_id)['reviews'][0]
            self.assertEqual(result['comment']['anchor'], anchor)
            self.assertEqual(result['comment']['status'], 'OPEN')
            self.assertEqual(result['responses'][0]['decision'], 'Partial adoption')
        finally: recovered.close()


if __name__ == '__main__': unittest.main()
