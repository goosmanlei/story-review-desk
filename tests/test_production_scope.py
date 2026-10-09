"""Disposable exact composition, shared input, history and absence contracts."""
import unittest
import test_audiovisual as fixtures
from review_desk import production as p, ui_projection as ui
from review_desk.production_scope import projection, graph


class ProductionScopeTest(unittest.TestCase):
    setUp=fixtures.AudiovisualTest.setUp; tearDown=fixtures.AudiovisualTest.tearDown; spec=fixtures.AudiovisualTest.spec; put=fixtures.AudiovisualTest.put; ref=fixtures.AudiovisualTest.ref
    setup_story=fixtures.AudiovisualTest.setup_story; shot=fixtures.AudiovisualTest.shot; composition=fixtures.AudiovisualTest.composition; need=fixtures.AudiovisualTest.need

    def split(self):
        self.composition()
        self.put(self.shot('other-shot', self.sources[:1]))
        scene=p.record(self.store,'av-scene')['payload']
        self.put(self.spec('other-scene','AV_SCENE',**{**scene,'shots':[self.ref('other-shot')]}))
        self.store.put_object('av-episode','AV_EPISODE',{
            **p.record(self.store,'av-episode')['payload'],'scenes':[self.ref('av-scene'),self.ref('other-scene')]},expected_version=1)
        self.put(self.need('first'))
        need=self.need('second');need['payload']['scope']=self.ref('other-shot');self.put(need)
        return ui.material_entries(self.store)

    def test_split_and_cross_source_never_invert_sources_or_expand_siblings(self):
        entries=self.split();r=projection(self.store,entries)
        uses={v['object_id']:{l['scene'] for l in v['locations']} for v in r['entries']}
        self.assertEqual(uses['first'],{'av-scene'});self.assertEqual(uses['second'],{'other-scene'})
        _,positions=graph(self.store)
        cross=next(row for row,_ in positions if row['object_id']=='av-scene')
        self.assertEqual({s['scene_id'] for s in cross['payload']['sources']},{'scene','second'})

    def test_shared_concrete_input_keeps_identity_global_alternative_stays_unassigned(self):
        self.split()
        for oid in ('master','old-alternative'):
            spec=self.need(oid);spec['payload']['scope']=self.ref('story');self.put(spec)
        # A global master is reachable from both concrete consumers; a global
        # alternative edge alone must never turn into their scene membership.
        for oid in ('first','second'):
            row=p.record(self.store,oid);self.store.put_object(oid,'REQUIREMENT',{**row['payload'],'generation':{**row['payload']['generation'],'inputs':[{'reference':self.ref('master')}] }},expected_version=row['version'])
        self.store.put_object('global-edge','MATERIAL_RELATION',{'title':'global alternative','upstream':self.ref('old-alternative'),'downstream_id':'master','context':self.ref('story'),'semantics':'alternative'})
        with p.read_scope(self.store):
            r=projection(self.store,ui.material_entries(self.store));byid={v['object_id']:v for v in r['entries']}
        self.assertEqual({l['scene'] for l in byid['master']['locations']},{'av-scene','other-scene'})
        self.assertEqual(byid['old-alternative']['locations'],[])
        self.assertTrue(p.record(self.store,'global-edge'))

    def test_explicit_voice_and_continuity_entities_survive_without_picture_presence(self):
        self.composition()
        self.store.put_object('voice','ENTITY',{'title':'voice','sources':[]})
        self.store.put_object('continuity','STATE',{'title':'continuity','entity':self.ref('voice')})
        row=p.record(self.store,'av-shot');self.store.put_object('av-shot','AV_SHOT',{
            **row['payload'],'continuity_context':[self.ref('continuity')]},expected_version=1)
        sc=p.record(self.store,'av-scene');self.store.put_object('av-scene','AV_SCENE',{**sc['payload'],'shots':[self.ref('av-shot')]},expected_version=1)
        ep=p.record(self.store,'av-episode');self.store.put_object('av-episode','AV_EPISODE',{**ep['payload'],'scenes':[self.ref('av-scene')]},expected_version=1)
        r=projection(self.store,[]);self.assertEqual({l['scene'] for l in r['entity_locations']['voice']},{'av-scene'})
        self.assertEqual(r['entity_locations']['voice'][0]['reference']['revision_id'],self.ref('voice')['revision_id'])

    def test_exact_old_episode_keeps_old_children_after_new_design_and_scope(self):
        self.split();old=self.ref('av-episode');oldshot=self.ref('av-shot')
        shot=self.shot();shot['expected_version']=1;shot['payload']['purpose']='new design';self.put(shot)
        sc=p.record(self.store,'av-scene');self.store.put_object('av-scene','AV_SCENE',{**sc['payload'],'shots':[self.ref('av-shot')]},expected_version=1)
        ep=p.record(self.store,'av-episode');self.store.put_object('av-episode','AV_EPISODE',{**ep['payload'],'scenes':[self.ref('av-scene')]},expected_version=ep['version'])
        _,historical=graph(self.store,old['object_id'],old['revision_id'],'other-scene')
        self.assertIn(oldshot['revision_id'],{row['id'] for row,_ in historical})
        self.assertNotIn('other-scene',{loc['scene'] for _,loc in graph(self.store)[1]})
        with self.assertRaisesRegex(ValueError,'所属'):graph(self.store,scene='av-scene')
        with self.assertRaisesRegex(ValueError,'不属于'):graph(self.store,'av-episode',scene='other-scene')
        with self.assertRaises((KeyError,ValueError)):graph(self.store,'av-episode','missing')

    def test_empty_catalog_and_unassigned_search_remain_available_without_write(self):
        before=list(self.store.db.execute('SELECT id,current_revision FROM objects ORDER BY id'))
        self.assertEqual(graph(self.store),([],[]))
        self.assertEqual(projection(self.store,[{'canonical_material_id':'unassigned','object_id':'unassigned'}])['entries'][0]['locations'],[])
        self.assertEqual(list(self.store.db.execute('SELECT id,current_revision FROM objects ORDER BY id')),before)
