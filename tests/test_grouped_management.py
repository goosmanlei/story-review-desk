"""Identity and exact-location contracts used by both management lists."""
from unittest.mock import patch
from test_ui_projection import UiProjectionTest
from review_desk import ui_projection as ui, production as p
from review_desk.list_associations import material_groups, entity_locations


class GroupedManagementTest(UiProjectionTest):
    def test_state_count_and_stale_adoption_follow_current_reader(self):
        self.setup_plans()
        self.assertEqual(self.summary()['entity_state_counts']['songbook'], 2)
        self.decide()
        self.assertEqual(self.summary()['entity_adoption_statuses']['songbook'], 'accepted')
        self.change('songbook', production_description='content changed')
        self.assertEqual(self.summary()['entity_adoption_statuses']['songbook'], 'stale')
        self.assertEqual(self.summary()['entity_state_counts']['songbook'], 2)

    def test_cross_scene_duplicates_use_group_and_material_identity(self):
        entries=[{'canonical_material_id':'m','locations':[
            {'episode':'e1','scene':'s1','kind':'AV_SHOT'},
            {'episode':'e1','scene':'s1','kind':'AV_SHOT'},
            {'episode':'e1','scene':'s2','kind':'STATE'},
            {'episode':None,'scene':None,'kind':'STATE'}]}]
        with patch('review_desk.list_associations.light.rows',return_value=[{'object_id':'e1','payload':{'number':1}}]):
            groups=material_groups(None,entries)
            self.assertEqual([(g['scene'],g['material_ids']) for g in groups],[('s1',['m']),('s2',['m'])])
            self.assertEqual(len(material_groups(None,entries,scene='s1')),1)
            special=material_groups(None,[{'canonical_material_id':'global','locations':[{'kind':'STORY'}]},
                {'canonical_material_id':'episode','locations':[{'episode':'e1','kind':'EPISODE'}]},
                {'canonical_material_id':'none','locations':[]}])
            self.assertEqual([g['level'] for g in special],['episode','story','unassigned'])

    def test_grouped_api_keeps_material_counts_and_source_evidence(self):
        self.setup_plans();self.generate();self.mount_on_test_shot('need-full-overall')
        result=ui.material_list(self.store,grouped=True)
        self.assertEqual(result['total'],len({i['canonical_material_id'] for i in result['items']}))
        groups=result['groups'];self.assertEqual(result['display_total'],sum(len(g['material_ids']) for g in groups))
        self.assertTrue(all(len(g['material_ids'])==len(set(g['material_ids'])) for g in groups))
        self.assertTrue(any(g['scene']=='scene' and 'need-full-overall' in g['material_ids'] for g in groups))
        rows=p.current_records(self.store);locs=entity_locations(self.store,[p.record(self.store,'songbook')],rows)['songbook']
        self.assertTrue(any(l.get('scene')=='scene' and l['evidence']['kind']=='audiovisual_use' for l in locs))
        self.assertTrue(all('evidence' in l for l in locs))

    def test_explicit_owner_preserves_target_and_rejects_unrelated_object(self):
        self.setup_plans();self.generate()
        exact=self.ref('need-full-overall')
        result=ui.card(self.store,exact['object_id'],exact['revision_id'],entity_id='songbook')
        self.assertEqual(result['entity_review']['entity']['object_id'],'songbook')
        self.assertEqual(result['detail']['record']['id'],exact['revision_id'])
        self.put(self.entity('other'))
        with self.assertRaisesRegex(ValueError,'不属于'):
            ui.card(self.store,'other',entity_id='songbook')

    def test_numbered_management_episodes_do_not_depend_on_active_input_lock(self):
        ep=p.record(self.store,'episode')
        self.store.put_object('episode','EPISODE',{**ep['payload'],'number':1},expected_version=ep['version'])
        self.setup_plans()
        self.assertEqual(ui.material_list(self.store,grouped=True)['management_episodes'],[{'object_id':'episode','number':1}])
        self.assertEqual(self.summary()['management_episodes'],[{'object_id':'episode','number':1}])

    def test_compact_list_preserves_membership_filters_groups_and_card_information(self):
        self.setup_plans();self.generate();self.mount_on_test_shot('need-full-overall')
        for filters in ({},{'media':'audio'},{'status':'generated'},{'episode':'episode','scene':'scene'},
                        {'media':'audio','status':'ungenerated','search':'overall'},{'search':'absent'}):
            with self.subTest(filters=filters),p.read_scope(self.store):
                full=ui.material_list(self.store,grouped=True,**filters)
                compact=ui.material_list(self.store,grouped=True,compact=True,**filters)
                self.assertEqual({k:v for k,v in full.items() if k!='items'},
                                 {k:v for k,v in compact.items() if k!='items'})
                self.assertEqual(len(full['items']),len(compact['items']))
                for before,after in zip(full['items'],compact['items']):
                    self.assertEqual({k:v for k,v in before.items() if k not in ('locations','entity_ids','material_identity')},
                                     {k:v for k,v in after.items() if k!='locations'})
        before=ui.material_list(self.store,grouped=True,compact=True)
        self.generate('new-call','new-result')
        after=ui.material_list(self.store,grouped=True,compact=True)
        self.assertGreater(next(i for i in after['items'] if i['object_id']=='need-full-overall')['candidate_count'],
                           next(i for i in before['items'] if i['object_id']=='need-full-overall')['candidate_count'])
