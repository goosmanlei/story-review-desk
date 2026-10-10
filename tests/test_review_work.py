import unittest
import test_audiovisual as fixtures
from review_desk import production as p
from review_desk.review_work import context


class ReviewWorkTest(unittest.TestCase):
    setUp=fixtures.AudiovisualTest.setUp
    tearDown=fixtures.AudiovisualTest.tearDown
    spec=fixtures.AudiovisualTest.spec
    put=fixtures.AudiovisualTest.put
    ref=fixtures.AudiovisualTest.ref
    setup_story=fixtures.AudiovisualTest.setup_story
    shot=fixtures.AudiovisualTest.shot
    composition=fixtures.AudiovisualTest.composition

    def test_exact_old_scene_keeps_old_shot_without_mutating_or_granting_scope(self):
        self.composition()
        old=self.ref('av-scene')
        old_shot=self.ref('av-shot')
        changed=self.shot()
        changed['expected_version']=1
        changed['payload']['purpose']='new performance'
        self.put(changed)
        scene=p.record(self.store,'av-scene')
        self.store.put_object('av-scene','AV_SCENE',dict(scene['payload'],shots=[self.ref('av-shot')]),expected_version=1)
        before=self.store.db.total_changes
        work=context(self.store,old['object_id'],old['revision_id'])
        self.assertIn(old_shot,work['positions'])
        self.assertNotIn(self.ref('av-shot'),work['positions'])
        self.assertEqual(before,self.store.db.total_changes)
        self.assertNotIn('acceptance_scope',work)

    def test_bad_work_identity_or_scene_fails_instead_of_using_current(self):
        self.composition()
        with self.assertRaises(ValueError):context(self.store,'av-episode',None)
        with self.assertRaises(ValueError):context(self.store,'av-episode',self.ref('av-episode')['revision_id'],'missing')
        with self.assertRaises((ValueError,KeyError)):context(self.store,'av-scene',self.ref('av-shot')['revision_id'])
