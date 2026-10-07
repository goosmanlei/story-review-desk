import copy
import json
import threading
import unittest
import urllib.request
import test_production as fixtures
from review_desk import production as p, production_breakdown as bd, material_plans as mp
from review_desk.store import Conflict

class BreakdownTest(unittest.TestCase):
    setUp=fixtures.ProductionTest.setUp
    tearDown=fixtures.ProductionTest.tearDown
    spec=fixtures.ProductionTest.spec
    put=fixtures.ProductionTest.put
    ref=fixtures.ProductionTest.ref
    entity=fixtures.ProductionTest.entity
    requirement=fixtures.ProductionTest.requirement
    media=fixtures.ProductionTest.media
    adoption=fixtures.ProductionTest.adoption

    def scene_shot(self):
        self.put(self.spec('scene','PREPARATION',source={**self.source,'block_ids':['a','b']},checked=True,occurrences=[],notes='test'))
        self.put(self.spec('shot','SHOT_DESIGN',episode=self.ref('episode'),parent=self.ref('scene'),scene_id='scene',source=self.source,
            number=1,purpose='a',framing='b',spatial='c',action_start='d',action_end='e',continuity='f',fps=24,duration_frames=120,sound=[],entities=[],states=[]))

    def test_scene_without_redundant_review_text_keeps_source_and_history(self):
        self.scene_shot();old=p.record(self.store,'scene');payload=copy.deepcopy(old['payload']);payload['blocks']=[]
        self.put({'object_id':'scene','kind':'PREPARATION','expected_version':old['version'],'payload':payload})
        self.assertEqual(p.record(self.store,'scene')['payload']['source'],old['payload']['source'])
        self.assertEqual(p.record(self.store,revision_id=old['id'])['payload']['blocks'],old['payload']['blocks'])
        entity=self.entity();entity['payload']['blocks']=[]
        with self.assertRaises(ValueError):self.put(entity)

    def test_direct_parent_and_exact_historical_context_survive_reorder(self):
        self.scene_shot();old=self.ref('shot');self.put(self.requirement(scope='shot'))
        self.media();self.put(self.adoption(scope='shot'))
        shot=p.record(self.store,'shot')
        self.put({**self.spec('shot','SHOT_DESIGN'), 'expected_version':shot['version'],'payload':{**shot['payload'],'number':8}})
        before=bd.context(self.store,'shot',old['revision_id']);after=bd.context(self.store,'shot')
        self.assertEqual(len(before['requirements']),1);self.assertEqual(len(before['adoptions']),1)
        self.assertEqual(after['requirements'],[]);self.assertEqual(after['adoptions'],[])
        self.assertEqual(before['ancestors'][1],self.ref('scene'))
        self.assertEqual(before['record']['payload']['number'],1)

    def test_applicability_is_neither_occurrence_nor_actual_input(self):
        self.scene_shot();self.put(self.entity());self.put(self.requirement())
        self.put(self.spec('shared','RELATION',relation_type='applicability',scope=self.ref('shot'),subject=self.ref('dialogue'),basis='production_choice',reason='shared demand'))
        context=bd.context(self.store,'shot')
        self.assertEqual([r['object_id'] for r in context['requirements']],['dialogue'])
        self.assertFalse(context['entities']);self.assertFalse(context['adoptions'])
        listed=bd.materials(self.store,episode='episode',scene='scene')
        self.assertEqual(listed['total'],1)
        self.assertFalse(bd.materials(self.store,episode='other')['items'])
        summary=bd.summary(self.store,'scene')
        self.assertEqual(summary['descendant_positions'],[self.ref('shot')]);self.assertEqual(summary['direct_requirements'],[])

    def test_historical_parent_chain_does_not_follow_the_current_input_lock(self):
        self.store.put_object('story','STORY',{'title':'original screenplay','blocks':[]})
        lock=self.spec('lock','INPUT_LOCK',screenplay=self.ref('story'),episodes=[self.ref('episode')],
            approval={'actor':'fixture','statement':'fixture only','scope':'one episode'},specification={})
        self.put(lock);old_lock=self.ref('lock');self.scene_shot()
        scene=p.record(self.store,'scene')
        self.put({'object_id':'scene','kind':'PREPARATION','expected_version':scene['version'],
            'payload':{**scene['payload'],'input_lock':old_lock}})
        exact=self.ref('scene');before=bd.context(self.store,'scene',exact['revision_id'])['ancestors']
        other=self.store.put_object('other-episode','EPISODE',{'title':'later','blocks':[],'scenes':[]})
        self.put({**lock,'expected_version':1,'payload':{**lock['payload'],'episodes':[self.ref('other-episode')]}})
        self.assertEqual(bd.context(self.store,'scene',exact['revision_id'])['ancestors'],before)
        self.assertIn(old_lock,before)
        wrong={**scene['payload'],'input_lock':self.ref('lock')}
        with self.assertRaisesRegex(ValueError,'exact episode'):
            self.put({'object_id':'scene','kind':'PREPARATION','expected_version':2,'payload':wrong})

    def test_parent_revision_and_occurrence_validation_are_atomic(self):
        self.scene_shot();self.put(self.entity())
        value=self.spec('occ','RELATION',relation_type='occurrence',scope=self.ref('shot'),subject=self.ref('songbook'),mode='mention',basis='source_fact',reason='spoken only',sources=[self.source])
        self.put(value)
        context=bd.context(self.store,'shot')
        self.assertEqual(context['entities'][0]['object_id'],'songbook')
        self.assertEqual(context['occurrences'][0]['mode'],'mention')
        self.assertEqual(bd.summary(self.store,'scene')['derived_entities'],[self.ref('songbook')])
        shot=p.record(self.store,'shot');payload=copy.deepcopy(shot['payload']);payload['episode']=self.ref('songbook')
        with self.assertRaises(ValueError):self.put({'object_id':'shot','kind':'SHOT_DESIGN','expected_version':1,'payload':payload})
        self.assertEqual(p.record(self.store,'shot')['id'],shot['id'])

    def test_migration_preserves_concurrent_comment_and_rejects_corrupt_batch(self):
        self.put(self.entity());self.put(self.requirement());self.media()
        # Simulate pre-schema5 data; exact historical records remain unchanged.
        for table in reversed(mp.TABLES):self.store.db.execute('DELETE FROM '+table)
        self.store.db.commit();plan=mp.migration_plan(self.store)
        comment=self.store.create_comment({'id':'concurrent','target_object_id':'songbook','target_revision_id':self.ref('songbook')['revision_id'],'anchor':{'type':'global'},'body':'keep me'})
        bad=copy.deepcopy(plan);bad['additions']['material_candidate_members'][0]['candidate_id']='forged'
        before='\n'.join(self.store.db.iterdump())
        with self.assertRaises(ValueError):mp.migrate(self.store,bad)
        self.assertEqual('\n'.join(self.store.db.iterdump()),before)
        mp.migrate(self.store,plan);self.assertEqual(self.store.comment('concurrent'),comment)
        done=mp.dump(self.store);self.assertTrue(mp.migrate(self.store,plan)['already_applied']);self.assertEqual(done,mp.dump(self.store))

    def test_scoped_http_and_migration_envelope(self):
        from review_desk.server import ReviewServer
        ep=p.record(self.store,'episode')
        self.store.put_object('episode','EPISODE',{**ep['payload'],'number':1},expected_version=ep['version'])
        self.source['revision_id']=self.ref('episode')['revision_id']
        self.store.put_object('story','STORY',{'title':'screenplay','blocks':[]})
        self.put(self.spec('lock','INPUT_LOCK',screenplay=self.ref('story'),episodes=[self.ref('episode')],
            approval={'actor':'fixture','statement':'fixture only','scope':'one episode'},specification={}))
        with self.assertRaisesRegex(ValueError, 'unknown production index'): bd.index(self.store,'history')
        self.scene_shot();self.put(self.requirement(scope='shot'))
        for table in reversed(mp.TABLES):self.store.db.execute('DELETE FROM '+table)
        self.store.db.commit()
        with ReviewServer(('127.0.0.1',0),self.root,{'id':'test','title':'test'}) as server:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));out={}
            def request(path,data=None):
                raw=None if data is None else json.dumps(data).encode()
                with opener.open(urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/production/'+path,data=raw),timeout=5) as response:
                    return json.load(response)
            def client():
                try:
                    out['catalog']=request('breakdown?episode=episode')
                    out['context']=request('context?object_id=shot')
                    out['materials']=request('materials?episode=episode&scene=scene&offset=0')
                    out['empty']=request('materials?episode=other')
                    plan=request('material-plan-map')
                    out['validation']=request('material-plan-migrate',{'migration':plan,'validate_only':True})
                    out['after']=request('material-plan-map')
                except Exception as exc:out['error']=repr(exc)
            worker=threading.Thread(target=client,daemon=True);worker.start();server.timeout=2
            for _ in range(7):server.handle_request()
            worker.join(timeout=6)
            self.assertFalse(worker.is_alive());self.assertNotIn('error',out)
            self.assertEqual([r['object_id'] for r in out['catalog']['shots']],['shot'])
            self.assertEqual(out['context']['ancestors'][1],self.ref('scene'))
            self.assertEqual(out['materials']['total'],1);self.assertEqual(out['empty']['total'],0)
            self.assertTrue(out['validation']['validated_only'])
            self.assertTrue(out['after']['additions']['material_plan_versions'])

if __name__=='__main__':unittest.main()
