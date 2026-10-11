"""Exact material search, reusable scope catalogs and cold fallback contracts."""
import copy
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import test_production_scope as scope_fixture
import test_unified_relations as relation_fixture
from review_desk import production as p, ui_projection as ui, list_reading as light
from review_desk import material_storage, read_cache, material_relations


class MaterialFacetTest(unittest.TestCase):
    def test_facets_relax_one_filter_and_count_exact_location_pairs_once(self):
        values = [dict(id=name, search_fields=[name], media_type=media,
                       generated=generated, locations=[dict(episode=ep, scene=sc) for ep, sc in pairs])
                  for name, media, generated, pairs in [
                      ('a', 'image', True, [('e1', 's1'), ('e2', 's2'), ('e2', 's2')]),
                      ('b', 'audio', False, [('e1', 's2')]),
                      ('c', 'image', False, [('e1', 's1')]),
                      ('d', 'image', True, [])]]
        facets, result = ui._material_filter_facets(
            values, dict(episode=None, scene=None, media=None, status=None), '')
        self.assertEqual(len(result), 4)
        self.assertEqual(facets, {'media': {'': 4, 'audio': 1, 'image': 3},
                                 'status': {'': 4, 'generated': 2, 'ungenerated': 2},
                                 'episode': {'': 4, 'e1': 3, 'e2': 1},
                                 'scene': {'': 4, 's1': 2, 's2': 2}})
        facets, result = ui._material_filter_facets(
            values, dict(episode='e1', scene='s2', media='image', status='generated'), '')
        self.assertEqual(result, [])  # a has s2 only in e2.
        self.assertEqual(facets['episode'], {'': 1, 'e1': 0, 'e2': 1})
        self.assertEqual(facets['scene'], {'': 1, 's1': 1, 's2': 0})
        self.assertEqual(facets['media'], {'': 0, 'audio': 0, 'image': 0})
        self.assertEqual(facets['status'], {'': 0, 'generated': 0, 'ungenerated': 0})
        facets, result = ui._material_filter_facets(
            values, dict(episode=None, scene=None, media=None, status=None), 'absent')
        self.assertEqual(result, [])
        self.assertTrue(all(count == 0 for options in facets.values() for count in options.values()))


class MaterialCatalogTest(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'setup_story',
                 'shot', 'composition', 'need', 'split'):
        locals()[name] = getattr(scope_fixture.ProductionScopeTest, name)

    def query(self, **filters):
        with p.read_scope(self.store):
            return ui.material_list(self.store, scope='av', grouped=True,
                                    compact=True, **filters)

    def test_new_words_and_scene_media_filters_reuse_one_exact_catalog(self):
        self.split();read_cache.attach(self.store)
        from review_desk.production_scope import projection
        with patch('review_desk.production_scope.projection', wraps=projection) as reader:
            for filters in ({'search':'first'}, {'search':'second'},
                            {'search':'absent'}, {'scene':'av-scene', 'media':'image'},
                            {'scene':'other-scene', 'status':'ungenerated'}):
                self.query(episode='av-episode', **filters)
            self.assertEqual(reader.call_count, 1)
        with self.assertRaisesRegex(ValueError, '不属于'):
            self.query(episode='av-episode', scene='absent')
        with self.assertRaisesRegex(ValueError, '所属'):
            self.query(scene='av-scene')

    def test_failed_cache_reads_writes_and_disabled_cache_keep_every_result(self):
        self.split();expected={}
        filters=[{}, {'search':'absent'}, {'media':'image'},
                 {'scene':'other-scene'}, {'status':'generated'},
                 {'media':'image','status':'ungenerated'}]
        for i, f in enumerate(filters):expected[i]=self.query(episode='av-episode',**f)
        read_cache.attach(self.store)
        for mode in ('normal', 'unavailable', 'disabled'):
            cache=self.store.read_cache
            if mode=='disabled':self.store.read_cache=None
            try:
                with ExitStack() as stack:
                    if mode=='unavailable':
                        stack.enter_context(patch.object(cache,'get',return_value=None))
                        stack.enter_context(patch.object(cache,'put',return_value=None))
                    for i,f in enumerate(filters):self.assertEqual(self.query(episode='av-episode',**f),expected[i])
            finally:self.store.read_cache=cache

    def test_committed_name_change_invalidates_catalog_and_rollback_does_not(self):
        self.split();read_cache.attach(self.store)
        old=self.ref('first');before=self.query(search='unique new name')
        row=p.record(self.store,'first');document={'format':'production-import-v1','records':[
            {'object_id':'first','kind':'REQUIREMENT','expected_version':row['version'],
             'payload':{**row['payload'],'title':'unique new name'}}]}
        p.import_records(self.store,document,validate_only=True)
        self.assertEqual(self.query(search='unique new name'),before)
        p.import_records(self.store,document)
        self.assertEqual(self.query(search='unique new name')['total'],1)
        self.assertEqual(p.ref_record(self.store,old)['payload']['title'],row['payload']['title'])

    def test_batch_identity_is_identical_to_individual_authoritative_reads(self):
        self.split()
        ids=[v['object_id'] for v in ui.material_entries(self.store)]
        expected={mid:material_storage.identity(self.store,mid) for mid in ids}
        with p.read_scope(self.store):
            actual={mid:material_storage.identity(self.store,mid) for mid in ids}
        self.assertEqual(actual,expected)

    def test_cards_transport_keeps_filters_groups_and_exact_open_references(self):
        self.split()
        for filters in ({}, {'search':'absent'}, {'media':'image'},
                        {'scene':'other-scene'}, {'status':'generated'}):
            full=self.query(episode='av-episode',**filters)
            cards=self.query(episode='av-episode',cards=True,**filters)
            expected={**full,'items':[{k:v for k,v in item.items() if k not in ('locations','search_fields')}
                                     for item in full['items']]}
            self.assertEqual(cards,expected)
        with self.assertRaisesRegex(ValueError,'grouped compact'):
            ui.material_list(self.store,cards=True)


class MaterialInputMetadataTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need',
                 'setup_plans','media','relation'):
        locals()[name]=getattr(relation_fixture.UnifiedRelationsTest,name)

    def test_metadata_preserves_rules_exact_endpoints_and_historical_relation(self):
        self.setup_plans();rel=self.relation(['need-full-overall','need-wet-overall']);self.put(rel)
        item={'reference':self.ref('need-full-overall'),'relation':self.ref(rel['object_id']),
              'semantics':'reference','necessity':'optional','enabled':False}
        for change in ({},{'enabled':True},{'necessity':'conditional','condition':'rain'},
                       {'necessity':'one_of','group':'voice','route':'a'}):
            plan={'inputs':[{**item,**change}],'conditions':{'rain':True},'selected_routes':{'voice':'a'}}
            with p.read_scope(self.store):
                self.assertEqual(material_relations.active_inputs(self.store,plan,'need-wet-overall'),
                                 material_relations.active_inputs(self.store,plan,'need-wet-overall',metadata=True))
        invalid={'inputs':[{**item,'reference':self.ref('songbook')}]}
        for metadata in (False,True):
            with self.assertRaises(ValueError):material_relations.active_inputs(self.store,invalid,'need-wet-overall',metadata=metadata)
        revised=copy.deepcopy(rel);revised['expected_version']=1;revised['payload']['summary']='later';self.put(revised)
        from review_desk.business_relations import exact_input_relation
        self.assertEqual(exact_input_relation(self.store,'need-wet-overall',item,metadata=True)['payload']['summary'],rel['payload']['summary'])

    def test_list_bindings_do_not_expand_full_generation_or_submission_records(self):
        self.setup_plans();rel=self.relation(['songbook','need-full-overall']);rel['payload']['contexts']=[self.source];self.put(rel)
        from review_desk.business_relations import material_bindings
        expected=list(material_bindings(self.store))
        with p.read_scope(self.store),patch('review_desk.production.record',side_effect=AssertionError('full record')):
            self.assertEqual(light.material_bindings(self.store),expected)
            self.assertEqual(light.material_bindings(self.store),expected)


if __name__=='__main__':unittest.main()
