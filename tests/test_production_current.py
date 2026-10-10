import copy
import json
import shutil
import unittest

from test_generation import GenerationTest
from test_methods import seed
from review_desk import production as p, production_current as c, production_current_migration as migration
from review_desk import production_operations as operations, generation, methods, method_media
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict
from review_desk.review_text import production_text_blocks


class CurrentProductionTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','setup_plans','media'):
        locals()[name] = getattr(GenerationTest, name)

    def migrate(self, activate=False):
        self.setup_plans()
        self.component = self.media()
        if activate:
            seed(self.store, 'media-plan', ['draft','review','result'])
            method_media.activate(self.store)
        plan = migration.plan(self.store)
        migration.apply(self.store, plan)
        return plan

    def author(self, prompt, step):
        row = p.record(self.store, 'need-full-overall')
        payload = copy.deepcopy(row['payload'])
        payload.pop('method_adjustment', None)
        payload['generation']['prompt'] = prompt
        prepared = method_media.prepare(self.store, {'object_id': row['object_id'], 'payload': payload,
                    'expected_version': row['version'], 'run_id': 'current-test', 'step_id': step})
        request, execution = prepared['request'], prepared['execution']
        for stage in ('draft','review','result'):
            result = methods.artifact(self.store, {**request, 'execution': methods.reference(execution), 'stage': stage,
                          'output': {'assessment': '回听范围保持准确；本步骤没有模型调用。'} if stage=='review' else method_media.output(payload)})
        payload['method_basis'] = {'execution': methods.reference(execution), 'artifact': methods.reference(result),
                                   'run_id': 'current-test', 'step_id': step}
        self.put({'object_id': row['object_id'], 'kind': 'REQUIREMENT', 'expected_version': row['version'], 'payload': payload})
        return p.record(self.store, row['object_id'])

    def submit(self, oid):
        need = p.record(self.store, 'need-full-overall')
        package = generation.package(self.store, need['object_id'])
        request = {'id':'submit-'+oid, 'call_id': oid, 'requirement_id': need['object_id'], 'tool':'test',
                   'expected_content':c.marker(need), 'package_sha256':c.checksum(package)}
        return request, operations.submit(self.store, request)

    def result(self, oid):
        call = p.record(self.store, oid)
        need = p.record(self.store, 'need-full-overall')
        asset = self.spec('asset-'+oid, 'ASSET', media_type='audio', subjects=[self.ref('songbook')], states=[self.ref('full')],
                         components=[self.component], production=self.ref(oid), lineage={}, candidate_requirements=[self.ref(need['object_id'])],
                         state_coverage=[{'state':self.ref('full'), 'role':'overall', 'component_id':self.component['id'], 'detail':'隔离模拟原件'}])
        self.put(asset)
        payload = copy.deepcopy(call['payload']);payload.update(status='completed',outputs=[self.ref('asset-'+oid)])
        self.put({'object_id':oid,'kind':'CALL','expected_version':call['version'],'payload':payload})
        return p.record(self.store,'asset-'+oid)

    def test_inflight_methods_replays_and_reuse(self):
        self.migrate(True)
        first = self.author('方案 A：单次翻页。', 'a')
        request, submitted = self.submit('a')
        self.author('方案 B：翻页后停顿。', 'b')
        asset = self.result('a')
        context = c.candidate_context(self.store,asset)
        self.assertEqual(context['call']['payload']['prompt'], '方案 A：单次翻页。')
        self.assertTrue(operations.submit(self.store,request)['already_applied'])
        with self.assertRaises(Conflict): operations.submit(self.store,{**request,'tool':'other'})
        for oid in ('b1','b2'):
            self.submit(oid);self.result(oid)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM production_candidates').fetchone()[0],4)
        self.author('方案 C：一段全新的当前说明。','c')
        need=p.record(self.store,first['object_id'])
        self.assertEqual(need['id'],first['id'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM revisions WHERE object_id=?',(need['object_id'],)).fetchone()[0],1)
        notes=[json.loads(r['payload']) for r in self.store.revisions() if r['object_id'].startswith('method.')]
        self.assertFalse(any('方案 C' in json.dumps(n,ensure_ascii=False) for n in notes))
        reuse={'id':'reuse-a','requirement_id':need['object_id'],'expected_content':c.marker(need),'candidate_id':asset['candidate_id']}
        operations.reuse(self.store,reuse)
        self.assertEqual(p.record(self.store,need['object_id'])['payload']['generation']['prompt'],'方案 A：单次翻页。')
        self.assertEqual(c.candidate_context(self.store,asset)['call']['payload']['prompt'],'方案 A：单次翻页。')
        self.assertTrue(operations.reuse(self.store,reuse)['already_applied'])
        with self.assertRaises(Conflict): operations.reuse(self.store,{**reuse,'id':'reuse-stale'})

    def test_comments_migration_failure_and_two_recoveries(self):
        self.setup_plans();self.component=self.media()
        plan=migration.plan(self.store)
        with self.assertRaises(RuntimeError): migration.apply(self.store,plan,fault='after-snapshots')
        self.assertEqual(migration.inventory(self.store),plan['inventory'])
        row=p.record(self.store,'full');payload=copy.deepcopy(row['payload']);payload['production_description']='并发编辑'
        self.put({'object_id':row['object_id'],'kind':'STATE','expected_version':row['version'],'payload':payload})
        with self.assertRaises(Conflict): migration.apply(self.store,plan)
        plan=migration.plan(self.store);migration.apply(self.store,plan)
        self.assertTrue(migration.apply(self.store,plan)['already_applied'])
        need=p.record(self.store,'need-full-overall')
        block=next(b for b in production_text_blocks(need['payload']) if b.get('field')=='generation.prompt')
        anchor={'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':4,'quote':block['text'][:4]}
        comment=self.store.create_comment({'target_object_id':need['object_id'],'target_revision_id':need['id'],
                   'expected_edit_token':need['edit_token'],'anchor':anchor,'body':'保留动作间隔'})
        payload=copy.deepcopy(need['payload']);payload['generation']['prompt']='新句包含相似的翻页后停，但并非原句。'
        self.put({'object_id':need['object_id'],'kind':'REQUIREMENT','expected_version':need['version'],'payload':payload})
        state=self.store.comment_anchor_states([self.store.comment(comment['id'])])[0]
        self.assertFalse(state['anchor_state']['valid'])
        self.assertEqual(state['original_context']['excerpt']['anchor'],anchor)
        source=self.root
        for n in range(2):
            export(self.store,source/'export')
            destination=self.root/('recovery-'+str(n));recovered=Store(destination/'.runtime/review.sqlite3')
            restore(recovered,source/'export')
            self.store.close();self.store=recovered;source=destination
            row=p.record(self.store,'full');payload=copy.deepcopy(row['payload']);payload['production_description']='恢复后继续编辑 '+str(n)
            self.put({'object_id':row['object_id'],'kind':'STATE','expected_version':row['version'],'payload':payload})
            self.assertFalse(c.comment_context(self.store,self.store.comment(comment['id']))['original_context']['matches_current'])
        self.assertFalse(set(c.LEGACY_TABLES)&{r[0] for r in self.store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")})

    def test_callbacks_unknown_failure_components_and_external_original(self):
        self.migrate()
        _, submitted = self.submit('poll')
        base = {'call_id':'poll','submission_sha256':submitted['submission_sha256']}
        for status in ('unknown', 'failed'):
            result = operations.finish(self.store,{**base,'id':'receipt-'+status,'status':status})
            self.assertIsNone(result['candidate_id'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM production_candidates').fetchone()[0],1)
        asset = copy.deepcopy(p.record(self.store,'voice')['payload'])
        asset.pop('candidate_identity',None)
        asset['candidate_requirements']=[self.ref('need-full-overall')]
        asset['states']=[self.ref('full')]
        asset['state_coverage']=[{'state':self.ref('full'),'role':'overall','component_id':'original','detail':'隔离回执原件'}]
        request = {**base,'id':'receipt-complete','status':'completed','asset':asset,'response':{'id':'provider-result'},'cost':{'credits':0}}
        done = operations.finish(self.store,request)
        self.assertTrue(operations.finish(self.store,request)['already_applied'])
        asset['components'].append({**self.component,'id':'second-output'})
        more = operations.finish(self.store,{**request,'id':'receipt-add-file','asset':asset})
        self.assertEqual(more['candidate_id'],done['candidate_id'])
        self.assertEqual(len(p.record(self.store,'asset-poll')['payload']['components']),2)
        with self.assertRaises(Conflict):operations.finish(self.store,{**base,'id':'late-fail','status':'failed'})
        with self.assertRaises(Conflict):operations.finish(self.store,{**request,'id':'changed-cost','cost':{'credits':8}})
        external=copy.deepcopy(asset);external.pop('production');external['external_source']={'kind':'upload','description':'用户上传的隔离原件'}
        self.put({'object_id':'external','kind':'ASSET','expected_version':0,'payload':external})
        context=c.candidate_context(self.store,p.record(self.store,'external'))
        self.assertIsNone(context['call'])
        self.assertEqual(context['submission']['snapshot']['source'],external['external_source'])

    def test_historical_original_without_call_remains_honest(self):
        self.setup_plans();self.component=self.media()
        original=copy.deepcopy(p.record(self.store,'voice')['payload'])
        original.pop('production')
        # A legacy import predating the production validator may contain an
        # uploaded original without CALL. Migration must not invent one.
        from review_desk.version_consolidation import new_identity
        from review_desk.store import canonical,now
        rid=new_identity(self.store,'legacy-upload',1,original);stamp=now()
        with self.store.db:
            self.store.db.execute('INSERT INTO objects VALUES (?,?,?,?,?,?)',('legacy-upload','ASSET',rid,1,stamp,stamp))
            self.store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)',(rid,'legacy-upload',1,canonical(original),stamp))
        migration.apply(self.store,migration.plan(self.store))
        asset=p.record(self.store,'legacy-upload')
        context=c.candidate_context(self.store,asset)
        self.assertIsNone(context['call'])
        self.assertEqual(context['submission']['origin'],'external')
        self.assertEqual(context['submission']['snapshot']['source']['kind'],'historical')
        self.assertEqual(asset['payload']['components'],original['components'])
        self.assertFalse(context['submission']['snapshot']['request'])

    def test_response_excerpt_survives_later_edit(self):
        from review_desk import comment_review, production_current_comments as excerpts
        from review_desk.store import digest, canonical
        self.migrate()
        need=p.record(self.store,'need-full-overall')
        block=next(b for b in production_text_blocks(need['payload']) if b.get('field')=='generation.prompt')
        anchor={'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':4,'quote':block['text'][:4]}
        comment=self.store.create_comment({'target_object_id':need['object_id'],'target_revision_id':need['id'],
                 'expected_edit_token':need['edit_token'],'anchor':anchor,'body':'保留原动作间隔'})
        payload=copy.deepcopy(need['payload']);payload['generation']['prompt']='整改后的局部文字。'
        self.put({'object_id':need['object_id'],'kind':'REQUIREMENT','expected_version':need['version'],'payload':payload})
        changed=p.record(self.store,need['object_id']);after={**anchor,'quote':'整改后的','end':4}
        ref={'object_id':need['object_id'],'revision_id':need['id']}
        document={'id':'comment-handling-current-test','format':'comment-handling-v1','comment_id':comment['id'],
                  'original':{**ref,'anchor_sha256':digest(canonical(anchor).encode())},'response':ref,
                  'expected_response_content':c.marker(changed),'decision':'revised','explanation':'改为明确的停顿动作。',
                  'evidence':[{**ref,'anchor':after,'label':'实际改后文字'}],
                  'provenance':{'file':'isolated-review.json','sha256':'0'*64}}
        comment_review.import_evidence(self.store,[document])
        self.assertTrue(excerpts.read(self.store,document,'evidence:0',document['evidence'][0])['matches_current'])
        payload['generation']['prompt']='再次修改；有相似文字也不等于当时摘录。'
        self.put({'object_id':need['object_id'],'kind':'REQUIREMENT','expected_version':changed['version'],'payload':payload})
        saved=excerpts.read(self.store,document,'evidence:0',document['evidence'][0])
        self.assertFalse(saved['matches_current']);self.assertEqual(saved['production_excerpt']['anchor']['quote'],'整改后的')

    def test_current_recovery_preserves_story_visuals(self):
        from test_structure import direction, document
        from review_desk.structure import select_direction, import_structure
        self.migrate()
        seed(self.store)
        assets=self.root/'export/assets'
        assets.joinpath('relation.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.store.put_source(direction('direction-a', '方向 A'))
        selected=select_direction(self.store,'direction-a',0)
        result=import_structure(self.store,document(selected['revision']),0)
        comment=self.store.create_comment({'target_object_id':'story-structure','target_revision_id':result['revision'],
            'anchor':{'type':'visual','visual_id':'relation-graph','asset_file':'relation.svg'},'body':'保留旧结构图和意见'})
        manifest=export(self.store,self.root/'export')
        self.assertIn('assets/relation.svg',manifest['files'])
        destination=self.root/'with-story'; recovered=Store(destination/'.runtime/review.sqlite3')
        try:
            restore(recovered,self.root/'export')
            self.assertEqual((destination/'export/assets/relation.svg').read_bytes(),assets.joinpath('relation.svg').read_bytes())
            export(recovered,destination/'export')
            self.assertEqual(recovered.comment(comment['id'])['anchor'],comment['anchor'])
        finally:recovered.close()


if __name__=='__main__': unittest.main()
