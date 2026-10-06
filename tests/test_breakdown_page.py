import copy
import unittest
import test_production_breakdown as fixtures
from review_desk import production as p, production_breakdown as b, ui_projection as u

class BreakdownPageTest(fixtures.BreakdownTest):
    def lock(self):
        ep=p.record(self.store,'episode')
        self.store.put_object('episode','EPISODE',{**ep['payload'],'number':1},expected_version=ep['version'])
        self.source['revision_id']=self.ref('episode')['revision_id']
        self.store.put_object('story','STORY',{'title':'version old','blocks':[]})
        self.put(self.spec('lock','INPUT_LOCK',screenplay=self.ref('story'),episodes=[self.ref('episode')],approval={'actor':'fixture','statement':'test','scope':'one'},specification={}))

    def test_exact_catalog_targets_do_not_follow_reorder_or_parent_head(self):
        self.lock();self.scene_shot();old=self.ref('shot');scene=self.ref('scene')
        sc=p.record(self.store,'scene');self.put({**self.spec('scene','PREPARATION'),'expected_version':1,'payload':{**sc['payload'],'notes':'updated'}})
        shot=p.record(self.store,'shot');self.put({**self.spec('shot','SHOT_DESIGN'),'expected_version':1,'payload':{**shot['payload'],'parent':self.ref('scene'),'number':8}})
        current=b.catalog(self.store,'episode');historical=b.catalog(self.store,object_id='shot',revision_id=old['revision_id'])
        self.assertEqual(current['shots'][0]['payload']['number'],8)
        self.assertEqual(historical['scenes'][0]['id'],scene['revision_id'])
        self.assertEqual(historical['shots'][0]['id'],old['revision_id'])
        self.assertEqual(historical['episodes'][0]['comment_targets'],[scene,old])
        self.assertNotEqual(current['episodes'][0]['comment_targets'],historical['episodes'][0]['comment_targets'])

    def test_full_scene_returns_all_blocks_and_only_discontinuous_exact_highlights(self):
        ep=p.record(self.store,'episode');payload=copy.deepcopy(ep['payload']);payload['blocks']=[{'id':c,'text':'exact '+c} for c in 'abcd'];payload['scenes'][0]['block_ids']=list('abcd')
        self.store.put_object('episode','EPISODE',payload,expected_version=ep['version'])
        source={**self.ref('episode'),'scene_id':'scene','block_ids':['a','d']}
        before='\n'.join(self.store.db.iterdump())
        excerpt=p.source_excerpt(self.store,source);full=p.source_excerpt(self.store,source,full_scene=True)
        self.assertEqual([r['id'] for r in excerpt['blocks']],['a','d'])
        self.assertEqual([r['id'] for r in full['blocks']],list('abcd'))
        self.assertEqual(full['highlight_block_ids'],['a','d'])
        self.assertEqual('\n'.join(self.store.db.iterdump()),before)
        with self.assertRaisesRegex(ValueError,'absent'):p.source_excerpt(self.store,{**source,'block_ids':['missing']},True)
        with self.assertRaisesRegex(ValueError,'exact scene'):p.source_excerpt(self.store,self.ref('episode'),True)

    def test_historical_episode_catalog_retains_scenes_after_their_source_head_moves(self):
        self.lock();self.scene_shot();old=self.ref('shot');scene=p.record(self.store,'scene')
        self.put({**self.spec('other-scene','PREPARATION'),'payload':copy.deepcopy(scene['payload'])})
        old_other=self.ref('other-scene')
        ep=p.record(self.store,'episode');self.store.put_object('episode','EPISODE',{**ep['payload'],'title':'new source'},expected_version=ep['version'])
        other=p.record(self.store,'other-scene');payload=copy.deepcopy(other['payload']);payload['source']={**payload['source'],**self.ref('episode')}
        self.store.put_object('other-scene','PREPARATION',payload,expected_version=other['version'])
        historical=b.catalog(self.store,object_id='shot',revision_id=old['revision_id'])
        self.assertIn(old_other['revision_id'],[r['id'] for r in historical['scenes']])

    def test_classification_keeps_multiple_owners_and_never_guesses_from_title(self):
        self.put(self.entity());self.put(self.requirement());row=p.record(self.store,'dialogue');owner=p.record(self.store,'songbook')
        self.assertEqual(u.material_classification(self.store,row,{},owner)['label'],'音频—道具')
        self.put(self.spec('other','ENTITY',entity_type='character',subtype='test',aliases=[],facts=[],choices=[],unknowns=[],sources=[]))
        result=u.material_classification(self.store,row,{'entity_ids':['songbook','other']},owner)
        self.assertEqual(result['label'],'音频—共有');self.assertEqual(len(result['entity_refs']),2)
        unknown={**row,'payload':{**row['payload'],'scope':None,'title':'角色音频剧情 misleading'}}
        self.scene_shot();self.assertEqual(u.material_classification(self.store,unknown,{},p.record(self.store,'shot'))['label'],'音频—镜头')

if __name__=='__main__':unittest.main()
