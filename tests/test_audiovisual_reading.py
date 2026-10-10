import copy
import json
import shutil
import unittest
import test_audiovisual as fixtures
from review_desk import audiovisual_cleanup as cleanup, audiovisual_notes as notes, production as p, bundle
from review_desk.store import Store, Conflict


class AudiovisualReadingTest(unittest.TestCase):
    setUp = fixtures.AudiovisualTest.setUp
    tearDown = fixtures.AudiovisualTest.tearDown
    spec = fixtures.AudiovisualTest.spec
    put = fixtures.AudiovisualTest.put
    ref = fixtures.AudiovisualTest.ref
    setup_story = fixtures.AudiovisualTest.setup_story
    shot = fixtures.AudiovisualTest.shot
    composition = fixtures.AudiovisualTest.composition
    need = fixtures.AudiovisualTest.need

    def new_reading(self):
        row=p.record(self.store,'av-shot')
        value={k:v for k,v in row['payload'].items() if k not in cleanup.AV_FIELDS}
        value.update(reading_contract='audiovisual-three-part-v1',blocks=[],purpose='女孩珍惜歌本留下的亲情。',
                     products=[{'label':'首帧','requirement':self.ref('frame')},{'label':'字层','requirement':self.ref('text')}],
                     key_states=[{'id':'opening','description':'翻开之前','requirements':[self.ref('frame'),self.ref('text')]}])
        return {'object_id':row['object_id'],'kind':row['kind'],'expected_version':row['version'],'payload':value}

    def test_states_share_one_moment_but_not_duplicate_material_or_other_shot(self):
        self.composition();self.put(self.need('frame'),self.need('text'))
        value=self.new_reading();self.put(value)
        from review_desk.production_breakdown import context
        self.assertEqual([r['object_id'] for r in context(self.store,'av-shot')['requirements']],['frame','text'])
        duplicate=copy.deepcopy(value);duplicate['expected_version']=2
        duplicate['payload']['key_states'].append({'id':'ending','description':'不应复制同一首帧','requirements':[self.ref('frame')]})
        with self.assertRaisesRegex(ValueError,'不重复'):self.put(duplicate)
        foreign=copy.deepcopy(value);foreign['object_id']='other-shot';foreign['expected_version']=0
        with self.assertRaisesRegex(ValueError,'属于本镜头'):self.put(foreign)

    def test_cleanup_restore_preserves_media_and_exact_composition_without_old_prose(self):
        self.composition();self.put(self.need('frame'),self.need('text'))
        old=self.ref('av-shot');material_before=p.record(self.store,'frame')
        self.put(self.new_reading())
        approved=cleanup.plan(self.store,['av-shot','av-scene','av-episode'])
        result=cleanup.apply(self.store,approved)
        self.assertEqual(result['redacted_revisions'],3)
        self.assertEqual(p.record(self.store,'frame'),material_before)
        self.assertNotIn('framing',p.ref_record(self.store,old)['payload'])
        self.assertEqual(p.record(self.store,'av-scene')['payload']['shots'],[old])
        notes.save(self.store,{'object_id':'av-scene','body':'一份当前工作稿','expected_etag':notes.get(self.store,'av-scene')['etag']})
        bundle.export(self.store,self.root/'export')
        dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export');restored=Store(dest/'.runtime/review.sqlite3')
        try:
            bundle.restore(restored,dest/'export')
            self.assertNotIn('framing',p.ref_record(restored,old)['payload'])
            self.assertEqual(notes.get(restored,'av-scene')['body'],'一份当前工作稿')
            self.assertEqual(p.record(restored,'frame')['payload'],material_before['payload'])
            self.assertEqual(cleanup.dump(restored),cleanup.dump(self.store))
            from review_desk.material_model import verify
            verify(restored)
        finally:restored.close()

    def test_new_comment_stops_entire_removal(self):
        self.composition();plan=cleanup.plan(self.store,['av-shot'])
        row=p.record(self.store,'av-shot');block=row['payload']['blocks'][0]
        self.store.create_comment({'target_object_id':'av-shot','target_revision_id':row['id'],
            'anchor':{'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':2,'quote':block['text'][:2]},'body':'必须保留的真实意见'})
        before=self.store.revisions()
        with self.assertRaisesRegex(Conflict,'comments'):cleanup.apply(self.store,plan)
        self.assertEqual(before,self.store.revisions())
        self.assertEqual(cleanup.dump(self.store)['audiovisual_cleanup_receipts'],[])

    def test_cleanup_rejects_changed_facts_and_future_legacy_imports(self):
        self.composition()
        legacy = self.shot()
        cleanup.apply(self.store, cleanup.plan(self.store, ['av-shot']))
        legacy['object_id'] = 'new-legacy-shot'
        with self.assertRaisesRegex(Conflict, 'reimported'):
            self.put(legacy)
        row = dict(self.store.db.execute("SELECT * FROM revisions WHERE object_id='av-shot'").fetchone())
        receipt = dict(self.store.db.execute('SELECT * FROM audiovisual_cleanup_receipts').fetchone())
        payload = json.loads(row['payload']);payload['fps'] = 60
        row['payload'] = json.dumps(payload)
        with self.assertRaisesRegex(ValueError, 'receipt mismatch'):
            cleanup.verify_row(row, receipt)

    def test_working_note_updates_in_place_with_concurrency_and_target_checks(self):
        self.composition();before=len(self.store.revisions());etag=notes.get(self.store,'av-scene')['etag']
        notes.save(self.store,{'object_id':'av-scene','body':'先看见失去的代价','expected_etag':etag})
        with self.assertRaises(Conflict):notes.save(self.store,{'object_id':'av-scene','body':'旧客户端覆盖','expected_etag':etag})
        with self.assertRaises(ValueError):notes.save(self.store,{'object_id':'av-shot','body':'错误归属','expected_etag':etag})
        self.assertEqual(len(self.store.revisions()),before)
        self.assertEqual(len(notes.dump(self.store)),1)


if __name__=='__main__':unittest.main()
