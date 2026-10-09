"""Synthetic edition boundaries; no story history or media calls."""
import copy
from test_audiovisual import AudiovisualTest
from review_desk import audiovisual as av, production as p, ui_projection as ui


class EditionContextTest(AudiovisualTest):
    def test_explicit_edition_wins_over_reused_child_and_scene_heads(self):
        self.composition()
        old=self.ref('av-episode');scene=self.ref('av-scene');shot=self.ref('av-shot')
        ep=p.record(self.store,'av-episode')
        self.put({'object_id':'av-episode','kind':'AV_EPISODE','expected_version':1,'payload':{**ep['payload'],'rhythm':'第二版复用原场镜'}})
        current=self.ref('av-episode')
        for edition in [old,current]:
            data=av.catalog(self.store,'av-episode','av-shot',shot['revision_id'],episode_revision=edition['revision_id'])
            self.assertEqual(av.ref(data['design']),edition)
            body=ui.scene(self.store,'av-scene',scene['revision_id'],view='breakdown',episode='av-episode',episode_revision=edition['revision_id'])
            self.assertEqual(body['shots'][0]['context']['ancestors'][:3],[shot,scene,edition])
            self.assertEqual(next(c for c in body['shared'] if c['record']['kind']=='AV_EPISODE')['record']['id'],edition['revision_id'])
        latest=p.record(self.store,'av-shot');self.put({'object_id':'av-shot','kind':'AV_SHOT','expected_version':1,'payload':{**latest['payload'],'framing':'尚未编入的镜头'}})
        with self.assertRaisesRegex(ValueError,'未编入'):
            av.catalog(self.store,'av-episode','av-shot',self.ref('av-shot')['revision_id'],episode_revision=old['revision_id'])
        with self.assertRaises(KeyError):av.catalog(self.store,'av-episode',episode_revision='missing')
        with self.assertRaises(ValueError):av.catalog(self.store,episode_revision=old['revision_id'])

    def test_moved_shot_uses_target_parent_and_old_scene_is_rejected(self):
        self.composition();old_ep=self.ref('av-episode');old_scene=self.ref('av-scene');shot=self.ref('av-shot')
        scene=p.record(self.store,'av-scene')
        self.put(self.spec('new-scene','AV_SCENE',**{k:v for k,v in copy.deepcopy(scene['payload']).items() if k not in ['title','blocks']}, spatial='新父场独立空间'))
        ep=p.record(self.store,'av-episode');self.put({'object_id':'av-episode','kind':'AV_EPISODE','expected_version':1,'payload':{**ep['payload'],'scenes':[self.ref('new-scene')]}})
        current=self.ref('av-episode')
        data=av.catalog(self.store,'av-episode',episode_revision=current['revision_id'])
        self.assertEqual([av.ref(r) for r in data['scenes']],[self.ref('new-scene')])
        body=ui.scene(self.store,'new-scene',self.ref('new-scene')['revision_id'],view='breakdown',episode='av-episode',episode_revision=current['revision_id'])
        self.assertEqual(body['scene']['payload']['spatial'],'新父场独立空间')
        self.assertEqual(body['shots'][0]['context']['ancestors'][:3],[shot,self.ref('new-scene'),current])
        with self.assertRaisesRegex(ValueError,'不属于'):
            ui.scene(self.store,'av-scene',old_scene['revision_id'],episode='av-episode',episode_revision=current['revision_id'])
        self.assertEqual(av.catalog(self.store,'av-episode',episode_revision=old_ep['revision_id'])['scenes'][0]['id'],old_scene['revision_id'])
