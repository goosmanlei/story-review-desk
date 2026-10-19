"""Precise review identities, immutable evidence, and adversarial anchors."""
import copy
import io
import json
import unittest
from test_editing import EditingTest
from review_desk import editing as edit, editing_review as review
from review_desk.store import canonical, Conflict
from review_desk.production_media import ingest

class TimelineReviewTest(unittest.TestCase):
    setUpClass=classmethod(EditingTest.setUpClass.__func__)
    tearDownClass=classmethod(EditingTest.tearDownClass.__func__)
    tearDown=EditingTest.tearDown
    def setUp(self):
        EditingTest.setUp(self)
        shot=self.store._insert_object('shot','AV_SHOT',{'title':'镜头','format':'production-av-shot-v1'})
        self.origin={'object_id':'shot','revision_id':shot,'kind':'AV_SHOT'}
        asset=self.project['sources'][0]['asset'];row=json.loads(self.store.db.execute('select payload from revisions where id=?',(asset['revision_id'],)).fetchone()[0])
        row['scope']={k:v for k,v in self.origin.items() if k!='kind'};row['subjects']=[row['scope']]
        with self.store.db:self.store.db.execute('update revisions set payload=? where id=?',(canonical(row),asset['revision_id']))
        self.project['subtitles']=[];self.project['titles']=[]
        clean=copy.deepcopy(self.project['sources'][0]['component']);clean['id']='clean'
        self.payload={'format':'episode-film-v1','title':'测试成片','project':self.project,'snapshot':{'object_id':'snap','revision_id':'snap-rid'},'components':[clean]}
        rid=self.store._insert_object('film','EPISODE_FILM',self.payload)
        self.output=edit.read(self.store,'film',rid)
        self.projection=review.review(self.store,'film',rid)
    def anchor(self):
        elements=review.selection_elements(self.projection['elements'],['track:picture'],4,40)
        return {'type':'time','component_id':'clean','asset_file':self.payload['components'][0]['file'],'start_seconds':4/24,'end_seconds':40/24,
         'edit_selection':{'snapshot':self.payload['snapshot'],'association':None,'start_frame':4,'end_frame':40,'tracks':['track:picture'],'track_titles':['画面'],'elements':elements}}
    def validate(self,a):return review.validate_anchor(self.store,'film',self.output['id'],self.payload,a)
    def test_legal_unnamed_tracks_and_half_open_ranges(self):
        p=copy.deepcopy(self.project);p['tracks'][0].pop('title');self.assertEqual(review.elements(p)[0][0]['title'],'picture')
        self.validate(self.anchor())
        self.assertEqual(review.selection_elements(self.projection['elements'],['track:picture'],48,49),[])
    def test_rejects_forged_tracks_elements_sources_snapshot_and_noninteger_frames(self):
        for mutate in [lambda a:a['edit_selection'].update(tracks=['track:nope']),lambda a:a['edit_selection'].update(elements=[]),
          lambda a:a['edit_selection']['elements'][0]['binding'].update(candidate_id='other'),lambda a:a['edit_selection'].update(snapshot={}),
          lambda a:a['edit_selection'].update(start_frame=4.1),lambda a:a.update(start_seconds=.5),
          lambda a:a['edit_selection'].update(end_frame=4),lambda a:a['edit_selection'].update(track_titles=['误轨'])]:
            a=copy.deepcopy(self.anchor());mutate(a)
            with self.assertRaises((ValueError,Conflict)):self.validate(a)
        self.assertEqual(self.store.comments(),[])
    def association(self,n=1,previous=None):
        p={'format':review.FORMAT,'title':'关联','output':review.ref(self.output),'version':n,'previous':previous,'elements':self.projection['elements']}
        p['digest']=review.checksum(p);return p
    def test_old_anchor_keeps_its_basis_after_new_association(self):
        old=self.anchor();p=self.association();a=review.append_association(self.store,p)
        self.validate(old)
        with self.assertRaises(Conflict):review.validate_new_anchor(self.store,'film',self.output['id'],old)
        chosen=copy.deepcopy(old);chosen['edit_selection']['association']={**review.ref(a),'version':1,'digest':p['digest']};self.validate(chosen)
        next=self.association(2,review.ref(a));review.append_association(self.store,next)
        self.validate(chosen)
        with self.assertRaises(Conflict):review.validate_new_anchor(self.store,'film',self.output['id'],chosen)
        review.validate_chains(self.store)
        # Current ownership may move; the immutable old comment must survive.
        from unittest.mock import patch
        with patch.object(review,'material_origin',return_value=({'object_id':'moved','revision_id':'moved-rid','kind':'AV_SHOT'},'moved-material')):
            self.validate(old)
            with self.assertRaises(Conflict):review.verify_binding(self.store,old['edit_selection']['elements'][0]['binding'],live=True)
    def test_forged_kind_and_fork_rejected(self):
        p=self.association();a=review.append_association(self.store,p)
        bad=copy.deepcopy(p['elements'][0]['binding']);bad['origin']['kind']='ENTITY'
        with self.assertRaises(Conflict):review.verify_binding(self.store,bad)
        next=self.association(2,review.ref(a));review.append_association(self.store,next)
        fork=copy.deepcopy(next);fork['title']='分叉';fork.pop('digest');fork['digest']=review.checksum(fork)
        with self.assertRaises(Conflict):review.append_association(self.store,fork)
        self.store._insert_object('edit-association-'+fork['digest'],review.KIND,fork)
        with self.assertRaises(Conflict):review.validate_chains(self.store)

    def test_output_key_order_does_not_hide_a_second_chain_root(self):
        p=self.association();review.append_association(self.store,p)
        fork=copy.deepcopy(p);fork['output']=dict(reversed(list(p['output'].items())));fork['title']='second root';fork.pop('digest');fork['digest']=review.checksum(fork)
        self.store._insert_object('edit-association-'+fork['digest'],review.KIND,fork)
        with self.assertRaises(Conflict):review.validate_chains(self.store)

if __name__=='__main__':unittest.main()
