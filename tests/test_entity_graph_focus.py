"""Exact shot contexts, normalization and business preservation in disposable data."""
import unittest
from test_production_scope import ProductionScopeTest
from review_desk import production as p
from review_desk.production_scope import entity_focus, projection
from review_desk.entity_contract import graph
from review_desk.business_relations import identity

class EntityGraphFocusTest(ProductionScopeTest):
    def test_focus_normalizes_routes_and_keeps_empty_children(self):
        self.split()
        catalog, first=entity_focus(self.store)
        self.assertEqual(first['shot'],'av-shot')
        self.assertEqual(entity_focus(self.store,'av-episode',scene='other-scene')[1]['shot'],'other-shot')
        self.assertEqual(entity_focus(self.store,'missing',scene='other-scene')[1],first)
        self.assertEqual(entity_focus(self.store,'av-episode',scene='av-scene',shot='other-shot')[1],first)
        self.assertEqual(entity_focus(self.store,'av-episode','missing')[1],first)
        sc=p.record(self.store,'other-scene');self.store.put_object('other-scene','AV_SCENE',{**sc['payload'],'shots':[]},expected_version=sc['version'])
        ep=p.record(self.store,'av-episode');self.store.put_object('av-episode','AV_EPISODE',{**ep['payload'],'scenes':[self.ref('other-scene')]},expected_version=ep['version'])
        empty=entity_focus(self.store)[1];self.assertEqual(empty['scene'],'other-scene');self.assertEqual(empty['shot'],'')
        self.store.put_object('av-episode','AV_EPISODE',{**ep['payload'],'scenes':[]},expected_version=ep['version']+1)
        self.assertEqual(entity_focus(self.store)[1]['scene'],'')

    def test_membership_unions_context_and_active_inputs_without_siblings_or_neighbors(self):
        self.split()
        for oid in ['direct','voice','input-owner','sibling','neighbor']:
            self.store.put_object(oid,'ENTITY',{'title':oid,'sources':[]})
        self.store.put_object('background','STATE',{'title':'background','entity':self.ref('voice')})
        shot=p.record(self.store,'av-shot');self.store.put_object('av-shot','AV_SHOT',{**shot['payload'],'entities':[self.ref('direct')],'continuity_context':[self.ref('background')]},expected_version=shot['version'])
        other=p.record(self.store,'other-shot');self.store.put_object('other-shot','AV_SHOT',{**other['payload'],'entities':[self.ref('sibling')]},expected_version=other['version'])
        for scid,shid in [('av-scene','av-shot'),('other-scene','other-shot')]:
            sc=p.record(self.store,scid);self.store.put_object(scid,'AV_SCENE',{**sc['payload'],'shots':[self.ref(shid)]},expected_version=sc['version'])
        ep=p.record(self.store,'av-episode');self.store.put_object('av-episode','AV_EPISODE',{**ep['payload'],'scenes':[self.ref('av-scene'),self.ref('other-scene')]},expected_version=ep['version'])
        upstream=self.need('master');upstream['payload'].update(scope=self.ref('input-owner'),entities=[self.ref('input-owner')]);self.put(upstream)
        self.put(self.need('consumer',[{'reference':self.ref('master'),'use':'准确输入归属'}]))
        real=identity(['direct','voice']);self.store.put_object(real,'RELATION',{'format':'production-relation-v1','title':'真实关系','relation_type':'business','endpoints':['direct','voice'],'direction':'related','summary':'保留真实摘要','sources':[],'contexts':[]})
        self.store.put_object(identity(['direct','neighbor']),'RELATION',{'format':'production-relation-v1','title':'范围外关系','relation_type':'business','endpoints':['direct','neighbor'],'direction':'forward','summary':'不能递归扩张','sources':[],'contexts':[]})
        before=[tuple(row) for row in self.store.db.execute('SELECT id,current_revision FROM objects ORDER BY id')]
        with p.read_scope(self.store):
            focus=entity_focus(self.store)[1];result=projection(self.store,[],focus=focus)
            self.assertEqual(set(result['entity_locations']),{'av-shot','direct','voice','input-owner'})
            rows=[p.record(self.store,oid) for oid in result['entity_locations']]
            edges=graph(self.store,rows)['edges'];self.assertEqual([e['id'] for e in edges],[real]);self.assertFalse(any(e['derived'] for e in edges))
        self.assertEqual([tuple(row) for row in self.store.db.execute('SELECT id,current_revision FROM objects ORDER BY id')],before)
